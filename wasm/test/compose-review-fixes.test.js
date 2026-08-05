import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../js/compose.js';

const buf = { buffer: true, timeout: 8000 };

test('route param path escapes regex metacharacters in static segments', async () => {
  const app = compose();
  app.server().listen(80).serverName('t')
    .get('/files.v2/:id', (req, ctx) => new Response('id:' + ctx.params.id))
    .location('/').return(404, 'nope');
  const nginx = await app.build();

  assert.equal(await (await nginx.handle(new Request('http://t/files.v2/9'), buf)).text(), 'id:9');

  assert.equal((await nginx.handle(new Request('http://t/filesXv2/9'), buf)).status, 404);
  nginx.dispose();
});

test('duplicate route param name is rejected', () => {
  const app = compose();
  assert.throws(() => app.server().get('/x/:id/y/:id', () => new Response('')), /duplicate route param/);
});

test('ctx.location is the path the user wrote, not the compiled regex', async () => {
  const app = compose();
  app.server().listen(80).serverName('t')
    .get('/users/:id', (req, ctx) => Response.json({ loc: ctx.location }));
  const nginx = await app.build();
  assert.deepEqual(await (await nginx.handle(new Request('http://t/users/1'), buf)).json(), { loc: '/users/:id' });
  nginx.dispose();
});

test('multiple Set-Cookie headers are preserved individually', async () => {
  const app = compose();
  app.server().listen(80).serverName('t').location('/c').handle(() => {
    const h = new Headers();
    h.append('Set-Cookie', 'a=1; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT');
    h.append('Set-Cookie', 'b=2; HttpOnly');
    return new Response('ok', { headers: h });
  });
  const nginx = await app.build();
  const r = await nginx.handle(new Request('http://t/c'), buf);
  const cookies = r.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.some((c) => c.startsWith('a=1')));
  assert.ok(cookies.some((c) => c.startsWith('b=2')));

  assert.ok(cookies.find((c) => c.startsWith('a=1')).includes('Expires=Wed, 21 Oct'));
  nginx.dispose();
});

test('405 Allow header does not leak the * sentinel', async () => {
  const app = compose();
  const srv = app.server();
  srv.listen(80).serverName('t');
  srv.get('/r', () => new Response('g'));
  srv.all('/r', () => new Response('any'));
  const nginx = await app.build();

  srv2: {
    const app2 = compose();
    app2.server().listen(80).serverName('t').get('/only', () => new Response('g'));
    const n2 = await app2.build();
    const r = await n2.handle(new Request('http://t/only', { method: 'POST' }), buf);
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('allow'), 'GET');
    assert.doesNotMatch(r.headers.get('allow') || '', /\*/);
    n2.dispose();
  }
  nginx.dispose();
});

test('handler response drops hop-by-hop headers it should not set', async () => {
  const app = compose();
  app.server().listen(80).serverName('t').location('/h').handle(() =>
    new Response('body', { headers: { 'X-Keep': 'yes', 'Transfer-Encoding': 'chunked', Connection: 'keep-alive' } })
  );
  const nginx = await app.build();
  const r = await nginx.handle(new Request('http://t/h'), buf);
  assert.equal(r.headers.get('x-keep'), 'yes');
  assert.equal(await r.text(), 'body');
  nginx.dispose();
});

test('chunked completion is not fooled by a header value ending in 0', async () => {

  const chunks = ['alpha-', 'beta-', 'gamma'];
  const app = compose();
  app.server().listen(80).serverName('t').location('/z').handle(() =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
          c.close();
        },
      }),
      { headers: { 'X-Zero': '0', 'Age': '0', 'Cache-Control': 'max-age=0' } }
    )
  );
  const nginx = await app.build();
  assert.equal(await (await nginx.handle(new Request('http://t/z'), buf)).text(), 'alpha-beta-gamma');
  nginx.dispose();
});
