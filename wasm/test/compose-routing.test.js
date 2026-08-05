import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../js/compose.js';

const buf = { buffer: true, timeout: 8000 };

test('method routing: get/post on the same path merge into one location', async () => {
  const app = compose();
  const srv = app.server();
  srv.listen(80).serverName('t');
  srv.get('/items', () => new Response('list'));
  srv.post('/items', async (req) => new Response('created:' + (await req.text())));
  srv.put('/items', () => new Response('replaced'));

  const conf = app.toConf();
  assert.equal((conf.match(/location [^{]*\/items/g) || []).length, 1, 'one location for /items');

  const nginx = await app.build();
  assert.equal(await (await nginx.handle(new Request('http://t/items'), buf)).text(), 'list');
  assert.equal(await (await nginx.handle(new Request('http://t/items', { method: 'POST', body: 'x' }), buf)).text(), 'created:x');
  assert.equal(await (await nginx.handle(new Request('http://t/items', { method: 'PUT' }), buf)).text(), 'replaced');

  const notAllowed = await nginx.handle(new Request('http://t/items', { method: 'DELETE' }), buf);
  assert.equal(notAllowed.status, 405);
  assert.match(notAllowed.headers.get('allow') || '', /GET/);
  nginx.dispose();
});

test('route params: :id captured into ctx.params', async () => {
  const app = compose();
  app.server().listen(80).serverName('t')
    .get('/users/:id', (req, ctx) => Response.json({ id: ctx.params.id }))
    .get('/users/:id/posts/:pid', (req, ctx) => Response.json(ctx.params));

  const conf = app.toConf();
  assert.match(conf, /location ~ \^\/users\/\(\?<p_id>\[\^\/\]\+\)\$/);

  const nginx = await app.build();
  assert.deepEqual(await (await nginx.handle(new Request('http://t/users/42'), buf)).json(), { id: '42' });
  assert.deepEqual(
    await (await nginx.handle(new Request('http://t/users/7/posts/99'), buf)).json(),
    { id: '7', pid: '99' }
  );
  nginx.dispose();
});

test('all() catches every method', async () => {
  const app = compose();
  app.server().listen(80).serverName('t').all('/any', (req) => new Response('m:' + req.method));
  const nginx = await app.build();
  for (const m of ['GET', 'POST', 'DELETE']) {
    const body = m === 'GET' ? undefined : 'x';
    assert.equal(await (await nginx.handle(new Request('http://t/any', { method: m, body }), buf)).text(), 'm:' + m);
  }
  nginx.dispose();
});

test('upstream builder + proxyPass with a declined fixture falls through', async () => {
  const app = compose();
  app.upstream('backend').server('10.0.0.5:8080', { weight: 2 }).server('10.0.0.6:8080').keepalive(8);
  app.server().listen(80).serverName('t').location('/api/').proxyPass('http://backend');

  const conf = app.toConf();
  assert.match(conf, /upstream backend \{/);
  assert.match(conf, /server 10\.0\.0\.5:8080 weight=2;/);
  assert.match(conf, /keepalive 8;/);

  const nginx = await app.build({ upstream: async () => new Response('from fixture') });
  const r = await nginx.handle(new Request('http://t/api/x'), buf);
  assert.equal(await r.text(), 'from fixture');
  nginx.dispose();
});

test('map + directives (expires, error_page, add_header)', async () => {
  const app = compose();
  app.map('$http_x_flavor', { default: 'vanilla', choc: 'chocolate' }, '$flavor');
  const srv = app.server();
  srv.listen(80).serverName('t').errorPage(404, '/nope');
  srv.location('= /nope').return(404, 'custom nope');
  srv.location('/cached').expires('1h').addHeader('Cache-Control', 'public').handle(() => new Response('c'));
  srv.location('/flavor').handle((req, ctx) => new Response(ctx.vars('flavor')));

  const conf = app.toConf();
  assert.match(conf, /map \$http_x_flavor \$flavor \{/);
  assert.match(conf, /error_page 404 \/nope;/);
  assert.match(conf, /expires 1h;/);

  const nginx = await app.build();
  assert.equal(await (await nginx.handle(new Request('http://t/missing'), buf)).text(), 'custom nope');

  const cached = await nginx.handle(new Request('http://t/cached'), buf);
  assert.match(cached.headers.get('cache-control') || '', /public/);
  assert.match(cached.headers.get('cache-control') || '', /max-age=3600/);
  assert.ok(cached.headers.get('expires'));

  assert.equal(await (await nginx.handle(new Request('http://t/flavor', { headers: { 'x-flavor': 'choc' } }), buf)).text(), 'chocolate');
  assert.equal(await (await nginx.handle(new Request('http://t/flavor'), buf)).text(), 'vanilla');
  nginx.dispose();
});

test('limitConn zone + directive', async () => {
  const app = compose();
  app.limitConnZone('perip', {});
  app.server().listen(80).serverName('t')
    .location('/x').limitConn('perip', 10).handle(() => new Response('ok'));
  const conf = app.toConf();
  assert.match(conf, /limit_conn_zone .* zone=perip:1m;/);
  assert.match(conf, /limit_conn perip 10;/);
  const nginx = await app.build();
  assert.equal(await (await nginx.handle(new Request('http://t/x'), buf)).text(), 'ok');
  nginx.dispose();
});

test('materialize is idempotent (toConf stable, build works after toConf)', async () => {
  const app = compose();
  app.server().listen(80).serverName('t').get('/a', () => new Response('a'));
  const c1 = app.toConf();
  const c2 = app.toConf();
  assert.equal(c1, c2);
  const nginx = await app.build();
  assert.equal(await (await nginx.handle(new Request('http://t/a'), buf)).text(), 'a');
  nginx.dispose();
});
