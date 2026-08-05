import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configTest } from '../js/testing.js';

const CONF = `
  upstream backend { server 10.0.0.5:8080; }
  server {
    listen 80;
    server_name api.example.com;
    root /var/www/html;
    location / { }
    location /v1/ { proxy_pass http://backend; }
    location /admin { return 403; }
    location = /moved { return 301 https://example.com/new; }
    location /old/ { rewrite ^/old/(.*)$ /v1/$1 last; }
  }
`;

test('configTest sugar', async (t) => {
  const ct = await configTest(CONF, { files: { '/var/www/html/a.png': 'x' } });

  await t.test('toProxyTo by upstream name and by address', async () => {
    await ct.expect('GET http://api.example.com/v1/users').toProxyTo('backend');
    await ct.expect('GET http://api.example.com/v1/users').toProxyTo('10.0.0.5:8080');
  });

  await t.test('toReturn', async () => {
    await ct.expect('GET http://api.example.com/admin').toReturn(403);
  });

  await t.test('toRedirectTo', async () => {
    await ct.expect('GET http://api.example.com/moved').toRedirectTo('https://example.com/new');
  });

  await t.test('toServeFile', async () => {
    await ct.expect('GET http://api.example.com/a.png').toServeFile('/var/www/html/a.png');
  });

  await t.test('toMatchLocation + toRewriteTo', async () => {
    await ct.expect('GET http://api.example.com/old/users').toMatchLocation('/v1/');
    await ct.expect('GET http://api.example.com/old/users').toRewriteTo('/v1/users');
  });

  await t.test('failures throw with the nginx trace attached', async () => {
    await assert.rejects(
      () => ct.expect('GET http://api.example.com/admin').toReturn(200),
      (e) => e.message.includes('expected status 200, got 403') && Array.isArray(e.route.trace)
    );
  });

  ct.dispose();
});
