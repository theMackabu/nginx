import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect as h2connect } from 'node:http2';
import { Nginx } from '../js/index.js';

test('HTTP/2 over serve()', async (t) => {
  const nginx = await Nginx.create(
    `
    server {
      listen 80;
      http2 on;
      root /www;
      location = /health { return 200 "h2 ok\\n"; }
    }
  `,
    { files: { '/www/a.txt': 'alpha\n', '/www/b.txt': 'beta\n' } }
  );

  const server = await nginx.serve({ port: 8590 });
  const session = h2connect('http://127.0.0.1:8590');

  const fetch2 = (path) =>
    new Promise((resolve, reject) => {
      const req = session.request({ ':path': path });
      let headers;
      const chunks = [];
      req.on('response', (h) => (headers = h));
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => resolve({ headers, body: Buffer.concat(chunks).toString() }));
      req.on('error', reject);
      req.end();
    });

  await t.test('request over an h2 session', async () => {
    const r = await fetch2('/health');
    assert.equal(r.headers[':status'], 200);
    assert.match(r.headers['server'], /^nginx\//);
    assert.equal(r.body, 'h2 ok\n');
  });

  await t.test('multiplexed streams on one connection', async () => {
    const [a, b, h] = await Promise.all([fetch2('/a.txt'), fetch2('/b.txt'), fetch2('/health')]);
    assert.equal(a.body, 'alpha\n');
    assert.equal(b.body, 'beta\n');
    assert.equal(h.headers[':status'], 200);
  });

  await new Promise((r) => session.close(r));
  server.close();
  nginx.dispose();
});
