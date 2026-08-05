import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Nginx } from '../js/index.js';

test('mounts are live passthrough, not snapshots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ngxw-'));
  writeFileSync(join(dir, 'a.txt'), 'first');

  const nginx = await Nginx.create(
    'server { listen 80; root /srv; }',
    { mounts: { '/srv': dir } }
  );

  assert.equal(await (await nginx.handle(new Request('http://x/a.txt'))).text(), 'first');

  writeFileSync(join(dir, 'a.txt'), 'second, longer');
  assert.equal(await (await nginx.handle(new Request('http://x/a.txt'))).text(), 'second, longer');

  writeFileSync(join(dir, 'b.txt'), 'brand new');
  assert.equal((await nginx.handle(new Request('http://x/b.txt'))).status, 200);
  nginx.dispose();
});

test('{ conf: path } loads a real nginx.conf with relative includes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ngxw-conf-'));
  mkdirSync(join(dir, 'conf.d'));
  mkdirSync(join(dir, 'html'));
  writeFileSync(join(dir, 'html', 'index.html'), 'real tree\n');
  writeFileSync(
    join(dir, 'conf.d', 'site.conf'),
    `server { listen 80; root ${join(dir, 'html')}; location = /ping { return 200 "pong"; } }\n`
  );
  writeFileSync(
    join(dir, 'nginx.conf'),
    [
      'worker_processes 2;',
      `error_log ${join(dir, 'err.log')};`,
      'events { worker_connections 32; use select; }',
      `http { access_log off; include ${join(dir, 'conf.d', '*.conf')}; }`,
      '',
    ].join('\n')
  );

  const nginx = await Nginx.create({ conf: join(dir, 'nginx.conf') });

  assert.equal(await (await nginx.handle(new Request('http://x/ping'))).text(), 'pong');
  assert.equal(await (await nginx.handle(new Request('http://x/index.html'))).text(), 'real tree\n');

  writeFileSync(
    join(dir, 'conf.d', 'site.conf'),
    `server { listen 80; location = /ping { return 200 "pong2"; } }\n`
  );
  await nginx.reload();
  assert.equal(await (await nginx.handle(new Request('http://x/ping'))).text(), 'pong2');

  assert.ok(nginx.unsupported.some((d) => d.directive === 'worker_processes'));
  nginx.dispose();
});
