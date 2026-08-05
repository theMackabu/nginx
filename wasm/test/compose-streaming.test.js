import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { compose } from '../js/compose.js';

function streamOf(chunks, delayMs = 0) {
  return new ReadableStream({
    async start(controller) {
      for (const c of chunks) {
        controller.enqueue(typeof c === 'string' ? new TextEncoder().encode(c) : c);
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
      controller.close();
    },
  });
}

test('single-chunk responses stay buffered (Content-Length)', async () => {
  const app = compose();
  app.server().listen(80).serverName('t').location('/s').handle(() => new Response('just one'));
  const nginx = await app.build();
  const r = await nginx.handle(new Request('http://t/s'), { buffer: true });
  assert.equal(r.headers.get('content-length'), '8');
  assert.equal(await r.text(), 'just one');
  nginx.dispose();
});

test('multi-chunk stream is delivered whole', async () => {
  const app = compose();
  app.server().listen(80).serverName('t')
    .location('/stream').handle(() => new Response(streamOf(['part1-', 'part2-', 'part3'])));
  const nginx = await app.build();
  const r = await nginx.handle(new Request('http://t/stream'), { buffer: true });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'part1-part2-part3');
  nginx.dispose();
});

test('streamed response arrives incrementally (not all at once)', async () => {
  const app = compose();
  app.server().listen(80).serverName('t')
    .location('/sse').handle(() =>
      new Response(streamOf(['a', 'b', 'c', 'd'], 40), { headers: { 'content-type': 'text/event-stream' } })
    );
  const nginx = await app.build();

  const t0 = Date.now();
  const res = await nginx.handle(new Request('http://t/sse'));
  const reader = res.body.getReader();
  const arrivals = [];
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString();
    arrivals.push(Date.now() - t0);
  }
  assert.equal(text, 'abcd');
  assert.ok(arrivals.length >= 2, `expected multiple chunks, got ${arrivals.length}`);
  assert.ok(arrivals[arrivals.length - 1] - arrivals[0] >= 60, 'chunks should be spread over time');
  nginx.dispose();
});

test('large generated stream (many chunks) is intact', async () => {
  const chunks = Array.from({ length: 500 }, (_, i) => `chunk${i};`);
  const expected = chunks.join('');
  const app = compose();
  app.server().listen(80).serverName('t')
    .location('/big').handle(() => new Response(streamOf(chunks)));
  const nginx = await app.build();
  const r = await nginx.handle(new Request('http://t/big'), { buffer: true });
  assert.equal(await r.text(), expected);
  nginx.dispose();
});

test('SSE over real TCP with serve()', async () => {
  const app = compose();
  app.server().listen(80).serverName('t')
    .location('/events').handle(() => {
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          async start(c) {
            for (let i = 0; i < 3; i++) {
              c.enqueue(enc.encode(`data: event ${i}\n\n`));
              await new Promise((r) => setTimeout(r, 30));
            }
            c.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      );
    });
  const nginx = await app.build();
  const server = await nginx.serve({ port: 8709 });

  const body = await new Promise((resolve, reject) => {
    const sock = connect(8709, '127.0.0.1');
    let raw = '';
    sock.setTimeout(6000, () => reject(new Error('timeout')));
    sock.on('connect', () => sock.write('GET /events HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n'));
    sock.on('data', (d) => (raw += d));
    sock.on('end', () => resolve(raw));
    sock.on('error', reject);
  });

  assert.match(body, /content-type: text\/event-stream/i);
  for (let i = 0; i < 3; i++) assert.match(body, new RegExp(`data: event ${i}`));

  server.close();
  nginx.dispose();
});
