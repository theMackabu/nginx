import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { Nginx } from '../js/index.js';

const BIG = Buffer.alloc(4 * 1024 * 1024);
for (let i = 0; i < BIG.length; i++) BIG[i] = (i * 31 + (i >> 8)) & 0xff;

test('handle(): slow stream consumer gets the whole body intact', async () => {
  const nginx = await Nginx.create(
    'server { listen 80; root /www; }',
    { files: { '/www/big.bin': new Uint8Array(BIG) } }
  );

  const res = await nginx.handle(new Request('http://x/big.bin'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(BIG.length));

  const reader = res.body.getReader();
  let total = 0;
  let checksum = 0;
  let reads = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    for (const b of value) checksum = (checksum + b) & 0xffffffff;
    reads++;
    if (reads % 8 === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  let expect = 0;
  for (const b of BIG) expect = (expect + b) & 0xffffffff;

  assert.equal(total, BIG.length);
  assert.equal(checksum, expect);
  nginx.dispose();
});

test('serve(): slow TCP client + fast flooding backend', async () => {
  const backend = createServer((req, res) => {
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', String(BIG.length));
    res.end(BIG);
  });
  await new Promise((r) => backend.listen(9495, '127.0.0.1', r));

  const nginx = await Nginx.create(
    'server { listen 80; location /big { proxy_pass http://127.0.0.1:9495/; } }'
  );
  const server = await nginx.serve({ port: 8486 });

  const received = await new Promise((resolve, reject) => {
    const sock = connect(8486, '127.0.0.1');
    let bytes = 0;
    let body = false;
    let bodyBytes = 0;
    sock.setTimeout(60000, () => reject(new Error('stalled')));
    sock.on('connect', () => sock.write('GET /big HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    sock.on('data', (b) => {
      bytes += b.length;
      if (!body) {
        const i = b.indexOf('\r\n\r\n');
        if (i !== -1) {
          body = true;
          bodyBytes += b.length - i - 4;
        }
      } else {
        bodyBytes += b.length;
      }

      sock.pause();
      setTimeout(() => sock.resume(), 2);
    });
    sock.on('end', () => resolve(bodyBytes));
    sock.on('error', reject);
  });

  assert.equal(received, BIG.length);

  server.close();
  backend.close();
  nginx.dispose();
});
