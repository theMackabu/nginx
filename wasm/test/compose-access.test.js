import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../js/compose.js';

const buf = { buffer: true, timeout: 8000 };

test('use(): access handler allows 2xx, denies otherwise', async () => {
  const app = compose();
  const srv = app.server();
  srv.listen(80).serverName('t');
  srv.use((req) => new Response(null, { status: req.headers.get('x-key') === 'secret' ? 200 : 403 }));
  srv.location('/').handle(() => new Response('protected content'));
  const nginx = await app.build();

  const denied = await nginx.handle(new Request('http://t/'), buf);
  assert.equal(denied.status, 403);

  const allowed = await nginx.handle(new Request('http://t/', { headers: { 'x-key': 'secret' } }), buf);
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), 'protected content');
  nginx.dispose();
});

test('access handler runs before content JS handlers', async () => {
  const app = compose();
  let handlerRan = false;
  const srv = app.server();
  srv.listen(80).serverName('t');
  srv.use((req) => new Response(null, { status: req.headers.get('authorization') ? 200 : 401 }));
  srv.location('/api').handle(() => { handlerRan = true; return new Response('data'); });
  const nginx = await app.build();

  handlerRan = false;
  const denied = await nginx.handle(new Request('http://t/api'), buf);
  assert.equal(denied.status, 401);
  assert.equal(handlerRan, false, 'content handler must not run when access denies');

  const allowed = await nginx.handle(new Request('http://t/api', { headers: { authorization: 'Bearer x' } }), buf);
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), 'data');
  assert.equal(handlerRan, true);
  nginx.dispose();
});

test('async access handler (awaits before deciding)', async () => {
  const app = compose();
  const srv = app.server();
  srv.listen(80).serverName('t');
  srv.use(async (req) => {
    await new Promise((r) => setTimeout(r, 40));
    return new Response(null, { status: req.headers.get('x-ok') ? 200 : 403 });
  });
  srv.location('/').handle(() => new Response('ok'));
  const nginx = await app.build();

  assert.equal((await nginx.handle(new Request('http://t/'), buf)).status, 403);
  assert.equal((await nginx.handle(new Request('http://t/', { headers: { 'x-ok': '1' } }), buf)).status, 200);
  nginx.dispose();
});

test('access handler can read ctx (headers, vars, remoteAddr)', async () => {
  const app = compose();
  let seen = null;
  const srv = app.server();
  srv.listen(80).serverName('t');
  srv.use((req, ctx) => {
    seen = { auth: req.headers.get('authorization'), addr: ctx.remoteAddr, ua: ctx.vars('http_user_agent') };
    return new Response(null, { status: 200 });
  });
  srv.location('/').handle(() => new Response('ok'));
  const nginx = await app.build();
  await nginx.handle(
    new Request('http://t/', { headers: { authorization: 'tok', 'user-agent': 'acc/1' } }),
    { ...buf, clientAddress: '203.0.113.9' }
  );
  assert.deepEqual(seen, { auth: 'tok', addr: '203.0.113.9', ua: 'acc/1' });
  nginx.dispose();
});

test('access + content on the same location, allowed', async () => {
  const app = compose();
  const srv = app.server();
  srv.listen(80).serverName('t');
  srv.use((req) => new Response(null, { status: req.headers.get('x-key') ? 200 : 403 }));
  srv.get('/users/:id', (req, ctx) => Response.json({ id: ctx.params.id }));
  const nginx = await app.build();

  assert.equal((await nginx.handle(new Request('http://t/users/5'), buf)).status, 403);
  const ok = await nginx.handle(new Request('http://t/users/5', { headers: { 'x-key': '1' } }), buf);
  assert.deepEqual(await ok.json(), { id: '5' });
  nginx.dispose();
});

test('sequential and concurrent requests through access handler', async () => {
  const app = compose();
  const srv = app.server();
  srv.listen(80).serverName('t');
  srv.use(async (req) => {
    await new Promise((r) => setTimeout(r, 1));
    return new Response(null, { status: Number(new URL(req.url).searchParams.get('n')) % 2 ? 200 : 403 });
  });
  srv.location('/').handle(() => new Response('ok'));
  const nginx = await app.build();

  const results = await Promise.all(
    Array.from({ length: 30 }, (_, i) => nginx.handle(new Request(`http://t/?n=${i}`), buf).then((r) => r.status))
  );
  results.forEach((status, i) => assert.equal(status, i % 2 ? 200 : 403));
  nginx.dispose();
});
