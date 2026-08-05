import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Nginx } from '../js/index.js';

test('limit_req: nodelay rejects the burst overflow', async () => {
  const nginx = await Nginx.create(`
    limit_req_zone $binary_remote_addr zone=z:1m rate=5r/s;
    server {
      listen 80;
      root /www;
      location = /t.txt { limit_req zone=z burst=2 nodelay; }
    }
  `, { files: { '/www/t.txt': 'hit' } });

  const results = [];
  for (let i = 0; i < 6; i++) {
    const res = await nginx.handle(new Request('http://x/t.txt'), { buffer: true });
    results.push(res.status);
  }

  assert.deepEqual(results.slice(0, 3), [200, 200, 200]);
  assert.ok(results.slice(3).every((s) => s === 503), `tail should be 503s: ${results}`);
  nginx.dispose();
});

test('limit_req: delayed requests are released by the timer pump', async () => {
  const nginx = await Nginx.create(`
    limit_req_zone $binary_remote_addr zone=d:1m rate=10r/s;
    server {
      listen 80;
      root /www;
      location = /t.txt { limit_req zone=d burst=3; }
    }
  `, { files: { '/www/t.txt': 'hit' } });

  const t0 = Date.now();
  const timings = await Promise.all(
    Array.from({ length: 4 }, () =>
      nginx.handle(new Request('http://x/t.txt'), { buffer: true }).then((r) => ({
        status: r.status,
        at: Date.now() - t0,
      }))
    )
  );

  const ok = timings.filter((t) => t.status === 200);
  assert.equal(ok.length, 4, `all should eventually pass: ${JSON.stringify(timings)}`);

  const last = Math.max(...ok.map((t) => t.at));
  const first = Math.min(...ok.map((t) => t.at));
  assert.ok(first < 80, `first should be immediate (${first}ms)`);
  assert.ok(last >= 200, `last should be timer-delayed (${last}ms)`);
  nginx.dispose();
});

test('limit_conn: concurrent connections beyond the cap get 503', async () => {
  let release;
  const gate = new Promise((r) => (release = r));

  const nginx = await Nginx.create(
    `
    limit_conn_zone $binary_remote_addr zone=c:1m;
    upstream u { server 10.0.0.1:1; }
    server {
      listen 80;
      location = /slow { limit_conn c 1; proxy_pass http://u; }
    }
  `,
    {
      upstream: async () => {
        await gate;
        return new Response('slow done');
      },
    }
  );

  const first = nginx.handle(new Request('http://x/slow'), { buffer: true });
  await new Promise((r) => setTimeout(r, 50));

  const second = await nginx.handle(new Request('http://x/slow'), { buffer: true });
  assert.equal(second.status, 503, 'second concurrent request should be rejected');

  release();
  const r1 = await first;
  assert.equal(r1.status, 200);
  assert.equal(await r1.text(), 'slow done');
  nginx.dispose();
});
