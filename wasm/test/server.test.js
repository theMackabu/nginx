import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Nginx } from '../js/index.js';

test('serve(): real TCP, real proxying, keepalive, concurrency', async (t) => {
  const backend = createServer((req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.end('b:' + req.url);
  });
  await new Promise((r) => backend.listen(9394, '127.0.0.1', r));

  const nginx = await Nginx.create(
    `
    upstream b { server 127.0.0.1:9394; keepalive 4; }
    server {
      listen 80;
      root /var/www;
      location = /t { return 200 "t"; }
      location /p/ {
        proxy_pass http://b;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header X-Via nginx-wasm;
      }
    }
  `,
    { files: { '/var/www/static.txt': 'from disk' } }
  );

  const server = await nginx.serve({ port: 8385 });

  await t.test('static file over a real socket', async () => {
    const res = await fetch('http://127.0.0.1:8385/static.txt');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('server'), /^nginx\//);
    assert.equal(await res.text(), 'from disk');
  });

  await t.test('proxies to a real backend', async () => {
    const res = await fetch('http://127.0.0.1:8385/p/users?id=1');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'b:/p/users?id=1');
  });

  await t.test('sequential requests over kept-alive connections', async () => {
    for (let i = 0; i < 25; i++) {
      const r = await fetch(`http://127.0.0.1:8385/${i % 2 ? 't' : 'p/' + i}`);
      const body = await r.text();
      assert.equal(r.status, 200);
      assert.equal(body, i % 2 ? 't' : 'b:/p/' + i);
    }
  });

  await t.test('concurrent requests', async () => {
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        fetch(`http://127.0.0.1:8385/p/c${i}`).then(async (r) => [r.status, await r.text()])
      )
    );
    results.forEach(([status, body], i) => {
      assert.equal(status, 200);
      assert.equal(body, `b:/p/c${i}`);
    });
  });

  server.close();
  backend.close();
  nginx.dispose();
});
