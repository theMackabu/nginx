import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../js/compose.js';

test('compose: config generation + JS content handlers', async (t) => {
  const app = compose();
  app.limitReqZone('perip', { rate: '10r/s' });
  const srv = app.server();
  srv.listen(80).serverName('api.test').root('/www');
  srv.location('= /health').return(200, 'ok');
  srv.location('/secret/').deny('all');
  srv.location('/old/').rewrite(/^\/old\/(.*)$/, '/v1/$1', 'last');
  srv.location('/api/users').limitReq('perip', { burst: 5, nodelay: true })
    .handle((req, ctx) => Response.json({ id: new URL(req.url).searchParams.get('id'), loc: ctx.location }));
  srv.get('/ping', () => new Response('pong'));
  srv.post('/echo', async (req) => new Response(await req.text()));

  await t.test('toConf() emits real nginx directives', () => {
    const conf = app.toConf();
    assert.match(conf, /limit_req_zone .* zone=perip:1m rate=10r\/s;/);
    assert.match(conf, /location = \/health \{[\s\S]*return 200 "ok";/);
    assert.match(conf, /location \/api\/users \{[\s\S]*limit_req zone=perip burst=5 nodelay;[\s\S]*wasm_js_content h/);
    assert.match(conf, /rewrite \^\\\/old\\\/\(\.\*\)\$ \/v1\/\$1 last;/);
  });

  const nginx = await app.build({ files: { '/www/x': 'hi' } });

  await t.test('return directive (no JS)', async () => {
    const r = await nginx.handle(new Request('http://api.test/health'), { buffer: true });
    assert.equal(await r.text(), 'ok');
  });

  await t.test('JS content handler sees query params + ctx.location', async () => {
    const r = await nginx.handle(new Request('http://api.test/api/users?id=42'), { buffer: true });
    assert.deepEqual(await r.json(), { id: '42', loc: '/api/users' });
  });

  await t.test('method sugar: GET handler', async () => {
    assert.equal(await (await nginx.handle(new Request('http://api.test/ping'), { buffer: true })).text(), 'pong');
  });

  await t.test('method sugar: POST body reaches the handler', async () => {
    const r = await nginx.handle(new Request('http://api.test/echo', { method: 'POST', body: 'hello world' }), { buffer: true });
    assert.equal(await r.text(), 'hello world');
  });

  await t.test('method guard: wrong method → 405 (real nginx, before JS)', async () => {
    assert.equal((await nginx.handle(new Request('http://api.test/ping', { method: 'POST' }), { buffer: true })).status, 405);
  });

  await t.test('nginx phases still run: deny 403 before any JS', async () => {
    assert.equal((await nginx.handle(new Request('http://api.test/secret/x'), { buffer: true })).status, 403);
  });

  await t.test('route() reflects the real nginx decision', async () => {
    const r = await nginx.route(new Request('http://api.test/old/thing'));
    assert.deepEqual(r.rewrites, ['/v1/thing']);
  });

  nginx.dispose();
});

test('compose: ctx.vars reads real nginx variables', async () => {
  const app = compose();
  app.server().listen(80).serverName('t')
    .location('/v').handle((req, ctx) => Response.json({
      ua: ctx.vars('http_user_agent'),
      uri: ctx.vars('uri'),
      arg: ctx.vars('arg_q'),
      addr: ctx.remoteAddr,
    }));
  const nginx = await app.build();
  const r = await nginx.handle(
    new Request('http://t/v?q=hey', { headers: { 'user-agent': 'ua/9' } }),
    { buffer: true, clientAddress: '203.0.113.5' }
  );
  assert.deepEqual(await r.json(), { ua: 'ua/9', uri: '/v', arg: 'hey', addr: '203.0.113.5' });
  nginx.dispose();
});

test('compose: async handler (awaits before responding)', async () => {
  const app = compose();
  app.server().listen(80).serverName('t')
    .location('/slow').handle(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return new Response('after await');
    });
  const nginx = await app.build();
  const r = await nginx.handle(new Request('http://t/slow'), { buffer: true });
  assert.equal(await r.text(), 'after await');
  nginx.dispose();
});
