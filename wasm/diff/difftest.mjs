import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { gunzipSync } from 'node:zlib';

import { Nginx } from '../js/index.js';
import { cases } from './corpus.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NATIVE = join(REPO, 'objs-native', 'nginx');

const SKIP_HEADERS = new Set(['date', 'connection', 'keep-alive', 'transfer-encoding', 'content-length']);

if (!existsSync(NATIVE)) {
  console.log('native nginx not built yet — running wasm/diff/build-native.sh…');
  execFileSync(join(REPO, 'wasm', 'diff', 'build-native.sh'), { stdio: 'inherit' });
}

const filter = process.argv[2] || '';
const PORT = 18080 + (process.pid % 1000);

let pass = 0;
let fail = 0;
const failures = [];

for (const c of cases.filter((c) => c.name.includes(filter))) {
  const root = mkdtempSync(join(tmpdir(), 'ngxdiff-'));
  for (const [rel, content] of Object.entries(c.files || {})) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }

  const [wasmSide, nativeSide] = await Promise.all([
    runWasm(c, root),
    runNative(c, root),
  ]);

  for (let i = 0; i < c.requests.length; i++) {
    const req = reqSpec(c.requests[i]);
    const a = wasmSide[i];
    const b = nativeSide[i];
    const diffs = compare(a, b);
    const label = `${c.name} :: ${req.method} ${req.path}`;
    if (diffs.length === 0) {
      pass++;
      console.log(`  ok   ${label}`);
    } else {
      fail++;
      failures.push({ label, diffs, wasm: a, native: b });
      console.log(`  DIFF ${label}`);
      for (const d of diffs) console.log(`       ${d}`);
    }
  }

  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} matched, ${fail} diverged (nginx ${Nginx.versions.nginx}, native vs wasm)`);
process.exit(fail ? 1 : 0);

function reqSpec(r) {
  if (typeof r === 'string') {
    const [method, path] = r.split(' ');
    return { method, path, headers: {} };
  }
  return { headers: {}, ...r };
}

function normalizeLocation(value) {
  return value ? value.replace(/^https?:\/\/t(:\d+)?/, '') : value;
}

function snapshot(status, headers, bodyBuf) {
  const h = {};
  for (const [k, v] of headers) {
    const key = k.toLowerCase();
    if (SKIP_HEADERS.has(key)) continue;
    const val = key === 'location' ? normalizeLocation(v) : v;

    h[key] = key in h ? `${h[key]}, ${val}` : val;
  }
  let body = bodyBuf;
  if (h['content-encoding'] === 'gzip') {

    try {
      body = gunzipSync(bodyBuf);
    } catch {}
  }
  return { status, headers: h, body: Buffer.from(body).toString('base64') };
}

function compare(a, b) {
  const diffs = [];
  if (a.status !== b.status) diffs.push(`status: wasm=${a.status} native=${b.status}`);
  const keys = new Set([...Object.keys(a.headers), ...Object.keys(b.headers)]);
  for (const k of keys) {
    if ((a.headers[k] ?? null) !== (b.headers[k] ?? null)) {
      diffs.push(`header ${k}: wasm=${JSON.stringify(a.headers[k])} native=${JSON.stringify(b.headers[k])}`);
    }
  }
  if (a.body !== b.body) {
    const av = Buffer.from(a.body, 'base64').toString().slice(0, 80);
    const bv = Buffer.from(b.body, 'base64').toString().slice(0, 80);
    diffs.push(`body: wasm=${JSON.stringify(av)} native=${JSON.stringify(bv)}`);
  }
  return diffs;
}

async function runWasm(c, root) {
  const conf = c.conf(root).replaceAll('{{LISTEN}}', '80');
  const nginx = await Nginx.create(conf, { mounts: { [root]: root } });
  const out = [];
  for (const r of c.requests) {
    const req = reqSpec(r);
    const res = await nginx.handle(
      new Request(`http://t${req.path}`, { method: req.method, headers: req.headers }),
      { buffer: true, timeout: 10000 }
    );
    const body = Buffer.from(await res.arrayBuffer());
    out.push(snapshot(res.status, res.headers, body));
  }
  nginx.dispose();
  return out;
}

async function runNative(c, root) {
  const prefix = mkdtempSync(join(tmpdir(), 'ngxnat-'));
  mkdirSync(join(prefix, 'logs'));

  writeFileSync(join(prefix, 'mime.types'), readFileSync(join(REPO, 'conf', 'mime.types')));
  const conf = [
    'daemon off;',
    'master_process off;',
    `error_log ${join(prefix, 'logs', 'error.log')} warn;`,
    `pid ${join(prefix, 'logs', 'nginx.pid')};`,
    'events { worker_connections 64; }',
    'http {',
    '  access_log off;',
    `  client_body_temp_path ${prefix}/cbt;`,
    `  proxy_temp_path ${prefix}/pt;`,
    `  include ${join(prefix, 'mime.types')};`,
    '  default_type application/octet-stream;',
    c.conf(root).replaceAll('{{LISTEN}}', `127.0.0.1:${PORT}`),
    '}',
  ].join('\n');
  writeFileSync(join(prefix, 'nginx.conf'), conf);

  const proc = spawn(NATIVE, ['-p', prefix + '/', '-c', join(prefix, 'nginx.conf')], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));

  await waitForPort(PORT, proc);

  const out = [];
  try {
    for (const r of c.requests) {
      const req = reqSpec(r);
      out.push(await nativeRequest(req));
    }
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => proc.once('exit', r));
    rmSync(prefix, { recursive: true, force: true });
  }
  if (out.length !== c.requests.length && stderr) console.error(stderr);
  return out;
}

function nativeRequest(req) {
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      {
        host: '127.0.0.1',
        port: PORT,
        method: req.method,
        path: req.path,
        headers: { Host: 't', Connection: 'close', ...req.headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const headers = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            headers.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
          }
          resolve(snapshot(res.statusCode, headers, Buffer.concat(chunks)));
        });
      }
    );
    r.on('error', reject);
    r.end();
  });
}

async function waitForPort(port, proc) {
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error('native nginx exited during startup');
    const up = await new Promise((resolve) => {
      const r = httpRequest({ host: '127.0.0.1', port, method: 'HEAD', path: '/__probe' }, () => resolve(true));
      r.on('error', () => resolve(false));
      r.end();
    });
    if (up) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('native nginx never came up');
}
