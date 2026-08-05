import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Nginx } from '../js/index.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const f = (n) => readFileSync(join(FIX, n), 'utf8');
const fb = (n) => readFileSync(join(FIX, n));

const CHAIN = f('leaf-chain.pem');
const LEAF_KEY = f('leaf-key.pem');
const CA = f('ca.pem');

test('ssl_stapling_file staples an OCSP response into the handshake', async () => {
  const nginx = await Nginx.create(
    `
    server {
      listen 443 ssl;
      server_name s.test;
      ssl_certificate /c/chain.pem;
      ssl_certificate_key /c/key.pem;
      ssl_stapling on;
      ssl_stapling_file /c/resp.der;
      location / { return 200 "stapled"; }
    }
  `,
    { files: { '/c/chain.pem': CHAIN, '/c/key.pem': LEAF_KEY, '/c/resp.der': new Uint8Array(fb('resp.der')) } }
  );

  const server = await nginx.serve({ port: 8602, nginxPort: 443 });

  const r = await new Promise((resolve, reject) => {
    const s = tlsConnect(
      { host: '127.0.0.1', port: 8602, servername: 's.test', ca: [CA], requestOCSP: true },
      () => s.write('GET / HTTP/1.1\r\nHost: s.test\r\nConnection: close\r\n\r\n')
    );
    let ocsp = null, body = '';
    s.on('OCSPResponse', (d) => (ocsp = d));
    s.on('data', (d) => (body += d));
    s.on('end', () => resolve({ ocsp, authorized: s.authorized, body: body.split('\r\n').pop() }));
    s.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 8000);
  });

  assert.ok(r.ocsp && r.ocsp.length > 0, 'client should receive a stapled OCSP response');
  assert.equal(r.authorized, true, 'chain should verify against the CA');
  assert.equal(r.body, 'stapled');
  nginx.dispose();
});

test('live OCSP stapling: host resolution + OCSP fetch (TCP) + staple', async () => {
  const OCSP_PORT = 8888;

  const dir = mkdtempSync(join(tmpdir(), 'ngxw-ocsp-'));
  writeFileSync(join(dir, 'ca.pem'), CA);
  writeFileSync(join(dir, 'ca-key.pem'), f('ca-key.pem'));
  writeFileSync(join(dir, 'index.txt'), f('index.txt'));

  const responder = spawn('openssl', [
    'ocsp', '-port', String(OCSP_PORT), '-index', join(dir, 'index.txt'),
    '-CA', join(dir, 'ca.pem'), '-rsigner', join(dir, 'ca.pem'), '-rkey', join(dir, 'ca-key.pem'),
    '-nrequest', '10',
  ], { stdio: 'ignore' });
  responder.unref();
  await new Promise((r) => setTimeout(r, 400));

  const nginx = await Nginx.create(
    `
    server {
      listen 443 ssl;
      server_name s.test;
      ssl_certificate /c/chain.pem;
      ssl_certificate_key /c/key.pem;
      ssl_stapling on;
      ssl_stapling_verify off;
      location / { return 200 "live-stapled"; }
    }
  `,
    {
      files: { '/c/chain.pem': CHAIN, '/c/key.pem': LEAF_KEY },
      hosts: { 'ocsp.test': '127.0.0.1' },
      logLevel: 'info',
    }
  );

  const server = await nginx.serve({ port: 8604, nginxPort: 443 });

  let ocsp = null;
  for (let attempt = 0; attempt < 10 && !ocsp; attempt++) {
    ocsp = await new Promise((resolve) => {
      const s = tlsConnect(
        { host: '127.0.0.1', port: 8604, servername: 's.test', ca: [CA], requestOCSP: true },
        () => s.write('GET / HTTP/1.1\r\nHost: s.test\r\nConnection: close\r\n\r\n')
      );
      let got = null;
      s.on('OCSPResponse', (d) => (got = d));
      s.on('end', () => resolve(got));
      s.on('error', () => resolve(null));
      setTimeout(() => { s.destroy(); resolve(got); }, 1500);
    });
    if (!ocsp) await new Promise((r) => setTimeout(r, 400));
  }

  server.close();
  nginx.dispose();
  try { responder.kill('SIGKILL'); } catch {}
  rmSync(dir, { recursive: true, force: true });

  assert.ok(
    ocsp && ocsp.length > 0,
    'nginx should have resolved the responder, fetched OCSP over TCP, and stapled it'
  );
});
