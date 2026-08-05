import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../js/compose.js';

const buf = { buffer: true, timeout: 8000 };

test('method merge: every verb, unknown → 405 with Allow', async () => {
  const app = compose();
  const srv = app.server();
  srv.listen(80).serverName('t');
  const verbs = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
  for (const v of verbs) srv[v.toLowerCase()]('/r', (req) => new Response('m:' + req.method));
  const nginx = await app.build();

  for (const v of verbs) {
    const r = await nginx.handle(new Request('http://t/r', { method: v, body: v === 'GET' ? undefined : 'b' }), buf);
    assert.equal(await r.text(), 'm:' + v);
  }
  const opt = await nginx.handle(new Request('http://t/r', { method: 'OPTIONS' }), buf);
  assert.equal(opt.status, 405);
  const allow = opt.headers.get('allow') || '';
  for (const v of verbs) assert.match(allow, new RegExp(v));
  nginx.dispose();
});

test('params: position, count, url-encoded, dashes/dots', async (t) => {
  const app = compose();
  const srv = app.server();
  srv.listen(80).serverName('t');
  srv.get('/a/:x', (req, ctx) => Response.json(ctx.params));
  srv.get('/a/:x/b/:y/c/:z', (req, ctx) => Response.json(ctx.params));
  srv.get('/file/:name', (req, ctx) => Response.json(ctx.params));
  const nginx = await app.build();

  assert.deepEqual(await (await nginx.handle(new Request('http://t/a/one'), buf)).json(), { x: 'one' });
  assert.deepEqual(await (await nginx.handle(new Request('http://t/a/1/b/2/c/3'), buf)).json(), { x: '1', y: '2', z: '3' });
  assert.deepEqual(await (await nginx.handle(new Request('http://t/file/my.report-v2'), buf)).json(), { name: 'my.report-v2' });

  const enc = await (await nginx.handle(new Request('http://t/a/hello%20world'), buf)).json();
  assert.equal(enc.x, 'hello world');
  nginx.dispose();
});

test('param names may shadow nginx built-ins (namespaced)', async () => {
  const app = compose();
  app.server().listen(80).serverName('t')
    .get('/x/:host/:uri/:pid', (req, ctx) => Response.json(ctx.params));
  const nginx = await app.build();
  assert.deepEqual(
    await (await nginx.handle(new Request('http://t/x/example.com/path/12345'), buf)).json(),
    { host: 'example.com', uri: 'path', pid: '12345' }
  );
  nginx.dispose();
});

test('params + method merge on the same route', async () => {
  const app = compose();
  const store = new Map();
  const srv = app.server();
  srv.listen(80).serverName('t');
  srv.get('/kv/:key', (req, ctx) => Response.json({ value: store.get(ctx.params.key) ?? null }));
  srv.put('/kv/:key', async (req, ctx) => { store.set(ctx.params.key, await req.text()); return new Response(null, { status: 204 }); });
  srv.delete('/kv/:key', (req, ctx) => { store.delete(ctx.params.key); return new Response(null, { status: 204 }); });
  const nginx = await app.build();

  assert.equal((await nginx.handle(new Request('http://t/kv/a', { method: 'PUT', body: 'v1' }), buf)).status, 204);
  assert.deepEqual(await (await nginx.handle(new Request('http://t/kv/a'), buf)).json(), { value: 'v1' });
  assert.equal((await nginx.handle(new Request('http://t/kv/a', { method: 'DELETE' }), buf)).status, 204);
  assert.deepEqual(await (await nginx.handle(new Request('http://t/kv/a'), buf)).json(), { value: null });
  nginx.dispose();
});

test('param routes are regex — no match falls through', async () => {
  const app = compose();
  const srv = app.server();
  srv.listen(80).serverName('t');
  srv.get('/item/:id', (req, ctx) => new Response('item ' + ctx.params.id));
  srv.location('/').return(404, 'no route');
  const nginx = await app.build();

  assert.equal(await (await nginx.handle(new Request('http://t/item/5'), buf)).text(), 'item 5');
  const miss = await nginx.handle(new Request('http://t/item/5/extra'), buf);
  assert.equal(await miss.text(), 'no route');
  nginx.dispose();
});

test('concurrent requests across many param routes', async () => {
  const app = compose();
  const srv = app.server();
  srv.listen(80).serverName('t');
  srv.get('/u/:id', async (req, ctx) => {
    await new Promise((r) => setTimeout(r, (Number(ctx.params.id) % 4) + 1));
    return Response.json({ id: Number(ctx.params.id) });
  });
  const nginx = await app.build();
  const N = 40;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => nginx.handle(new Request(`http://t/u/${i}`), buf).then((r) => r.json()))
  );
  assert.deepEqual(results.map((r) => r.id).sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i));
  nginx.dispose();
});

test('many routes in one server', async () => {
  const app = compose();
  const srv = app.server();
  srv.listen(80).serverName('t');
  for (let i = 0; i < 50; i++) srv.get(`/r${i}`, () => new Response('r' + i));
  const nginx = await app.build();
  for (let i = 0; i < 50; i++) {
    assert.equal(await (await nginx.handle(new Request(`http://t/r${i}`), buf)).text(), 'r' + i);
  }
  nginx.dispose();
});

test('upstream load-balancing methods render + proxy via fixture', async () => {
  const app = compose();
  app.upstream('lc').method('least_conn').server('10.0.0.1:80').server('10.0.0.2:80', { weight: 3, backup: true });
  app.upstream('ih').method('ip_hash').server('10.0.1.1:80');
  const srv = app.server();
  srv.listen(80).serverName('t');
  srv.location('/lc/').proxyPass('http://lc');
  srv.location('/ih/').proxyPass('http://ih');

  const conf = app.toConf();
  assert.match(conf, /upstream lc \{\n\s*least_conn;/);
  assert.match(conf, /server 10\.0\.0\.2:80 weight=3 backup;/);
  assert.match(conf, /upstream ih \{\n\s*ip_hash;/);

  const seen = [];
  const nginx = await app.build({ upstream: async (req, target) => { seen.push(target.addr); return new Response('ok'); } });
  assert.equal(await (await nginx.handle(new Request('http://t/lc/x'), buf)).text(), 'ok');
  assert.equal(await (await nginx.handle(new Request('http://t/ih/y'), buf)).text(), 'ok');
  assert.ok(seen.length === 2);
  nginx.dispose();
});

test('map: default, exact, regex; used by a handler', async () => {
  const app = compose();
  app.map('$http_x_tier', { default: 'free', pro: 'professional', '~^ent': 'enterprise' }, '$tier');
  app.server().listen(80).serverName('t').location('/t').handle((req, ctx) => new Response(ctx.vars('tier')));
  const nginx = await app.build();
  const tier = (v) => nginx.handle(new Request('http://t/t', { headers: v ? { 'x-tier': v } : {} }), buf).then((r) => r.text());
  assert.equal(await tier(), 'free');
  assert.equal(await tier('pro'), 'professional');
  assert.equal(await tier('enterprise-plan'), 'enterprise');
  assert.equal(await tier('unknown'), 'free');
  nginx.dispose();
});

test('directives compose without breaking handlers', async () => {
  const app = compose();
  const srv = app.server();
  srv.listen(80).serverName('t').errorPage(404, '/e404').addHeader('X-Server', 'nginx-wasm');
  srv.location('= /e404').return(404, 'not found here');
  srv.location('/cached').expires('10m').addHeader('X-Cache', 'HIT', true).handle(() => new Response('data'));
  srv.location('/plain').handle(() => new Response('p'));
  const nginx = await app.build();

  const c = await nginx.handle(new Request('http://t/cached'), buf);
  assert.equal(await c.text(), 'data');
  assert.equal(c.headers.get('x-cache'), 'HIT');
  assert.match(c.headers.get('cache-control') || '', /max-age=600/);

  assert.equal(c.headers.get('x-server'), null);

  const p = await nginx.handle(new Request('http://t/plain'), buf);
  assert.equal(p.headers.get('x-server'), 'nginx-wasm');

  const nf = await nginx.handle(new Request('http://t/whatever'), buf);
  assert.equal(nf.status, 404);
  assert.equal(await nf.text(), 'not found here');
  nginx.dispose();
});
