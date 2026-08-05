import { createServer } from 'node:http';
import { Nginx } from '../js/index.js';

const backend = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ via: 'backend', path: req.url, got: req.headers['x-forwarded-by'] || null }));
});

await new Promise((r) => backend.listen(9090, '127.0.0.1', r));
const nginx = await Nginx.create(
  `
  upstream backend {
    server 127.0.0.1:9090;
  }

  server {
    listen 80;
    root /var/www/html;

    location / {
    }

    location = /health {
      return 200 "ok\\n";
    }

    location /v1/ {
      proxy_pass http://backend;
      proxy_set_header X-Forwarded-By nginx-wasm;
    }
  }
`,
  {
    mounts: { '/var/www/html': new URL('./public', import.meta.url).pathname },
  }
);

const server = await nginx.serve({ port: 8080 });
console.log('nginx-wasm listening on http://127.0.0.1:8080 (nginx port 80)');

const staticRes = await fetch('http://127.0.0.1:8080/index.html');
console.log('GET /index.html →', staticRes.status,
  '| server:', staticRes.headers.get('server'),
  '| body:', JSON.stringify(await staticRes.text()));

const health = await fetch('http://127.0.0.1:8080/health');
console.log('GET /health     →', health.status, JSON.stringify(await health.text()));

const proxied = await fetch('http://127.0.0.1:8080/v1/users?id=3');
const proxiedBody = await proxied.json();
console.log('GET /v1/users   →', proxied.status, '| proxied body:', proxiedBody);

const missing = await fetch('http://127.0.0.1:8080/nope');
console.log('GET /nope       →', missing.status);

server.close();
backend.close();

const failures = [];
if (staticRes.status !== 200) failures.push('static over TCP should be 200');
if ((staticRes.headers.get('server') || '').indexOf('nginx') !== 0) failures.push('Server header should be nginx');
if (health.status !== 200) failures.push('/health should be 200');
if (proxied.status !== 200) failures.push('proxied request should be 200');
if (proxiedBody.via !== 'backend') failures.push('proxy should reach the real backend');
if (proxiedBody.got !== 'nginx-wasm') failures.push('proxy_set_header should reach backend');
if (proxiedBody.path !== '/v1/users?id=3') failures.push('URI should pass through');
if (missing.status !== 404) failures.push('missing file should be 404');

if (failures.length) {
  console.error('\nFAILURES:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('\nall checks passed — real nginx served real sockets and proxied to a real backend, from inside WebAssembly');
