import { compose } from '../js/compose.js';
import { Nginx } from '../js/index.js';

const PORT = parseInt(process.argv[2] || '8080', 10);

const items = new Map();
let nextId = 1;

const app = compose();
app.limitReqZone('api', { rate: '50r/s' });

const srv = app.server();
srv.listen(80).serverName('localhost').root('/var/www/html').gzip({ minLength: 256 });

srv.location('= /health').return(200, 'ok\n');

srv.location('/api/items').handle(async (req) => {
  if (req.method === 'POST') {
    const value = await req.json();
    const id = nextId++;
    items.set(id, value);
    return Response.json({ id, ...value }, { status: 201 });
  }
  return Response.json([...items.entries()].map(([id, value]) => ({ id, ...value })));
});

srv.location('/whoami')
  .limitReq('api', { burst: 10, nodelay: true })
  .handle((req, ctx) =>
    Response.json({
      ip: ctx.remoteAddr,
      method: req.method,
      path: new URL(req.url).pathname,
      userAgent: ctx.vars('http_user_agent'),
    })
  );

srv.location('/').index('index.html');

const nginx = await app.build({
  mounts: { '/var/www/html': new URL('./public', import.meta.url).pathname },
  logLevel: 'warn',
});

const server = await nginx.serve({ port: PORT });

console.log(`
  nginx-wasm ${Nginx.versions.nginx} — composed routing on http://127.0.0.1:${PORT}

    curl http://127.0.0.1:${PORT}/health
    curl http://127.0.0.1:${PORT}/whoami
    curl -X POST http://127.0.0.1:${PORT}/api/items -d '{"name":"widget"}'
    curl http://127.0.0.1:${PORT}/api/items

  routing and every phase run in real nginx; the /api and /whoami handlers are JS.
  Ctrl-C to stop.
`);

process.on('SIGINT', () => {
  server.close();
  nginx.dispose();
  process.exit(0);
});
