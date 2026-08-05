import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { connect as h2connect } from 'node:http2';
import { Nginx } from '../js/index.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const f = (n) => readFileSync(join(FIX, n), 'utf8');

const CONF = `
  server {
    listen 443 ssl;
    http2 on;
    server_name a.test;
    ssl_certificate /certs/a.pem;
    ssl_certificate_key /certs/a.key;
    location / { return 200 "srv-a over TLS"; }
  }
  server {
    listen 443 ssl;
    server_name b.test;
    ssl_certificate /certs/b.pem;
    ssl_certificate_key /certs/b.key;
    location / { return 200 "srv-b over TLS"; }
  }
`;

const FILES = {
  '/certs/a.pem': f('a-cert.pem'), '/certs/a.key': f('a-key.pem'),
  '/certs/b.pem': f('b-cert.pem'), '/certs/b.key': f('b-key.pem'),
};

test('ssl config passes Nginx.test()', async () => {
  const r = await Nginx.test(CONF, { files: FILES });
  assert.deepEqual(r, { ok: true });
});

test('TLS termination, SNI routing, h2 ALPN over serve()', async (t) => {
  const nginx = await Nginx.create(CONF, { files: FILES });
  const server = await nginx.serve({ port: 8543, nginxPort: 443 });

  const get = (servername) =>
    new Promise((resolve, reject) => {
      const req = httpsRequest(
        { host: '127.0.0.1', port: 8543, path: '/', servername,
          headers: { host: servername }, rejectUnauthorized: false,
          agent: false, ALPNProtocols: ['http/1.1'] },
        (res) => {
          const sock = res.socket;
          const cert = sock.getPeerCertificate().subject?.CN;
          const proto = sock.getProtocol();
          const chunks = [];
          res.on('data', (d) => chunks.push(d));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), cert, proto }));
        }
      );
      req.on('error', reject);
      req.end();
    });

  await t.test('handshake + response for a.test', async () => {
    const r = await get('a.test');
    assert.equal(r.status, 200);
    assert.equal(r.body, 'srv-a over TLS');
    assert.equal(r.cert, 'a.test');
    assert.match(r.proto, /^TLSv1\.[23]$/);
  });

  await t.test('SNI selects the other virtual server AND its cert', async () => {
    const r = await get('b.test');
    assert.equal(r.body, 'srv-b over TLS');
    assert.equal(r.cert, 'b.test');
  });

  await t.test('ALPN negotiates h2 and HTTP/2-over-TLS works', async () => {
    const session = h2connect('https://127.0.0.1:8543', { rejectUnauthorized: false, servername: 'a.test' });
    const r = await new Promise((resolve, reject) => {
      const req = session.request({ ':path': '/', ':authority': 'a.test' });
      let headers;
      const chunks = [];
      req.on('response', (h) => (headers = h));
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => resolve({ headers, body: Buffer.concat(chunks).toString() }));
      req.on('error', reject);
      req.end();
    });
    assert.equal(r.headers[':status'], 200);
    assert.equal(r.body, 'srv-a over TLS');
    await new Promise((r2) => session.close(r2));
  });

  server.close();
  nginx.dispose();
});
