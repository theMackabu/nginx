import { compose } from '../js/compose.js';

const app = compose();

app.limitReqZone('perip', { rate: '10r/s' });

const srv = app.server();
srv.listen(80).serverName('api.example.com').root('/var/www/html').gzip({ minLength: 256 });

srv.location('= /health').return(200, 'ok\n');
srv.location('/old/').rewrite(/^\/old\/(.*)$/, '/v1/$1', 'last');
srv.location('/secret/').deny('all');

srv.location('/api/users')
  .limitReq('perip', { burst: 5, nodelay: true })
  .handle(async (req, ctx) => {
    const id = new URL(req.url).searchParams.get('id');
    return Response.json({ id, matchedLocation: ctx.location, client: ctx.remoteAddr });
  });

const store = new Map();
srv.get('/kv/:key', (req, ctx) => Response.json({ key: ctx.params.key, value: store.get(ctx.params.key) ?? null }));
srv.put('/kv/:key', async (req, ctx) => { store.set(ctx.params.key, await req.text()); return new Response(null, { status: 204 }); });

srv.get('/ping', () => new Response('pong\n'));
srv.post('/echo', async (req) => new Response(await req.text()));

srv.location('/whoami').handle((req, ctx) =>
  Response.json({ ip: ctx.remoteAddr, ua: ctx.vars('http_user_agent'), scheme: ctx.vars('scheme') })
);

const admin = app.server();
admin.listen(80).serverName('admin.example.com');
admin.use((req) => new Response(null, { status: req.headers.get('x-api-key') === 'sekret' ? 200 : 403 }));
admin.location('/').handle(() => new Response('admin dashboard\n'));

console.log('generated nginx.conf:\n');
console.log(app.toConf());
console.log('\n' + '─'.repeat(60) + '\n');

const nginx = await app.build();

const hit = async (url, init) => {
  const r = await nginx.handle(new Request(url, init));
  const body = await r.text();
  return `${r.status} ${JSON.stringify(body.slice(0, 80))}`;
};

console.log('GET  /health              →', await hit('http://api.example.com/health'));
console.log('GET  /api/users?id=7      →', await hit('http://api.example.com/api/users?id=7'));
console.log('GET  /ping                →', await hit('http://api.example.com/ping'));
console.log('POST /echo                →', await hit('http://api.example.com/echo', { method: 'POST', body: 'hello' }));
console.log('GET  /secret/x            →', await hit('http://api.example.com/secret/x'));
console.log('PUT  /kv/color            →', await hit('http://api.example.com/kv/color', { method: 'PUT', body: 'blue' }));
console.log('GET  /kv/color            →', await hit('http://api.example.com/kv/color'));
console.log('GET  /whoami              →', await hit('http://api.example.com/whoami', { headers: { 'user-agent': 'demo/1' } }));
console.log('GET  admin (no key)       →', await hit('http://admin.example.com/'));
console.log('GET  admin (with key)     →', await hit('http://admin.example.com/', { headers: { 'x-api-key': 'sekret' } }));

const r = await nginx.route(new Request('http://api.example.com/old/users'));
console.log('\nGET /old/users routing    → location', JSON.stringify(r.location), '| rewrites', r.rewrites);

const failures = [];
const users = await (await nginx.handle(new Request('http://api.example.com/api/users?id=7'))).json();
if (users.id !== '7') failures.push('JS handler should see the query param');
if (users.matchedLocation !== '/api/users') failures.push('handler ctx should have the matched location');
if ((await nginx.handle(new Request('http://api.example.com/secret/x'))).status !== 403) failures.push('deny should 403 before any JS');
const who = await (await nginx.handle(new Request('http://api.example.com/whoami', { headers: { 'user-agent': 'demo/1' } }))).json();
if (who.ua !== 'demo/1') failures.push('ctx.vars should read the real nginx $http_user_agent');
if ((await nginx.handle(new Request('http://admin.example.com/'))).status !== 403) failures.push('access handler should deny without key');
if ((await nginx.handle(new Request('http://admin.example.com/', { headers: { 'x-api-key': 'sekret' } }))).status !== 200) failures.push('access handler should allow with key');

if (failures.length) { console.error('\nFAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
console.log('\nall checks passed — code-based routing + JS handlers, all real nginx underneath');
nginx.dispose();
