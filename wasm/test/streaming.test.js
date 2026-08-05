import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Nginx } from '../js/index.js';

test('responses stream as nginx produces them', async () => {
  const backend = createServer((req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.write('part1|');
    setTimeout(() => {
      res.write('part2|');
      setTimeout(() => res.end('part3'), 100);
    }, 100);
  });
  await new Promise((r) => backend.listen(9293, '127.0.0.1', r));

  const nginx = await Nginx.create(
    'server { listen 80; location /s/ { proxy_pass http://127.0.0.1:9293/; proxy_buffering off; } }'
  );

  const t0 = Date.now();
  const res = await nginx.handle(new Request('http://x/s/go'));
  const reader = res.body.getReader();
  const arrivals = [];
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString();
    arrivals.push(Date.now() - t0);
  }

  assert.equal(res.status, 200);
  assert.equal(text, 'part1|part2|part3');
  assert.ok(arrivals.length >= 2, `expected multiple chunks, got ${arrivals.length}`);
  assert.ok(arrivals[0] < 80, `first chunk should arrive before the backend finishes (${arrivals[0]}ms)`);

  nginx.dispose();
  backend.close();
});

test('buffer: true waits for the whole response', async () => {
  const nginx = await Nginx.create('server { listen 80; location / { return 200 "whole"; } }');
  const res = await nginx.handle(new Request('http://x/'), { buffer: true });
  assert.equal(await res.text(), 'whole');
  nginx.dispose();
});

test('streaming request bodies go out as chunked encoding', async () => {
  let echoed = null;
  const nginx = await Nginx.create(
    'upstream b { server 127.0.0.1:1; } server { listen 80; location /e { proxy_pass http://b; } }',
    { upstream: async (req) => { echoed = await req.text(); return new Response('ok'); } }
  );

  const body = new ReadableStream({
    async start(c) {
      for (const s of ['alpha-', 'beta-', 'gamma']) {
        c.enqueue(new TextEncoder().encode(s));
        await new Promise((r) => setTimeout(r, 20));
      }
      c.close();
    },
  });

  const res = await nginx.handle(
    new Request('http://x/e', { method: 'POST', body, duplex: 'half' }),
    { streamRequest: true }
  );
  assert.equal(res.status, 200);
  assert.equal(echoed, 'alpha-beta-gamma');
  nginx.dispose();
});
