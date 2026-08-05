import { Nginx } from '../js/index.js';

const nginx = await Nginx.create(
  `
  upstream backend {
    server 127.0.0.1:8080;
  }

  server {
    listen 80;
    server_name api.example.com;
    root /var/www/html;

    gzip on;
    gzip_min_length 10;

    location / {
    }

    location /v1/ {
      proxy_pass http://backend;
    }

    location /secret/ {
      deny all;
    }

    location = /health {
      return 200 "ok\\n";
    }

    location ~* \\.php$ {
      return 403;
    }

    location /old/ {
      rewrite ^/old/(.*)$ /v1/$1 last;
    }
  }
`,
  {
    mounts: {
      '/var/www/html': new URL('./public', import.meta.url).pathname,
    },
  }
);

const res = await nginx.handle(new Request('http://api.example.com/index.html'));
console.log('GET /index.html      →', res.status, res.headers.get('content-type'));
console.log('  server header      →', res.headers.get('server'));
console.log('  body               →', JSON.stringify(await res.text()));

const denied = await nginx.handle(new Request('http://api.example.com/secret/keys.txt'));
console.log('GET /secret/keys.txt →', denied.status);

const r = await nginx.route(new Request('http://api.example.com/v1/users?id=3'));
console.log('GET /v1/users?id=3   → location', JSON.stringify(r.location),
  '| proxied:', r.proxied, '| upstream:', r.upstream, '| status:', r.status);

const idx = await nginx.route(new Request('http://api.example.com/'));
console.log('GET /                → location', JSON.stringify(idx.location),
  '| internal redirects:', idx.internalRedirects, '| status:', idx.status);

const missing = await nginx.handle(new Request('http://api.example.com/nope'));
console.log('GET /nope            →', missing.status);

const health = await nginx.handle(new Request('http://api.example.com/health'));
console.log('GET /health          →', health.status, JSON.stringify(await health.text()));

const php = await nginx.handle(new Request('http://api.example.com/admin/Index.PHP'));
console.log('GET /admin/Index.PHP →', php.status, '(location ~* \\.php$)');

const rw = await nginx.route(new Request('http://api.example.com/old/users'));
console.log('GET /old/users       → location', JSON.stringify(rw.location),
  '| rewrites:', rw.rewrites, '| upstream:', rw.upstream);

const gz = await nginx.handle(
  new Request('http://api.example.com/index.html', { headers: { 'Accept-Encoding': 'gzip' } })
);
console.log('GET /index.html (gz) → content-encoding:', gz.headers.get('content-encoding'));

const failures = [];
if (health.status !== 200) failures.push('return 200 should work (rewrite module)');
if (php.status !== 403) failures.push('regex location should match .PHP (PCRE2)');
if (rw.location !== '/v1/' || !rw.rewrites.includes('/v1/users')) failures.push('rewrite last should land in /v1/');
if (gz.headers.get('content-encoding') !== 'gzip') failures.push('gzip should compress (zlib)');
if (res.status !== 200) failures.push('static file should be 200');
if (denied.status !== 403) failures.push('deny all should be 403');
if (r.location !== '/v1/') failures.push('routing should match location /v1/');
if (!r.proxied) failures.push('/v1/ should be a proxy decision');
if (missing.status !== 404) failures.push('missing file should be 404');

if (failures.length) {
  console.error('\nFAILURES:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('\nall checks passed — this was real nginx (' +
  (res.headers.get('server') || 'nginx') + ') running under Ant via WebAssembly');
