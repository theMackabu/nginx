import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { Nginx } from '../js/index.js';

function dnsServer(port) {
  const sock = createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    let i = 12;
    while (msg[i] !== 0) i += msg[i] + 1;
    i += 5;
    const question = msg.subarray(12, i);
    const h = Buffer.alloc(12);
    msg.copy(h, 0, 0, 2);
    h.writeUInt16BE(0x8180, 2);
    h.writeUInt16BE(1, 4);
    h.writeUInt16BE(1, 6);
    const ans = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0x1e, 0, 4, 127, 0, 0, 1]);
    sock.send(Buffer.concat([h, question, ans]), rinfo.port, rinfo.address);
  });
  return new Promise((res) => sock.bind(port, '127.0.0.1', () => res(sock)));
}

test('runtime resolver over UDP: proxy_pass to a DNS-resolved host', async () => {
  const DNS_PORT = 15354;

  const dnsQueries = [];
  const dns = await dnsServer(DNS_PORT);
  dns.on('message', () => dnsQueries.push(1));

  const backend = createServer((req, res) => res.end('reached ' + req.headers.host));
  await new Promise((r) => backend.listen(9500, '127.0.0.1', r));

  const nginx = await Nginx.create(`
    server {
      listen 80;
      resolver 127.0.0.1:${DNS_PORT} valid=1s ipv6=off;
      location / {
        set $backend "backend.test";
        proxy_pass http://$backend:9500;
      }
    }
  `);

  const res = await nginx.handle(new Request('http://x/thing'), { buffer: true, timeout: 10000 });
  const body = await res.text();

  backend.close();
  dns.close();
  nginx.dispose();

  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  assert.match(body, /^reached backend\.test:9500/);
  assert.ok(dnsQueries.length >= 1, 'nginx should have sent a DNS query over UDP');
});
