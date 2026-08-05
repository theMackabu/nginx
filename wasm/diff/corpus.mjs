export const cases = [
  {
    name: 'location precedence: exact vs prefix vs regex',
    conf: (root) => `
      server {
        listen {{LISTEN}};
        root ${root};
        location = /a { return 201 "exact"; }
        location /a { return 202 "prefix"; }
        location ~ ^/a2$ { return 203 "regex"; }
        location /a2 { return 204 "prefix2"; }
      }`,
    requests: ['GET /a', 'GET /a/', 'GET /a2', 'GET /a2x'],
  },
  {
    name: '^~ prefix beats regex',
    conf: (root) => `
      server {
        listen {{LISTEN}};
        root ${root};
        location ^~ /static/ { return 210 "caret"; }
        location ~ \\.png$ { return 211 "regex"; }
      }`,
    requests: ['GET /static/x.png', 'GET /other/x.png'],
  },
  {
    name: 'longest prefix wins; nested locations',
    conf: (root) => `
      server {
        listen {{LISTEN}};
        root ${root};
        location /api/ {
          return 220 "api";
        }
        location /api/v2/ {
          location /api/v2/deep/ { return 222 "deep"; }
          return 221 "v2";
        }
      }`,
    requests: ['GET /api/x', 'GET /api/v2/x', 'GET /api/v2/deep/x'],
  },
  {
    name: 'rewrite: last vs break vs redirect',
    conf: (root) => `
      server {
        listen {{LISTEN}};
        root ${root};
        location /old/ { rewrite ^/old/(.*)$ /new/$1 last; }
        location /brk/ { rewrite ^/brk/(.*)$ /files/$1 break; }
        location /go/  { rewrite ^/go/(.*)$ /new/$1 redirect; }
        location /new/ { return 230 "new"; }
        location /files/ { return 231 "files"; }
      }`,
    requests: ['GET /old/x', 'GET /brk/f.txt', 'GET /go/y'],
  },
  {
    name: 'return redirects and Location',
    conf: (root) => `
      server {
        listen {{LISTEN}};
        root ${root};
        location /301 { return 301 /moved-here; }
        location /302abs { return 302 https://example.com/x; }
        location /307 { return 307 /kept; }
      }`,
    requests: ['GET /301', 'GET /302abs', 'POST /307'],
  },
  {
    name: 'try_files chain',
    conf: (root) => `
      server {
        listen {{LISTEN}};
        root ${root};
        location / { try_files $uri $uri/ /fallback.html; }
      }`,
    files: { 'exists.html': 'the real file\n', 'fallback.html': 'fell back\n', 'dir/index.html': 'dir index\n' },
    requests: ['GET /exists.html', 'GET /missing.html', 'GET /dir/'],
  },
  {
    name: 'static files, index, directory redirect',
    conf: (root) => `
      server {
        listen {{LISTEN}};
        root ${root};
        index index.html;
      }`,
    files: { 'index.html': '<h1>root index</h1>\n', 'sub/index.html': 'sub index\n', 'plain.txt': 'plain text\n' },
    requests: ['GET /', 'GET /plain.txt', 'GET /sub', 'GET /sub/', 'HEAD /plain.txt'],
  },
  {
    name: 'error_page',
    conf: (root) => `
      server {
        listen {{LISTEN}};
        root ${root};
        error_page 404 /custom404.html;
        error_page 403 =200 /soft403.html;
        location /deny/ { deny all; }
      }`,
    files: { 'custom404.html': 'custom not found\n', 'soft403.html': 'soft denial\n' },
    requests: ['GET /nope', 'GET /deny/x'],
  },
  {
    name: 'access control',
    conf: (root) => `
      server {
        listen {{LISTEN}};
        root ${root};
        location /open/ { allow all; return 240 "open"; }
        location /shut/ { allow 10.0.0.0/8; deny all; return 241 "shut"; }
      }`,
    requests: ['GET /open/x', 'GET /shut/x'],
  },
  {
    name: 'headers: add_header, expires, types',
    conf: (root) => `
      server {
        listen {{LISTEN}};
        root ${root};
        location /h/ {
          add_header X-Custom "v1";
          add_header Cache-Control "public";
          expires 1h;
          return 200 "with headers";
        }
        location /t.css { default_type text/css; return 200 "body{}"; }
      }`,
    requests: ['GET /h/x', 'GET /t.css'],
  },
  {
    name: 'if + map',
    conf: (root) => `
      map $arg_kind $kind_text {
        default "plain";
        beta    "beta-kind";
        ~^x     "x-kind";
      }
      server {
        listen {{LISTEN}};
        root ${root};
        location /m { return 250 "mapped: $kind_text"; }
        location /i {
          if ($arg_go = "yes") { return 253 "went"; }
          return 254 "stayed";
        }
      }`,
    requests: ['GET /m', 'GET /m?kind=beta', 'GET /m?kind=xray', 'GET /i?go=yes', 'GET /i?go=no'],
  },
  {
    name: 'URI normalization',
    conf: (root) => `
      server {
        listen {{LISTEN}};
        root ${root};
        location /a/ { return 260 "a"; }
        location /b/ { return 261 "b"; }
      }`,
    files: {},
    requests: ['GET /a//x', 'GET /a/./x', 'GET /a/../b/x', 'GET /%61/x', 'GET /a/%2e%2e/b/x'],
  },
  {
    name: 'gzip',
    conf: (root) => `
      server {
        listen {{LISTEN}};
        root ${root};
        gzip on;
        gzip_min_length 10;
        gzip_types text/plain;
      }`,
    files: { 'big.txt': 'the quick brown fox jumps over the lazy dog. '.repeat(64) },
    requests: [
      'GET /big.txt',
      { method: 'GET', path: '/big.txt', headers: { 'Accept-Encoding': 'gzip' } },
    ],
  },
  {
    name: 'ssl config parses + routes identically (plaintext probe)',
    conf: (root) => `
      server {
        listen {{LISTEN}};
        server_name plain.test;
        root ${root};
        location = /p { return 270 "plain"; }
      }`,
    requests: ['GET /p'],
  },
  {
    name: 'proxy_pass 502 on unreachable upstream',
    conf: (root) => `
      upstream dead { server 127.0.0.1:9; }
      server {
        listen {{LISTEN}};
        root ${root};
        location /p/ { proxy_pass http://dead; proxy_connect_timeout 500ms; }
      }`,
    requests: ['GET /p/x'],
  },
];
