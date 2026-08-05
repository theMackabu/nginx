# nginx-wasm

**Real nginx, compiled to WebAssembly, driven as a library.**

nginx-wasm is the actual nginx C source, built with Emscripten and
exposed through a small JS API. The build includes config parsing,
virtual-server selection, location matching, rewrites, the phase
engine, proxying, and gzip. nginx-wasm runs the same code as
production nginx. Thus a request follows the same route in nginx-wasm
as in production.

```js
import { Nginx } from 'nginx-wasm';

const nginx = await Nginx.create(`
  server {
    listen 80;
    server_name api.example.com;
    location /v1/ { proxy_pass http://backend; }
    location ~* \\.php$ { return 403; }
  }
  upstream backend { server 10.0.0.5:8080; }
`);

const r = await nginx.route(new Request('http://api.example.com/v1/users?id=3'));
r.location;
r.proxied;
r.upstream;
r.trace;
```

You do not need an nginx binary, Docker, or sockets. nginx-wasm runs
under Node 18 or later, Node-compatible runtimes, and browsers.

## Why

`nginx.conf` files describe millions of production systems. Before, to
know what a config does, you had to install nginx and run it.
nginx-wasm turns the question into a function call:

- **Test configs in CI** — load your real production config. Assert
  that routes go to the correct upstreams. Assert that rewrites give
  the results that you expect. Assert that access rules deny the
  requests that they must deny.
- **Playground** — paste a config in a browser tab, fire requests at
  it, watch location matching happen (see `playground/`). A service
  worker even serves real URLs under `playground/site/` out of the
  nginx instance in your tab.
- **Dev servers** — `serve()` really serves TCP: node's event loop
  drives nginx's own handlers, `proxy_pass` opens real sockets.

## Install / build

```sh
npm install nginx-wasm
```

Building from source needs Emscripten, meson, and ninja:

```sh
./wasm/build.sh
cd wasm && npm test
```

meson orchestrates the build. PCRE2 and zlib are pinned wrapdb
subprojects, compiled for the target machine. The same pinned sources
feed the native binary that `npm run diff` uses. nginx's own
configure/make and the final Emscripten link run as meson targets.

The [`examples/`](examples/README.md) directory contains runnable
demos and a smoke test for the local server.

## API

### Loading configs

```js
const nginx = await Nginx.create('server { listen 80; ... }');

const nginx = await Nginx.create({ conf: '/etc/nginx/nginx.conf' });

const nginx = await Nginx.create(conf, {
  mounts: { '/var/www/html': './public' },
});

const nginx = await Nginx.create(conf, {
  files: { '/var/www/html/index.html': '<h1>hi</h1>' },
});
```

### Dispatching requests

```js
const res = await nginx.handle(new Request('http://host/path'));

const r = await nginx.route(new Request('http://host/path'));

```

### Upstream fixtures — proxying without a network

nginx does all the real operations: upstream selection, URI rewrites,
and `proxy_set_header`. Your handler acts as the backend:

```js
const nginx = await Nginx.create(conf, {
  upstream: async (request, target) => {

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  },
});
```

### Really serving

```js
const server = await nginx.serve({ port: 8080 });

```

HTTP/2 works over `serve()` with `http2 on;`. It supports h2c prior
knowledge, and h2 over TLS through ALPN. Streams multiplex over the
same byte buffers. `limit_req` and `limit_conn` are fully functional:
the shared-memory zones live in wasm memory, and the host-driven
timers release delayed requests.

### TLS

The build includes OpenSSL, so `listen 443 ssl` configs load.
`serve()` terminates real TLS. Certs load from the vfs. The handshake
runs over the in-memory buffers. SNI selects virtual servers, with
per-server certs. ALPN negotiates HTTP/2.

```js
const nginx = await Nginx.create(`
  server {
    listen 443 ssl;
    server_name a.example.com;
    ssl_certificate     /certs/a.pem;
    ssl_certificate_key /certs/a.key;
    location / { return 200 "over TLS"; }
  }
`, { files: { '/certs/a.pem': certPem, '/certs/a.key': keyPem } });

await nginx.serve({ port: 8443, nginxPort: 443 });

```

OCSP stapling works in two modes. With `ssl_stapling_file`, nginx
staples a pre-fetched response from the vfs. With `ssl_stapling on`,
nginx fetches the OCSP response over a real socket and staples it.

### DNS resolution

There are two resolution paths. They match nginx's own design:

- **Config-time host resolution** (`getaddrinfo`) — upstream server
  names and the OCSP responder host resolve through a `hosts` map you
  provide, synchronously, like `/etc/hosts`:

  ```js
  await Nginx.create(conf, { hosts: { 'backend.local': '10.0.0.5' } });
  ```

- **Runtime resolution** (the `resolver` directive) — when a
  `proxy_pass` host is a variable, nginx resolves it for each request
  over real UDP DNS. The engine bridges this DNS traffic to a
  `node:dgram` socket.

### Config tooling

```js
await Nginx.test('server { listen 80; proxy_pas x; }');

await nginx.reload(newConfig);
nginx.config;
nginx.ports;
nginx.unsupported;
nginx.dispose();
Nginx.versions;
```

### Test-runner sugar

```js
import { configTest } from 'nginx-wasm/testing';

const t = await configTest({ conf: './deploy/nginx/nginx.conf' });
await t.expect('GET http://api.example.com/v1/users').toProxyTo('backend');
await t.expect('GET http://api.example.com/admin').toReturn(403);
await t.expect('GET http://old.example.com/x').toRedirectTo('https://example.com/x');
await t.expect('GET http://api.example.com/img/a.png').toServeFile('/var/www/img/a.png');
await t.expect('GET http://api.example.com/old/u').toRewriteTo('/v1/u');
t.dispose();
```

Matchers throw plain `Error` objects with the nginx trace attached.
They work under node:test, vitest, jest, and other test runners. A
built-in echo fixture answers proxied requests unless you pass your
own `upstream` handler.

## Code-based routing (`nginx-wasm/compose`)

Build your config in JS and attach JS content handlers. The builder
compiles to a real `nginx.conf` (`app.toConf()`). Thus nginx still
does every phase: location matching, rewrites, access rules, and rate
limiting. Your JS only produces content. A handler runs in the content
phase through a native `wasm_js_content` module. The handler reads the
live request and has real access to nginx variables. It sends its
output through nginx's own output filter chain, with no
re-serialization.

```js
import { compose } from 'nginx-wasm/compose';

const app = compose();
app.limitReqZone('perip', { rate: '50r/s' });
app.upstream('backend').server('10.0.0.5:8080').keepalive(8);

const srv = app.server();
srv.listen(443, { ssl: true, http2: true }).serverName('api.example.com').cert('/c.pem', '/k.pem').gzip({ minLength: 256 });

srv.location('= /health').return(200, 'ok');
srv.location('/v1/').proxyPass('http://backend', { http11: true });

srv.get('/users/:id', (req, ctx) => Response.json({ id: ctx.params.id }));
srv.put('/users/:id', async (req, ctx) => { save(ctx.params.id, await req.text()); return new Response(null, { status: 204 }); });

srv.location('/whoami')
   .limitReq('perip', { burst: 10, nodelay: true })
   .handle((req, ctx) => Response.json({ ip: ctx.remoteAddr, ua: ctx.vars('http_user_agent') }));

const nginx = await app.build();
await nginx.serve({ port: 8443 });
```

The handler signature is `(request, ctx) => Response | Promise<Response>`,
where `ctx = { remoteAddr, location, params, vars(name) }`. Handlers
can be async. A `Response` built from a multi-chunk `ReadableStream`
streams incrementally instead of buffering. This applies to SSE and
generated data.

Access-phase JS (auth) runs *before* the content phase. Return a 2xx
`Response` to allow the request. Return a different status (401, 403,
…) to deny the request:

```js
srv.use((req, ctx) => new Response(null, { status: req.headers.get('authorization') ? 200 : 401 }));
```

(Note: `return` and `rewrite` run in the rewrite phase, *before* access —
gate a content-phase resource like a `.handle()`, static file, or
`proxy_pass`, not a bare `return`.)

`app.toConf()` prints the exact nginx.conf. The builder only generates
config. This design makes sure that real nginx does all the
processing.

## How it works

nginx is built for wasm32 with its full module set (minus a few — see
below) and booted as a single-process cycle. The sandbox has no event
loop and no sockets. Each nginx socket is an in-memory buffer pair.
The host calls nginx's own event handlers when bytes arrive, when an
upstream connects, or when a timer is due. The build overrides `recv`,
`writev`, and the related functions at link time. Thus the I/O code
paths that run are nginx's own (`ngx_unix_recv`, `ngx_writev_chain`).
One host `setTimeout` on `ngx_event_expire_timers` drives the timers.

`route()`'s trace is nginx's real debug log (`--with-debug`), which is
also where the matched-location and rewrite information comes from.

## Differential testing

`npm run diff` replays a corpus of configs and requests against **both**
a native nginx built from this same source tree and nginx-wasm, and
diffs status, headers, and bodies. This test makes sure that wasm
behavior stays identical to native nginx. It runs in CI. If an engine
change makes wasm diverge from native, the build fails.

## Versions

| component  | version |
| ---------- | ------- |
| nginx      | this source tree (see `Nginx.versions.nginx`) |
| PCRE2      | wrapdb pin (`subprojects/pcre2.wrap`), JIT disabled |
| zlib       | wrapdb pin (`subprojects/zlib.wrap`) |
| OpenSSL    | wrapdb pin (`subprojects/openssl.wrap`), no-asm, single-threaded |
| Emscripten | 6.x |

`Nginx.versions` reports the exact versions a given build wraps.

## Limits & caveats

- **One worker.** `worker_processes`, shared-memory zones across
  workers, and all other fork-related features are single-instance by
  design.
- **TLS is full**: cert loading, handshake, SNI, ALPN, and OCSP stapling
  (file-based and live) all work. Config-time host resolution uses a
  `hosts` map (no system resolver in wasm); runtime `resolver` DNS needs
  a `node:dgram`-capable runtime.
- **No kernel features**: `sendfile`, AIO, thread pools are inert —
  `nginx.unsupported` lists what your config uses that falls in this
  bucket.
- ~300 concurrent connections (select-module fd budget).
- Backpressure is real end-to-end: nginx stalls at a 256 KB high-water mark per connection and resumes as the consumer drains (socket drain events / ReadableStream pulls).
- Concurrent `handle()` calls interleave the debug trace. Routing
  decisions stay correct, but the trace can mix lines under parallel
  load.
- `dispose()` releases host resources. The runtime reclaims wasm
  memory when it garbage-collects the instance.

## License

BSD-2-Clause, same as nginx. This directory wraps the nginx sources in
the enclosing repository.
