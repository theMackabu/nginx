const SCOPE_PATH = new URL(self.registration.scope).pathname;
const SITE = SCOPE_PATH + 'site/';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith(SITE)) {
    e.respondWith(viaNginx(e.request));
  }
});

async function viaNginx(request) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const tab = clients.find((c) => {
    const p = new URL(c.url).pathname;
    return p.startsWith(SCOPE_PATH) && !p.startsWith(SITE);
  });

  if (!tab) {
    return new Response('open the nginx-wasm playground tab first', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
    });
  }

  const url = new URL(request.url);
  const body =
    request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer();

  const { port1, port2 } = new MessageChannel();
  const reply = new Promise((resolve) => {
    port1.onmessage = (ev) => resolve(ev.data);
    setTimeout(() => resolve(null), 15000);
  });

  tab.postMessage(
    {
      type: 'nginx-fetch',
      path: url.pathname.slice(SITE.length - 1) + url.search,
      method: request.method,
      headers: [...request.headers],
      body,
    },
    body ? [port2, body] : [port2]
  );

  const r = await reply;
  if (!r) {
    return new Response('nginx-wasm tab did not answer', {
      status: 504,
      headers: { 'content-type': 'text/plain' },
    });
  }

  const canHaveBody = r.status >= 200 && r.status !== 204 && r.status !== 304;
  return new Response(canHaveBody ? r.body : null, {
    status: r.status,
    statusText: r.statusText,
    headers: r.headers,
  });
}
