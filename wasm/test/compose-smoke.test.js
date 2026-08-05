import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../js/compose.js';

const buf = { buffer: true, timeout: 8000 };

async function withApp(configure, fn) {
  const app = compose();
  const srv = app.server();
  srv.listen(80).serverName('t');
  configure(srv, app);
  const nginx = await app.build();
  try {
    await fn(nginx, srv, app);
  } finally {
    nginx.dispose();
  }
}

test('response shapes', async (t) => {
  await withApp(
    (srv) => {
      srv.location('/str').handle(() => new Response('plain'));
      srv.location('/json').handle(() => Response.json({ a: 1, b: [2, 3] }));
      srv.location('/empty').handle(() => new Response(null, { status: 204 }));
      srv.location('/status').handle(() => new Response('teapot', { status: 418 }));
      srv.location('/headers').handle(() => new Response('h', { headers: { 'X-Custom': 'yes', 'X-Two': 'a, b' } }));
      srv.location('/coerce-string').handle(() => 'not a response object');
      srv.location('/coerce-null').handle(() => null);
      srv.location('/redirect').handle(() => new Response(null, { status: 302, headers: { location: '/there' } }));
    },
    async (nginx) => {
      const get = (p) => nginx.handle(new Request('http://t' + p), buf);

      let r = await get('/str');
      assert.equal(r.status, 200);
      assert.equal(await r.text(), 'plain');

      r = await get('/json');
      assert.equal(r.headers.get('content-type'), 'application/json');
      assert.deepEqual(await r.json(), { a: 1, b: [2, 3] });

      r = await get('/empty');
      assert.equal(r.status, 204);
      assert.equal(await r.text(), '');

      r = await get('/status');
      assert.equal(r.status, 418);
      assert.equal(await r.text(), 'teapot');

      r = await get('/headers');
      assert.equal(r.headers.get('x-custom'), 'yes');
      assert.equal(r.headers.get('x-two'), 'a, b');

      r = await get('/coerce-string');
      assert.equal(await r.text(), 'not a response object');

      r = await get('/coerce-null');
      assert.equal(r.status, 200);
      assert.equal(await r.text(), '');

      r = await get('/redirect');
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), '/there');
    }
  );
});

test('request introspection', async (t) => {
  await withApp(
    (srv) => {
      srv.location('/echo').handle(async (req) =>
        Response.json({
          method: req.method,
          path: new URL(req.url).pathname,
          query: new URL(req.url).search,
          ct: req.headers.get('content-type'),
          custom: req.headers.get('x-custom'),
          body: req.method === 'GET' || req.method === 'HEAD' ? null : await req.text(),
        })
      );
    },
    async (nginx) => {
      let r = await nginx.handle(new Request('http://t/echo?x=1&y=2', { headers: { 'x-custom': 'hi' } }), buf);
      let j = await r.json();
      assert.equal(j.method, 'GET');
      assert.equal(j.path, '/echo');
      assert.equal(j.query, '?x=1&y=2');
      assert.equal(j.custom, 'hi');

      r = await nginx.handle(new Request('http://t/echo', { method: 'POST', body: 'the body', headers: { 'content-type': 'text/plain' } }), buf);
      j = await r.json();
      assert.equal(j.method, 'POST');
      assert.equal(j.ct, 'text/plain');
      assert.equal(j.body, 'the body');

      for (const method of ['PUT', 'DELETE', 'PATCH']) {
        r = await nginx.handle(new Request('http://t/echo', { method, body: method + '-body' }), buf);
        j = await r.json();
        assert.equal(j.method, method);
        assert.equal(j.body, method + '-body');
      }
    }
  );
});

test('ctx: variables, remoteAddr, location', async (t) => {
  await withApp(
    (srv) => {
      srv.location('/ctx').handle((req, ctx) =>
        Response.json({
          loc: ctx.location,
          addr: ctx.remoteAddr,
          uri: ctx.vars('uri'),
          args: ctx.vars('args'),
          arg_id: ctx.vars('arg_id'),
          ua: ctx.vars('http_user_agent'),
          method: ctx.vars('request_method'),
          missing: ctx.vars('definitely_not_a_var_xyz'),
        })
      );
    },
    async (nginx) => {
      const r = await nginx.handle(
        new Request('http://t/ctx?id=99&z=1', { headers: { 'user-agent': 'smoke/1' } }),
        { ...buf, clientAddress: '198.51.100.7' }
      );
      const j = await r.json();
      assert.equal(j.loc, '/ctx');
      assert.equal(j.addr, '198.51.100.7');
      assert.equal(j.uri, '/ctx');
      assert.equal(j.args, 'id=99&z=1');
      assert.equal(j.arg_id, '99');
      assert.equal(j.ua, 'smoke/1');
      assert.equal(j.method, 'GET');
      assert.equal(j.missing, null);
    }
  );
});

test('error paths never crash the engine', async (t) => {
  await withApp(
    (srv) => {
      srv.location('/throw').handle(() => { throw new Error('boom'); });
      srv.location('/reject').handle(async () => { throw new Error('async boom'); });
      srv.location('/throw-late').handle(async () => { await new Promise((r) => setTimeout(r, 20)); throw new Error('late'); });
      srv.location('/ok').handle(() => new Response('still fine'));
    },
    async (nginx) => {
      assert.equal((await nginx.handle(new Request('http://t/throw'), buf)).status, 500);
      assert.equal((await nginx.handle(new Request('http://t/reject'), buf)).status, 500);
      assert.equal((await nginx.handle(new Request('http://t/throw-late'), buf)).status, 500);
      const r = await nginx.handle(new Request('http://t/ok'), buf);
      assert.equal(await r.text(), 'still fine');
    }
  );
});

test('body sizes: empty, large, binary', async (t) => {
  const big = 'x'.repeat(300 * 1024);
  const binary = new Uint8Array(4096);
  for (let i = 0; i < binary.length; i++) binary[i] = i & 0xff;

  await withApp(
    (srv) => {
      srv.location('/empty-resp').handle(() => new Response(''));
      srv.location('/big-resp').handle(() => new Response(big));
      srv.location('/binary-resp').handle(() => new Response(binary));
      srv.location('/echo-body').handle(async (req) => new Response(await req.arrayBuffer()));
    },
    async (nginx) => {
      assert.equal(await (await nginx.handle(new Request('http://t/empty-resp'), buf)).text(), '');

      const b = await (await nginx.handle(new Request('http://t/big-resp'), buf)).text();
      assert.equal(b.length, big.length);
      assert.equal(b, big);

      const bin = new Uint8Array(await (await nginx.handle(new Request('http://t/binary-resp'), buf)).arrayBuffer());
      assert.equal(bin.length, binary.length);
      assert.deepEqual(bin, binary);

      const echoed = new Uint8Array(await (await nginx.handle(new Request('http://t/echo-body', { method: 'POST', body: binary }), buf)).arrayBuffer());
      assert.deepEqual(echoed, binary);
    }
  );
});

test('special characters in config values (quoting)', async (t) => {
  await withApp(
    (srv) => {
      srv.location('/q').return(200, 'has "quotes" and \\ backslash');
      srv.location('/handler').setHeader('X-Weird', 'a"b\\c').handle(() => new Response('ok'));
    },
    async (nginx) => {
      const r = await nginx.handle(new Request('http://t/q'), buf);
      assert.equal(await r.text(), 'has "quotes" and \\ backslash');
      const h = await nginx.handle(new Request('http://t/handler'), buf);
      assert.equal(h.headers.get('x-weird'), 'a"b\\c');
    }
  );
});

test('real nginx phases run before the handler', async (t) => {
  await withApp(
    (srv, app) => {
      app.limitReqZone('z', { rate: '1000r/s' });
      srv.location('/denied').deny('all').handle(() => new Response('should not run'));
      srv.location('/limited').limitReq('z', { burst: 100, nodelay: true }).handle(() => new Response('limited-ok'));
      srv.location('/rewritten').rewrite(/^\/rewritten\/(.*)$/, '/target/$1', 'last').handle(() => new Response('no'));
      srv.location('/target/').handle((req) => new Response('landed:' + new URL(req.url).pathname));
      srv.get('/only-get', () => new Response('got'));
    },
    async (nginx) => {
      assert.equal((await nginx.handle(new Request('http://t/denied'), buf)).status, 403);
      assert.equal(await (await nginx.handle(new Request('http://t/limited'), buf)).text(), 'limited-ok');
      assert.equal(await (await nginx.handle(new Request('http://t/rewritten/abc'), buf)).text(), 'landed:/target/abc');
      assert.equal(await (await nginx.handle(new Request('http://t/only-get'), buf)).text(), 'got');
      assert.equal((await nginx.handle(new Request('http://t/only-get', { method: 'POST' }), buf)).status, 405);
    }
  );
});

test('regex and exact location handlers', async (t) => {
  await withApp(
    (srv) => {
      srv.location('= /exact').handle(() => new Response('exact'));
      srv.location(/\.json$/).handle((req) => new Response('regex:' + new URL(req.url).pathname));
      srv.location(/\.PNG$/i).handle(() => new Response('case-insensitive'));
    },
    async (nginx) => {
      assert.equal(await (await nginx.handle(new Request('http://t/exact'), buf)).text(), 'exact');
      assert.equal(await (await nginx.handle(new Request('http://t/x/data.json'), buf)).text(), 'regex:/x/data.json');
      assert.equal(await (await nginx.handle(new Request('http://t/logo.png'), buf)).text(), 'case-insensitive');
    }
  );
});

test('sequential stress: token reuse over many requests', async (t) => {
  await withApp(
    (srv) => {
      let n = 0;
      srv.location('/seq').handle(() => new Response('r' + n++));
    },
    async (nginx) => {
      for (let i = 0; i < 500; i++) {
        const r = await nginx.handle(new Request('http://t/seq'), buf);
        assert.equal(r.status, 200);
        assert.equal(await r.text(), 'r' + i);
      }
    }
  );
});

test('concurrent stress: many in-flight async handlers', async (t) => {
  await withApp(
    (srv) => {
      srv.location('/c').handle(async (req) => {
        const id = new URL(req.url).searchParams.get('id');
        await new Promise((r) => setTimeout(r, Math.floor((id % 5)) + 1));
        return Response.json({ id: Number(id) });
      });
    },
    async (nginx) => {
      const N = 40;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          nginx.handle(new Request(`http://t/c?id=${i}`), buf).then((r) => r.json())
        )
      );
      const ids = results.map((r) => r.id).sort((a, b) => a - b);
      assert.deepEqual(ids, Array.from({ length: N }, (_, i) => i));
    }
  );
});

test('interleaved handlers and non-JS routes', async (t) => {
  await withApp(
    (srv) => {
      srv.location('= /health').return(200, 'ok');
      srv.location('/js').handle(async (req) => new Response('js:' + new URL(req.url).pathname));
      srv.location('/static/').return(404);
    },
    async (nginx) => {
      const rounds = [];
      for (let i = 0; i < 30; i++) {
        rounds.push(nginx.handle(new Request('http://t/health'), buf).then((r) => r.text()));
        rounds.push(nginx.handle(new Request(`http://t/js/${i}`), buf).then((r) => r.text()));
        rounds.push(nginx.handle(new Request('http://t/static/x'), buf).then((r) => r.status));
      }
      const out = await Promise.all(rounds);
      for (let i = 0; i < 30; i++) {
        assert.equal(out[i * 3], 'ok');
        assert.equal(out[i * 3 + 1], `js:/js/${i}`);
        assert.equal(out[i * 3 + 2], 404);
      }
    }
  );
});

test('HEAD request to a handler', async (t) => {
  await withApp(
    (srv) => {
      srv.location('/h').handle(() => new Response('body-here', { headers: { 'x-mark': '1' } }));
    },
    async (nginx) => {
      const r = await nginx.handle(new Request('http://t/h', { method: 'HEAD' }), buf);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('x-mark'), '1');
      assert.equal(await r.text(), '');
    }
  );
});

test('toConf() is stable and complete', async (t) => {
  const app = compose();
  app.limitReqZone('z', { rate: '5r/s' });
  const s1 = app.server();
  s1.listen(443, { ssl: true, http2: true }).serverName('a.test', 'b.test').cert('/c.pem', '/k.pem').gzip({ minLength: 100 });
  s1.location('= /health').return(200, 'ok');
  s1.location('/api/').handle(() => new Response('x'));
  const s2 = app.server();
  s2.listen(80).serverName('plain.test');
  s2.location('/').root('/www');

  const conf = app.toConf();
  assert.equal(conf, app.toConf());
  assert.match(conf, /listen 443 ssl;/);
  assert.match(conf, /http2 on;/);
  assert.match(conf, /server_name a\.test b\.test;/);
  assert.match(conf, /ssl_certificate \/c\.pem;/);
  assert.match(conf, /wasm_js_content h/);
  assert.match(conf, /server_name plain\.test;/);
  assert.equal((conf.match(/server \{/g) || []).length, 2);
});

test('dispose during an in-flight handler does not crash', async (t) => {
  const app = compose();
  app.server().listen(80).serverName('t')
    .location('/slow').handle(async () => { await new Promise((r) => setTimeout(r, 300)); return new Response('done'); });
  const nginx = await app.build();
  const pending = nginx.handle(new Request('http://t/slow'), { buffer: true, timeout: 500 }).catch(() => 'errored');
  await new Promise((r) => setTimeout(r, 50));
  nginx.dispose();
  const result = await pending;
  assert.ok(result === 'errored' || typeof result === 'object');
});
