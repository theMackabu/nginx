import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Nginx } from '../js/index.js';

test('fetch-shaped upstream fixtures', async (t) => {
  const calls = [];
  const nginx = await Nginx.create(
    `
    upstream backend { server 10.0.0.5:8080; }
    server {
      listen 80;
      location /api/ {
        proxy_pass http://backend;
        proxy_set_header X-Real-IP $remote_addr;
      }
      location /old/ { rewrite ^/old/(.*)$ /api/$1 last; }
    }
  `,
    {
      upstream: async (req, target) => {
        calls.push({
          method: req.method,
          path: new URL(req.url).pathname,
          xRealIp: req.headers.get('x-real-ip'),
          body: req.method === 'POST' ? await req.text() : null,
          target,
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 201,
          headers: { 'content-type': 'application/json', 'x-backend': 'fixture' },
        });
      },
    }
  );

  await t.test('fixture response passes through nginx', async () => {
    const res = await nginx.handle(new Request('http://x/api/users?id=9'));
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('x-backend'), 'fixture');
    assert.deepEqual(await res.json(), { ok: true });
  });

  await t.test('nginx-computed proxy headers reach the fixture', () => {
    assert.equal(calls[0].xRealIp, '127.0.0.1');
    assert.deepEqual(calls[0].target, { host: '10.0.0.5', port: 8080, addr: '10.0.0.5:8080' });
  });

  await t.test('POST body flows through the real proxy path', async () => {
    const res = await nginx.handle(
      new Request('http://x/api/items', { method: 'POST', body: 'hello=world' })
    );
    assert.equal(res.status, 201);
    assert.equal(calls.at(-1).body, 'hello=world');
  });

  await t.test('fixture sees the URI after rewrite', async () => {
    await nginx.handle(new Request('http://x/old/users'));
    assert.equal(calls.at(-1).path, '/api/users');
  });

  await t.test('a throwing fixture becomes a 502', async () => {
    const bad = await Nginx.create(
      'upstream b { server 127.0.0.1:1; } server { listen 80; location / { proxy_pass http://b; } }',
      { upstream: () => { throw new Error('boom'); } }
    );
    const res = await bad.handle(new Request('http://x/'));
    assert.equal(res.status, 502);
    bad.dispose();
  });

  nginx.dispose();
});
