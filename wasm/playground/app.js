import { Nginx } from '../js/index.js';

const $ = (id) => document.getElementById(id);

const DEFAULT_CONF = `upstream backend {
  server 10.0.0.5:8080;
}

server {
  listen 80;
  server_name api.example.com;
  root /var/www/html;

  location / {
  }

  location = /health {
    return 200 "ok\\n";
  }

  location /v1/ {
    proxy_pass http://backend;
    proxy_set_header X-Real-IP $remote_addr;
  }

  location ~* \\.php$ {
    return 403;
  }

  location /old/ {
    rewrite ^/old/(.*)$ /v1/$1 last;
  }
}`;

const FILES = {
  '/var/www/html/index.html': '<h1>hello from nginx-wasm</h1>\n',
};

let nginx = null;

async function apply() {
  const status = $('status');
  status.textContent = 'starting nginx…';
  status.className = '';
  $('apply').disabled = true;

  try {
    nginx = await Nginx.create($('conf').value, {
      files: FILES,

      upstream: async (req, target) => {
        const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.text();
        return new Response(
          JSON.stringify(
            {
              echo: 'upstream fixture',
              method: req.method,
              uri: new URL(req.url).pathname + new URL(req.url).search,
              headers: Object.fromEntries(req.headers),
              body,
              target: target.addr,
            },
            null,
            2
          ),
          { status: 200, headers: { 'content-type': 'application/json', 'x-upstream': target.addr } }
        );
      },
    });
    status.textContent = `nginx ready: listening on ${nginx.ports.join(', ')}`;
    status.className = 'ok';
  } catch (e) {
    nginx = null;
    status.textContent = 'config error';
    status.className = 'err';
    render([card('config error', pre(e.message))]);
  }
  $('apply').disabled = false;
}

async function send() {
  if (!nginx) {
    await apply();
    if (!nginx) return;
  }
  $('send').disabled = true;
  try {
    const method = $('method').value;
    const r = await nginx.route(new Request($('url').value, { method }));
    const res = r.response;
    const bodyText = res.body ? await res.clone().text() : '';

    const statusCard = document.createElement('div');
    statusCard.className = 'card';
    statusCard.innerHTML = `<h2>response</h2>`;
    const line = document.createElement('div');
    const pill = document.createElement('span');
    pill.className = `pill s${String(res.status)[0]}`;
    pill.textContent = `${res.status} ${res.statusText}`.trim();
    line.append(pill, document.createTextNode(`  ${method} ${$('url').value}`));
    statusCard.append(line);

    const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n');
    statusCard.append(pre(headers || '(no headers)'));
    if (bodyText) statusCard.append(pre(bodyText.length > 4000 ? bodyText.slice(0, 4000) + '…' : bodyText));

    const routing = document.createElement('div');
    routing.className = 'card';
    routing.innerHTML = '<h2>routing decision</h2>';
    const kv = document.createElement('div');
    kv.className = 'kv';
    const add = (k, v) => {
      const b = document.createElement('b');
      b.textContent = k;
      const s = document.createElement('span');
      s.textContent = v;
      kv.append(b, s);
    };
    add('matched location', r.location ?? '(none)');
    if (r.locationsTried.length > 1) add('locations walked', r.locationsTried.join(' → '));
    if (r.rewrites.length) add('rewrites', r.rewrites.join(' → '));
    if (r.internalRedirects.length) add('internal redirects', r.internalRedirects.join(' → '));
    add('proxied', r.proxied ? `yes → ${r.upstream ?? 'upstream'}` : 'no');
    routing.append(kv);

    const trace = document.createElement('details');
    trace.innerHTML = `<summary>nginx debug trace (${r.trace.length} lines)</summary>`;
    const interesting = r.trace.filter((l) =>
      /test location|using configuration|rewritten|internal redirect|http init upstream|connect to|script |access|finalize|header: "/.test(l)
    );
    trace.append(pre(interesting.join('\n')));
    routing.append(trace);

    render([statusCard, routing]);
  } catch (e) {
    render([card('error', pre(String(e && e.stack ? e.stack : e)))]);
  }
  $('send').disabled = false;
}

function card(title, ...children) {
  const c = document.createElement('div');
  c.className = 'card';
  const h = document.createElement('h2');
  h.textContent = title;
  c.append(h, ...children);
  return c;
}

function pre(text) {
  const p = document.createElement('pre');
  p.textContent = text;
  return p;
}

function render(cards) {
  const box = $('results');
  box.replaceChildren(...cards);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(async () => {
    await navigator.serviceWorker.ready;
    const link = document.createElement('a');
    link.href = './site/';
    link.target = '_blank';
    link.textContent = 'open served site ↗';
    link.style.cssText = 'font-size:12px;color:var(--accent)';
    $('status').after(link);
  }).catch(() => {});

  navigator.serviceWorker.addEventListener('message', async (ev) => {
    if (ev.data?.type !== 'nginx-fetch') return;
    const port = ev.ports[0];
    const fail = (status, text) =>
      port.postMessage({ status, statusText: text, headers: [['content-type', 'text/plain']], body: null });

    if (!nginx) return fail(503, 'no config applied in the playground');

    try {
      const host = nginx.config.servers.find((s) => s.name)?.name || 'localhost';
      const req = new Request(`http://${host}${ev.data.path}`, {
        method: ev.data.method,
        headers: ev.data.headers,
        body: ev.data.body,
        ...(ev.data.body ? { duplex: 'half' } : {}),
      });
      const res = await nginx.handle(req, { buffer: true });
      const body = await res.arrayBuffer();
      port.postMessage(
        { status: res.status, statusText: res.statusText, headers: [...res.headers], body },
        body.byteLength ? [body] : []
      );
    } catch (e) {
      fail(500, String(e && e.message ? e.message : e));
    }
  });
}

$('conf').value = DEFAULT_CONF;
$('apply').addEventListener('click', apply);
$('send').addEventListener('click', send);
$('url').addEventListener('keydown', (e) => e.key === 'Enter' && send());

apply();
