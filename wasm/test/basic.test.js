import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Nginx } from '../js/index.js';

const CONF = `
  upstream backend { server 127.0.0.1:1; }

  server {
    listen 80;
    server_name api.example.com;
    root /var/www/html;

    gzip on;
    gzip_min_length 10;

    location / { }
    location /v1/ { proxy_pass http://backend; }
    location /secret/ { deny all; }
    location = /health { return 200 "ok\\n"; }
    location ~* \\.php$ { return 403; }
    location /old/ { rewrite ^/old/(.*)$ /v1/$1 last; }
    location = /moved { return 301 https://example.com/moved; }
  }
`;

const FILES = { '/var/www/html/index.html': '<h1>hi</h1>\n' };

test('basic engine behavior', async (t) => {
  const nginx = await Nginx.create(CONF, { files: FILES });

  await t.test('serves a static file with headers', async () => {
    const res = await nginx.handle(new Request('http://api.example.com/index.html'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html');
    assert.match(res.headers.get('server'), /^nginx\//);
    assert.equal(await res.text(), '<h1>hi</h1>\n');
  });

  await t.test('deny all → 403', async () => {
    const res = await nginx.handle(new Request('http://api.example.com/secret/keys'));
    assert.equal(res.status, 403);
  });

  await t.test('return with body (rewrite module)', async () => {
    const res = await nginx.handle(new Request('http://api.example.com/health'));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok\n');
  });

  await t.test('regex location, case-insensitive (PCRE2)', async () => {
    const res = await nginx.handle(new Request('http://api.example.com/x/Index.PHP'));
    assert.equal(res.status, 403);
  });

  await t.test('301 with Location header', async () => {
    const res = await nginx.handle(new Request('http://api.example.com/moved'));
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), 'https://example.com/moved');
  });

  await t.test('missing file → 404 with nginx error page', async () => {
    const res = await nginx.handle(new Request('http://api.example.com/nope'));
    assert.equal(res.status, 404);
    assert.match(await res.text(), /404 Not Found/);
  });

  await t.test('gzip filter (zlib)', async () => {
    const res = await nginx.handle(
      new Request('http://api.example.com/index.html', { headers: { 'accept-encoding': 'gzip' } })
    );
    assert.equal(res.headers.get('content-encoding'), 'gzip');
  });

  await t.test('route(): location match + proxy decision', async () => {
    const r = await nginx.route(new Request('http://api.example.com/v1/users?id=3'));
    assert.equal(r.location, '/v1/');
    assert.equal(r.proxied, true);
    assert.equal(r.upstream, '127.0.0.1:1');
  });

  await t.test('route(): rewrite … last re-matches locations', async () => {
    const r = await nginx.route(new Request('http://api.example.com/old/users'));
    assert.equal(r.location, '/v1/');
    assert.deepEqual(r.rewrites, ['/v1/users']);
  });

  await t.test('route(): index internal redirect', async () => {
    const r = await nginx.route(new Request('http://api.example.com/'));
    assert.deepEqual(r.internalRedirects, ['/index.html']);
    assert.equal(r.status, 200);
  });

  await t.test('config introspection', () => {
    assert.deepEqual(nginx.ports, [80]);
    assert.deepEqual(nginx.config.upstreams, { backend: ['127.0.0.1:1'] });
    assert.ok(nginx.config.servers.some((s) => s.name === 'api.example.com'));
  });

  await t.test('versions are recorded', () => {
    assert.match(Nginx.versions.nginx, /^\d+\.\d+\.\d+$/);
    assert.match(Nginx.versions.pcre2, /^\d+\.\d+$/);
  });

  nginx.dispose();

  await t.test('disposed instance refuses work', async () => {
    await assert.rejects(() => nginx.handle(new Request('http://x/')), /disposed/);
  });
});
