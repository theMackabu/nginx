import { createServer } from 'node:http';
import { Nginx } from '../js/index.js';

const PORT = parseInt(process.argv[2] || '8080', 10);

const backend = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ via: 'demo backend', path: req.url, at: new Date().toISOString() }));
});
await new Promise((r) => backend.listen(0, '127.0.0.1', r));
const backendPort = backend.address().port;

const nginx = await Nginx.create(
  `
  upstream backend {
    server 127.0.0.1:${backendPort};
    keepalive 4;
  }

  server {
    listen 80;
    root /var/www/html;
    index index.html;

    gzip on;
    gzip_min_length 256;

    location / {
    }

    location = /health {
      return 200 "ok\\n";
    }

    location /v1/ {
      proxy_pass http://backend;
      proxy_http_version 1.1;
      proxy_set_header Connection "";
      proxy_set_header X-Served-By nginx-wasm;
    }
  }
`,
  {
    mounts: { '/var/www/html': new URL('./public', import.meta.url).pathname },
    logLevel: 'warn',
  }
);

const server = await nginx.serve({ port: PORT });

console.log(`
  nginx-wasm ${Nginx.versions.nginx} serving on http://127.0.0.1:${PORT}

    curl http://127.0.0.1:${PORT}/                 static index (live from wasm/examples/public/)
    curl http://127.0.0.1:${PORT}/health           return 200 "ok"
    curl http://127.0.0.1:${PORT}/v1/anything      proxied to the demo backend :${backendPort}
    curl -H 'Accept-Encoding: gzip' -sD- http://127.0.0.1:${PORT}/ -o /dev/null

  files are served live — edit wasm/examples/public/index.html and refresh.
  Ctrl-C to stop.
`);

process.on('SIGINT', () => {
  console.log('\nshutting down');
  server.close();
  backend.close();
  nginx.dispose();
  process.exit(0);
});
