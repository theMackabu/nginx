import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Nginx } from '../js/index.js';

test('Nginx.test(): valid config', async () => {
  const r = await Nginx.test('server { listen 80; return 200; }');
  assert.deepEqual(r, { ok: true });
});

test('Nginx.test(): invalid config reports mapped line number', async () => {
  const r = await Nginx.test('server {\n  listen 80;\n  proxy_pas http://x;\n}');
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown directive "proxy_pas"/);
  assert.equal(r.line, 3);
  assert.equal(r.file, null);
});

test('reload() applies a new config', async () => {
  const nginx = await Nginx.create('server { listen 80; location / { return 200 "v1"; } }');
  assert.equal(await (await nginx.handle(new Request('http://x/'))).text(), 'v1');

  await nginx.reload('server { listen 80; location / { return 200 "v2"; } }');
  assert.equal(await (await nginx.handle(new Request('http://x/'))).text(), 'v2');
  nginx.dispose();
});

test('failed reload() keeps the previous config active', async () => {
  const nginx = await Nginx.create('server { listen 80; location / { return 200 "stable"; } }');

  await assert.rejects(() => nginx.reload('server { listen 80; bogus_directive on; }'), /previous configuration still active/);
  assert.equal(await (await nginx.handle(new Request('http://x/'))).text(), 'stable');
  nginx.dispose();
});

test('unsupported directives are reported', async () => {
  const nginx = await Nginx.create('server {\n  listen 80;\n  sendfile on;\n  return 200;\n}');
  const inert = nginx.unsupported;
  assert.ok(inert.some((d) => d.directive === 'sendfile' && d.line === 3));
  nginx.dispose();
});
