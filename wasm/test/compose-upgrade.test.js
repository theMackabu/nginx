import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { compose } from '../js/compose.js';

test('proxies an HTTP Upgrade handshake + tunnels bytes both ways', async () => {
  const backend = createServer();
  backend.on('upgrade', (req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `X-Echoed-Proto: ${req.headers['sec-websocket-protocol'] || ''}\r\n\r\n`
    );

    socket.on('data', (d) => socket.write(Buffer.from(d.toString().toUpperCase())));
  });
  await new Promise((r) => backend.listen(9610, '127.0.0.1', r));

  const app = compose();
  app.upstream('ws').server('127.0.0.1:9610');
  app.server().listen(80).serverName('t')
    .location('/ws')
    .proxyPass('http://ws', { http11: true, setHeader: { Upgrade: '$http_upgrade', Connection: 'upgrade' } });

  const nginx = await app.build();
  const server = await nginx.serve({ port: 8710 });

  const result = await new Promise((resolve, reject) => {
    const sock = connect(8710, '127.0.0.1');
    let raw = '';
    let upgraded = false;
    sock.setTimeout(6000, () => reject(new Error('timeout')));
    sock.on('connect', () => {
      sock.write(
        'GET /ws HTTP/1.1\r\n' +
        'Host: t\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        'Sec-WebSocket-Protocol: chat\r\n\r\n'
      );
    });
    sock.on('data', (d) => {
      raw += d.toString();
      if (!upgraded && raw.includes('\r\n\r\n')) {
        upgraded = true;
        sock.write('hello tunnel');
      } else if (upgraded && raw.includes('HELLO TUNNEL')) {
        resolve(raw);
        sock.end();
      }
    });
    sock.on('error', reject);
  });

  assert.match(result, /HTTP\/1\.1 101 Switching Protocols/);
  assert.match(result, /x-echoed-proto: chat/i);
  assert.match(result, /HELLO TUNNEL/);

  server.close();
  backend.close();
  nginx.dispose();
});
