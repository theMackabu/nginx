import createNginxModule from '../dist/nginx.mjs';
import VERSIONS from './version.js';

const PREFIX = '/nginxw/';
const CONF_PATH = '/nginxw/conf/nginx.conf';

const INIT_ERRORS = {
  1: 'strerror init failed',
  2: 'log init failed',
  3: 'pool creation failed',
  4: 'os init failed',
  5: 'crc32 init failed',
  6: 'module preinit failed',
  7: 'configuration failed (ngx_init_cycle)',
  8: 'process init failed',
};

function buildConf(userConf, logLevel = 'info') {
  const body = String(userConf);

  const hasHttp = /(^|\n)\s*http\s*\{/.test(body);
  const hasEvents = /(^|\n)\s*events\s*\{/.test(body);

  const before = [
    'daemon off;',
    'master_process off;',
    `error_log stderr ${logLevel};`,
    'pid logs/nginx.pid;',
  ];
  if (!hasEvents) {
    before.push('events { worker_connections 64; use select; }');
  }
  if (!hasHttp) {

    before.push('http {', 'include mime.types;', 'default_type application/octet-stream;', 'access_log off;');
  }

  const after = hasHttp ? [] : ['}'];
  const text = before.join('\n') + '\n' + body + '\n' + after.join('\n');

  return { text, lineOffset: before.length };
}

const INERT_DIRECTIVES = [
  ['sendfile', 'no kernel sendfile in wasm; file contents are copied through buffers'],
  ['worker_processes', 'single-instance engine; there is always exactly one worker'],
  ['worker_cpu_affinity', 'no processes or CPUs to pin in wasm'],
  ['worker_rlimit_nofile', 'fd limits are fixed by the sandbox'],
  ['aio', 'no async file I/O in wasm'],
  ['thread_pool', 'no threads in this build'],
  ['timer_resolution', 'timers are driven by the host event loop'],
];

function dirname(p) {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function concatBytes(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function asU8(v) {
  return v instanceof Uint8Array ? v : new Uint8Array(v);
}

const HOP_BY_HOP = /^(connection|content-length|transfer-encoding|keep-alive)$/i;

function latin1Decode(bytes) {

  let s = '';
  for (let i = 0; i < bytes.length; i += 4096) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
  }
  return s;
}

function findHeaderEnd(bytes) {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

function parseHead(bytes) {
  const text = latin1Decode(bytes);
  const lines = text.split('\r\n').filter((l) => l.length);
  const startLine = lines.shift() || '';

  const headers = new Headers();
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      headers.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
    }
  }

  return { startLine, headers };
}

class ChunkDecoder {
  #buf = new Uint8Array(0);
  done = false;

  push(bytes) {
    this.#buf = this.#buf.length ? concatBytes([this.#buf, bytes]) : bytes;
    const out = [];

    for (;;) {
      const nl = this.#findCrlf(0);
      if (nl === -1) {
        break;
      }
      const sizeLine = latin1Decode(this.#buf.subarray(0, nl));
      const size = parseInt(sizeLine.split(';')[0], 16);
      if (Number.isNaN(size)) {

        out.push(this.#buf);
        this.#buf = new Uint8Array(0);
        break;
      }
      if (size === 0) {
        this.done = true;
        this.#buf = new Uint8Array(0);
        break;
      }
      const start = nl + 2;
      if (this.#buf.length < start + size + 2) {
        break;
      }
      out.push(this.#buf.slice(start, start + size));
      this.#buf = this.#buf.slice(start + size + 2);
    }

    return out;
  }

  #findCrlf(from) {
    for (let i = from; i + 1 < this.#buf.length; i++) {
      if (this.#buf[i] === 13 && this.#buf[i + 1] === 10) {
        return i;
      }
    }
    return -1;
  }
}

function dechunkAll(bytes) {
  const d = new ChunkDecoder();
  return concatBytes(d.push(bytes));
}

function parseStatusLine(startLine) {
  const m = startLine.match(/^HTTP\/\d\.\d (\d{3}) ?(.*)$/);
  return {
    status: m ? parseInt(m[1], 10) : 0,
    statusText: m ? m[2] : '',
  };
}

export class Nginx {
  #m;
  #log = [];
  #net = null;
  #dgram = null;
  #udp = new Map();
  #upstream = null;
  #jsHandlers = new Map();
  #jsHandlerInfo = new Map();
  #handlers = new Map();
  #sockets = new Map();
  #upstreams = new Map();
  #fixtures = new Map();
  #pausedReads = new Map();
  #pumpTimer = null;
  #ipPtr = 0;

  #scratchIn = { ptr: 0, cap: 0, busy: false };
  #confPath = null;
  #confText = '';
  #lineOffset = 0;
  #logLevel = 'info';

  static versions = VERSIONS;

  static async create(config, opts = {}) {
    const nginx = new Nginx();
    nginx.#upstream = opts.upstream || null;
    if (opts.jsHandlers) {
      nginx.#jsHandlers = new Map(Object.entries(opts.jsHandlers));
    }
    if (opts.jsHandlerInfo) {
      nginx.#jsHandlerInfo = new Map(Object.entries(opts.jsHandlerInfo));
    }

    nginx.#logLevel = opts.logLevel || 'info';

    const m = await createNginxModule({
      noInitialRun: true,
      print: (s) => nginx.#logLine(s),
      printErr: (s) => nginx.#logLine(s),
    });
    nginx.#m = m;

    if (m.FS?.ErrnoError && new m.FS.ErrnoError(44).name !== 'ErrnoError') {
      const Orig = m.FS.ErrnoError;
      m.FS.ErrnoError = class ErrnoError extends Orig {
        constructor(...args) {
          super(...args);
          this.name = 'ErrnoError';
        }
      };
    }

    if (typeof process === 'object' && process?.versions?.node) {
      try {
        const net = await import('node:net');
        nginx.#net = net.default ?? net;
      } catch {
        nginx.#net = null;
      }

      try {
        const dgram = await import('node:dgram');
        nginx.#dgram = dgram.default ?? dgram;
      } catch {
        nginx.#dgram = null;
      }
    }

    m.onConnData = (fd) => nginx.#onConnData(fd);
    m.onConnClose = (fd) => nginx.#onConnClose(fd);
    m.onUpstreamConnect = (fd, ip, port) => nginx.#onUpstreamConnect(fd, ip, port);
    m.onUdpConnect = (fd, ip, port) => nginx.#onUdpConnect(fd, ip, port);
    m.onJsHandler = (id, token) => nginx.#runJsHandler(id, token, false);
    m.onJsAccess = (id, token) => nginx.#runJsHandler(id, token, true);

    m.hostsMap = { localhost: '127.0.0.1', ...(opts.hosts || {}) };

    const FS = m.FS;
    FS.mkdirTree(PREFIX + 'conf');
    FS.mkdirTree(PREFIX + 'logs');
    FS.mkdirTree(PREFIX + 'html');

    for (const [vfs, real] of Object.entries(opts.mounts || {})) {
      nginx.#mount(vfs, real);
    }

    for (const [path, content] of Object.entries(opts.files || {})) {
      FS.mkdirTree(dirname(path));
      FS.writeFile(path, typeof content === 'string' ? content : new Uint8Array(content));
    }

    let confFile = CONF_PATH;
    let confParam = '';

    if (typeof config === 'object' && config !== null && config.conf) {

      const { resolve, dirname: pdir } = await import('node:path');
      const { readFileSync } = await import('node:fs');

      confFile = resolve(config.conf);
      const confDir = pdir(confFile);
      nginx.#confPath = confFile;
      nginx.#confText = readFileSync(confFile, 'utf8');

      if (!FS.analyzePath(confDir).exists) {
        nginx.#mount(confDir, confDir);
      }

      for (const p of nginx.#confText.matchAll(/(?:^|[\s"'])(\/[\w.\-/]+)/gm)) {
        const dir = dirname(p[1]);
        if (dir !== '/' && !FS.analyzePath(dir).exists) {
          FS.mkdirTree(dir);
        }
      }

      confParam = `daemon off; master_process off; error_log stderr ${nginx.#logLevel};`;
    } else {
      const { text, lineOffset } = buildConf(config, nginx.#logLevel);
      nginx.#confText = text;
      nginx.#lineOffset = lineOffset;
      FS.writeFile(CONF_PATH, text);
    }

    const rc = m.ccall(
      'nginxw_init',
      'number',
      ['string', 'string', 'string'],
      [PREFIX, confFile, confParam]
    );
    if (rc !== 0) {
      const emerg = nginx.#log.filter((l) => /\[(emerg|alert|crit|error)\]/.test(l));
      const err = new Error(
        `nginx failed to start (${INIT_ERRORS[rc] || `code ${rc}`})` +
          (emerg.length ? ':\n' + emerg.join('\n') : '')
      );
      err.lineOffset = nginx.#lineOffset;
      throw err;
    }

    nginx.#log.length = 0;
    return nginx;
  }

  static async test(config, opts = {}) {
    let nginx = null;
    try {
      nginx = await Nginx.create(config, opts);
      return { ok: true };
    } catch (e) {
      const msg = String((e && e.message) || e);
      const emerg = msg.match(/\[emerg\] \d+#\d+: (.+)/);
      let error = emerg ? emerg[1] : msg;
      let file = null;
      let line = null;

      const loc = error.match(/ in (\/[^\s:]+):(\d+)$/);
      if (loc) {
        file = loc[1];
        line = parseInt(loc[2], 10);
        if (file === CONF_PATH) {
          line -= e.lineOffset || 0;
          file = null;
        }
      }

      return { ok: false, error, file, line };
    } finally {
      nginx?.dispose();
    }
  }

  get ports() {
    const m = this.#live();
    const out = [];
    for (let i = 0; i < m._nginxw_listen_count(); i++) {
      out.push(m._nginxw_listen_port(i));
    }
    return out;
  }

  get config() {
    const m = this.#live();
    const ptr = m._nginxw_describe();
    if (!ptr) {
      return { servers: [], upstreams: {} };
    }
    const json = m.UTF8ToString(ptr);
    m._free(ptr);
    return JSON.parse(json);
  }

  get unsupported() {
    const found = [];
    const lines = this.#confText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const [directive, note] of INERT_DIRECTIVES) {
        if (new RegExp(`^\\s*${directive}\\s`).test(lines[i])) {
          found.push({ directive, line: i + 1 - this.#lineOffset, note });
        }
      }
    }
    return found;
  }

  async reload(config) {
    const m = this.#live();

    if (config !== undefined) {
      if (this.#confPath) {
        throw new Error('this instance loads its config from disk — edit the file and call reload() with no arguments');
      }
      const { text, lineOffset } = buildConf(config, this.#logLevel);
      this.#confText = text;
      this.#lineOffset = lineOffset;
      m.FS.writeFile(CONF_PATH, text);
    } else if (this.#confPath) {
      const { readFileSync } = await import('node:fs');
      this.#confText = readFileSync(this.#confPath, 'utf8');
    }

    this.#log.length = 0;
    const rc = m._nginxw_reload();
    if (rc !== 0) {
      const emerg = this.#log.filter((l) => /\[(emerg|alert|crit|error)\]/.test(l));
      throw new Error(
        'nginx reload failed — previous configuration still active' +
          (emerg.length ? ':\n' + emerg.join('\n') : '')
      );
    }

    this.#log.length = 0;
    this.#schedule();
  }

  dispose() {
    if (!this.#m) {
      return;
    }
    clearTimeout(this.#pumpTimer);
    for (const s of this.#sockets.values()) s.destroy();
    for (const s of this.#upstreams.values()) s.destroy();
    for (const e of this.#udp.values()) { e.closed = true; e.sock.close(); }
    this.#sockets.clear();
    this.#upstreams.clear();
    this.#udp.clear();
    this.#fixtures.clear();
    this.#pausedReads.clear();
    for (const h of this.#handlers.values()) {
      h.resolveClosed?.(new Uint8Array(0));
    }
    this.#handlers.clear();
    if (this.#scratchIn.ptr) this.#m._free(this.#scratchIn.ptr);
    this.#scratchIn.ptr = 0;
    this.#scratchIn.cap = 0;
    this.#scratchIn.busy = false;

    this.#m = null;
  }

  async serve({ port, host = '127.0.0.1', nginxPort } = {}) {
    const m = this.#live();
    if (!this.#net) {
      throw new Error('serve() needs a runtime with node:net');
    }
    nginxPort ??= m._nginxw_listen_port(0);

    const server = this.#net.createServer((sock) => {
      const ip = (sock.remoteAddress || '127.0.0.1').replace(/^::ffff:/, '');
      const fd = m._nginxw_accept(...this.#cstr(nginxPort, ip, sock.remotePort || 0));
      if (fd < 0) {
        sock.destroy();
        return;
      }
      sock.setNoDelay(true);
      this.#sockets.set(fd, sock);
      sock.on('data', (b) => {
        this.#push(fd, b);
        this.#pushGuard(fd, sock);
        this.#schedule();
      });
      sock.on('end', () => {
        m._nginxw_eof(fd);
        this.#schedule();
      });
      sock.on('error', () => {
        m._nginxw_eof(fd);
        this.#schedule();
      });
      this.#schedule();
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });

    this.#schedule();
    return server;
  }

  async handle(request, opts = {}) {
    const { response } = await this.#dispatch(request, { ...opts, stream: !opts.buffer });
    return response;
  }

  async route(request, opts = {}) {
    const { response, trace } = await this.#dispatch(request, { ...opts, stream: false, trace: true });

    const locations = trace
      .map((l) => l.match(/using configuration "(.*)"$/))
      .filter(Boolean)
      .map((m) => m[1]);

    const internalRedirects = trace
      .map((l) => l.match(/internal redirect: "(.*?)\?/))
      .filter(Boolean)
      .map((m) => m[1]);

    const rewrites = trace
      .map((l) => l.match(/rewritten data: "(.*?)"/))
      .filter(Boolean)
      .map((m) => m[1]);

    const upstreamLine = trace.find((l) => l.includes('connect to '));
    const upstream = upstreamLine
      ? (upstreamLine.match(/connect to ([^ ,]+)/) || [])[1]
      : null;

    return {
      status: response.status,
      location: locations.length ? locations[locations.length - 1] : null,
      locationsTried: locations,
      internalRedirects,
      rewrites,
      proxied: trace.some((l) => l.includes('http init upstream')),
      upstream,
      response,
      trace,
    };
  }

  get _module() {
    return this.#m;
  }

  #live() {
    if (!this.#m) {
      throw new Error('this Nginx instance has been disposed');
    }
    return this.#m;
  }

  #logLine(s) {
    if (typeof process === 'object' && process?.env?.NGXW_DEBUG) {
      console.error('[nginx]', s);
    }
    this.#log.push(s);
    if (this.#log.length > 8192) {
      this.#log.splice(0, 4096);
    }
  }

  #mount(vfs, real) {
    const m = this.#m;
    const NODEFS = m.FS.filesystems && m.FS.filesystems.NODEFS;
    if (!NODEFS || !this.#net) {
      throw new Error('mounts need a node-compat runtime; use `files` in browsers');
    }
    if (!m.FS.analyzePath(vfs).exists) {
      m.FS.mkdirTree(vfs);
    }
    m.FS.mount(NODEFS, { root: real }, vfs);
  }

  #cstr(port, ip, cport) {
    const m = this.#m;
    if (!this.#ipPtr) {
      this.#ipPtr = m._malloc(64);
    }
    const bytes = new TextEncoder().encode(ip.slice(0, 45) + '\0');
    m.HEAPU8.set(bytes, this.#ipPtr);
    return [port, this.#ipPtr, cport];
  }

  #grabScratch(slot, len) {
    const m = this.#m;
    const RETAIN_MAX = 1 << 20;
    if (slot.busy || len > RETAIN_MAX) {
      return { ptr: m._malloc(len || 1), owned: true };
    }
    if (len > slot.cap) {
      if (slot.ptr) m._free(slot.ptr);
      slot.cap = Math.max(len, 4096, slot.cap * 2);
      slot.ptr = m._malloc(slot.cap);
    }
    slot.busy = true;
    return { ptr: slot.ptr, owned: false };
  }

  #dropScratch(slot, grab) {
    if (grab.owned) this.#m._free(grab.ptr);
    else slot.busy = false;
  }

  #push(fd, bytes) {
    const m = this.#m;
    if (!m) {
      return;
    }
    const g = this.#grabScratch(this.#scratchIn, bytes.length);
    try {
      if (bytes.length) m.HEAPU8.set(bytes, g.ptr);
      m._nginxw_push(fd, g.ptr, bytes.length);
    } finally {
      this.#dropScratch(this.#scratchIn, g);
    }
  }

  #pull(fd) {
    const m = this.#m;
    if (!m) {
      return null;
    }
    const size = m._nginxw_out_size(fd);
    if (size <= 0) {
      return null;
    }

    const ptr = m._nginxw_out_take(fd);
    return m.HEAPU8.slice(ptr, ptr + size);
  }

  #onConnData(fd) {
    if (!this.#m) {
      return;
    }
    const fx = this.#fixtures.get(fd);
    if (fx) {
      const bytes = this.#pull(fd);
      if (bytes && bytes.length) {
        fx.chunks.push(bytes);
        this.#fixtureTry(fd, fx);
      }
      return;
    }

    const h = this.#handlers.get(fd);
    if (h) {

      if (h.stream && h.headersDone && h.controller && h.controller.desiredSize <= 0) {
        return;
      }
      const bytes = this.#pull(fd);
      if (bytes && bytes.length) {
        this.#dispatchData(fd, h, bytes);
      }

      if (!h.closed && this.#m) {
        queueMicrotask(() => {
          if (!h.closed && this.#m) {
            const more = this.#pull(fd);
            if (more && more.length) {
              this.#dispatchData(fd, h, more);
            }
            if (!h.closed) {
              this.#m._nginxw_writable(fd);
            }
          }
        });
      }
      return;
    }

    const udp = this.#udp.get(fd);
    if (udp) {

      const bytes = this.#pull(fd);
      if (bytes && bytes.length && !udp.closed) {
        udp.sock.send(bytes, udp.port, udp.ip);
      }
      return;
    }

    const sock = this.#sockets.get(fd) || this.#upstreams.get(fd);
    if (sock) {
      this.#sockWrite(fd, sock);
    }
  }

  #withHeapBytes(bytes, fn) {
    const m = this.#m;
    const g = this.#grabScratch(this.#scratchIn, bytes.length);
    try {
      if (bytes.length) m.HEAPU8.set(bytes, g.ptr);
      return fn(g.ptr, bytes.length);
    } finally {
      this.#dropScratch(this.#scratchIn, g);
    }
  }

  #readRequest(token) {
    const m = this.#m;
    const readStr = (ptr) => {
      if (!ptr) return '';
      const s = m.UTF8ToString(ptr);
      m._free(ptr);
      return s;
    };

    const method = readStr(m._nginxw_req_method(token)) || 'GET';
    const uri = readStr(m._nginxw_req_uri(token)) || '/';
    const headers = new Headers();
    for (const line of readStr(m._nginxw_req_headers(token)).split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) {
        try { headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim()); } catch {}
      }
    }
    const host = headers.get('host') || 'localhost';

    let body = null;
    const blen = m._nginxw_req_body_len(token);
    if (blen > 0) {
      const ptr = m._malloc(blen);
      const n = m._nginxw_req_body_copy(token, ptr, blen);
      body = m.HEAPU8.slice(ptr, ptr + n);
      m._free(ptr);
    }

    const request = new Request(`http://${host}${uri}`, {
      method, headers, body, ...(body ? { duplex: 'half' } : {}),
    });

    const readVar = (name) =>
      this.#m
        ? readStr(this.#m.ccall('nginxw_req_var', 'number', ['number', 'string'], [token, name]))
        : '';

    return { request, readVar };
  }

  #failHandler(token, access, status) {
    if (!this.#m) return;
    if (access) this.#m._nginxw_js_access_finish(token, status);
    else this.#m._nginxw_js_fail(token, status);
    this.#schedule();
  }

  #buildCtx(id, readVar) {
    const info = this.#jsHandlerInfo.get(id) || {};
    const params = {};
    for (const name of info.params || []) {
      params[name] = readVar('p_' + name);
    }
    let remoteAddr;
    return {

      get remoteAddr() {
        if (remoteAddr === undefined) remoteAddr = readVar('remote_addr') || null;
        return remoteAddr;
      },
      location: info.location ?? null,
      params,
      vars: (name) => readVar(name) || null,
    };
  }

  #serializeResponseHeaders(res) {
    let hb = '';
    for (const [k, v] of res.headers) {
      if (k.toLowerCase() === 'set-cookie' || HOP_BY_HOP.test(k)) continue;
      hb += `${k}: ${v}\r\n`;
    }
    const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of cookies) hb += `Set-Cookie: ${c}\r\n`;
    return hb;
  }

  #sendChunk(token, value) {
    return this.#withHeapBytes(asU8(value), (ptr, len) => {
      const buffered = this.#m._nginxw_js_send_chunk(token, ptr, len);
      this.#schedule();
      return buffered;
    });
  }

  #runJsHandler(id, token, access) {
    queueMicrotask(() => {
      const m = this.#m;
      if (!m) {
        return;
      }
      const fn = this.#jsHandlers.get(id);
      if (!fn) {

        this.#failHandler(token, access, access ? 500 : 404);
        return;
      }

      const { request, readVar } = this.#readRequest(token);
      const ctx = this.#buildCtx(id, readVar);

      Promise.resolve()
        .then(() => fn(request, ctx))
        .then(async (res) => {
          if (!this.#m) return;
          if (!(res instanceof Response)) {
            res = new Response(res == null ? '' : String(res));
          }

          if (access) {
            m._nginxw_js_access_finish(token, res.status || 200);
            this.#schedule();
            return;
          }

          const hb = this.#serializeResponseHeaders(res);
          const finish = (bytes) =>
            this.#withHeapBytes(bytes, (ptr, len) => {
              m.ccall('nginxw_js_finish', 'number',
                ['number', 'number', 'string', 'number', 'number'],
                [token, res.status, hb, ptr, len]);
              this.#schedule();
            });

          const reader = res.body && res.body.getReader ? res.body.getReader() : null;
          if (!reader) {
            finish(new Uint8Array(0));
            return;
          }

          const first = await reader.read();
          if (!this.#m) return;
          if (first.done) {
            finish(new Uint8Array(0));
            return;
          }
          const second = await reader.read();
          if (!this.#m) return;
          if (second.done) {
            finish(asU8(first.value));
            return;
          }

          if (m.ccall('nginxw_js_send_head', 'number', ['number', 'number', 'string'], [token, res.status, hb]) !== 0) {
            return;
          }
          let buffered = this.#sendChunk(token, first.value);
          buffered = this.#sendChunk(token, second.value) || buffered;
          for (;;) {

            if (buffered) await new Promise((r) => (globalThis.setImmediate || setTimeout)(r, 0));
            const { done, value } = await reader.read();
            if (done || !this.#m) break;
            buffered = this.#sendChunk(token, value);
          }
          if (this.#m) {
            m._nginxw_js_send_end(token);
            this.#schedule();
          }
        })
        .catch(() => {
          this.#failHandler(token, access, 500);
        });
    });
  }

  #onUdpConnect(fd, ip, port) {
    const m = this.#m;
    if (!this.#dgram) {
      queueMicrotask(() => { this.#m?._nginxw_conn_error(fd, 0); this.#schedule(); });
      return;
    }
    const sock = this.#dgram.createSocket(ip.includes(':') ? 'udp6' : 'udp4');
    const entry = { sock, ip, port, closed: false };
    this.#udp.set(fd, entry);
    sock.on('message', (msg) => {
      if (!this.#m) return;
      const ptr = m._malloc(msg.length || 1);
      m.HEAPU8.set(msg, ptr);
      m._nginxw_push_dgram(fd, ptr, msg.length);
      m._free(ptr);
      this.#schedule();
    });
    sock.on('error', () => {
      if (this.#udp.has(fd)) { this.#m?._nginxw_conn_error(fd, 0); this.#schedule(); }
    });
  }

  #sockWrite(fd, sock) {
    if (!this.#m || sock.destroyed || sock.ngxwPaused) {
      return;
    }
    const bytes = this.#pull(fd);
    if (!bytes || !bytes.length) {
      return;
    }
    if (!sock.write(bytes)) {
      sock.ngxwPaused = true;
      sock.once('drain', () => {
        sock.ngxwPaused = false;
        this.#sockWrite(fd, sock);
        this.#m?._nginxw_writable(fd);
        this.#schedule();
      });
    }
  }

  #pushGuard(fd, sock) {
    if (!this.#m) {
      return;
    }
    if (this.#m._nginxw_in_size(fd) > 1 << 20) {
      sock.pause();
      this.#pausedReads.set(fd, sock);
    }
  }

  #resumeReads() {
    if (!this.#m) {
      return;
    }
    for (const [fd, sock] of this.#pausedReads) {
      if (sock.destroyed) {
        this.#pausedReads.delete(fd);
        continue;
      }
      if (this.#m._nginxw_in_size(fd) < 256 * 1024) {
        this.#pausedReads.delete(fd);
        sock.resume();
      }
    }

    for (const [fd, sock] of this.#sockets) {
      this.#sweepSock(fd, sock);
    }
    for (const [fd, sock] of this.#upstreams) {
      this.#sweepSock(fd, sock);
    }
  }

  #sweepSock(fd, sock) {
    if (!this.#m || sock.destroyed) {
      return;
    }
    if (sock.ngxwPaused && !sock.writableNeedDrain) {
      sock.ngxwPaused = false;
    }
    if (!sock.ngxwPaused) {
      this.#sockWrite(fd, sock);
      this.#m._nginxw_writable(fd);
    }
  }

  #onConnClose(fd) {
    const h = this.#handlers.get(fd);
    if (h) {
      this.#handlers.delete(fd);

      const rest = this.#pull(fd);
      if (rest && rest.length) {
        if (h.stream && h.headersDone) {
          this.#enqueue(h, rest);
        } else {
          h.chunks.push(rest);
        }
      }

      queueMicrotask(() => {
        h.closed = true;
        if (h.controller) {
          try {
            h.controller.close();
          } catch {}
        }
        h.resolveHead(null);
        h.resolveClosed(concatBytes(h.chunks));
      });
    }

    this.#fixtures.delete(fd);
    this.#pausedReads.delete(fd);

    const sock = this.#sockets.get(fd);
    if (sock) {
      this.#sockets.delete(fd);

      const rest = this.#pull(fd);
      if (rest && rest.length && !sock.destroyed) {
        sock.write(rest);
      }
      sock.end();
    }
    const up = this.#upstreams.get(fd);
    if (up) {
      this.#upstreams.delete(fd);
      up.destroy();
    }
    const udp = this.#udp.get(fd);
    if (udp) {
      this.#udp.delete(fd);
      udp.closed = true;
      udp.sock.close();
    }
  }

  #onUpstreamConnect(fd, ip, port) {
    const m = this.#m;

    if (this.#upstream) {
      this.#fixtures.set(fd, { chunks: [], ip, port, dispatched: false });
      queueMicrotask(() => {
        if (this.#fixtures.has(fd)) {
          m._nginxw_conn_ready(fd);
          this.#schedule();
        }
      });
      return;
    }

    if (!this.#net) {
      queueMicrotask(() => {
        m._nginxw_conn_error(fd, 0);
        this.#schedule();
      });
      return;
    }

    const sock = this.#net.connect({ host: ip, port });
    this.#upstreams.set(fd, sock);
    sock.setNoDelay(true);
    sock.on('connect', () => {
      m._nginxw_conn_ready(fd);
      this.#schedule();
    });
    sock.on('data', (b) => {
      this.#push(fd, b);
      this.#pushGuard(fd, sock);
      this.#schedule();
    });
    sock.on('end', () => {
      m._nginxw_eof(fd);
      this.#schedule();
    });
    sock.on('error', () => {
      if (this.#upstreams.has(fd)) {
        m._nginxw_conn_error(fd, 0);
        this.#schedule();
      }
    });
  }

  #fixtureTry(fd, fx) {
    if (fx.dispatched) {
      return;
    }

    const all = concatBytes(fx.chunks);
    const sep = findHeaderEnd(all);
    if (sep === -1) {
      return;
    }

    const { startLine, headers } = parseHead(all.subarray(0, sep));
    const contentLength = parseInt(headers.get('content-length') || '0', 10);
    if (all.length < sep + 4 + contentLength) {
      return;
    }

    fx.dispatched = true;
    const m = this.#m;

    const [method, uri] = startLine.split(' ');
    const host = headers.get('host') || `${fx.ip}:${fx.port}`;
    const body = contentLength > 0 ? all.subarray(sep + 4, sep + 4 + contentLength) : null;

    headers.delete('connection');
    headers.delete('content-length');

    const request = new Request(`http://${host}${uri}`, {
      method,
      headers,
      body,
      ...(body ? { duplex: 'half' } : {}),
    });

    const target = {
      host: fx.ip,
      port: fx.port,
      addr: `${fx.ip}:${fx.port}`,
    };

    Promise.resolve()
      .then(() => this.#upstream(request, target))
      .then(async (res) => {

        if (res == null) {
          this.#fixtureFallthrough(fd, fx);
          return;
        }
        if (!(res instanceof Response)) {
          throw new Error('upstream handler must return a Response or null');
        }
        const resBody = new Uint8Array(await res.arrayBuffer());
        let head = `HTTP/1.1 ${res.status} ${res.statusText || 'OK'}\r\n`;
        for (const [k, v] of res.headers) {
          if (k.toLowerCase() === 'set-cookie' || HOP_BY_HOP.test(k)) continue;
          head += `${k}: ${v}\r\n`;
        }
        for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
          head += `Set-Cookie: ${c}\r\n`;
        }
        head += `Content-Length: ${resBody.length}\r\nConnection: close\r\n\r\n`;

        const headBytes = new TextEncoder().encode(head);
        this.#push(fd, concatBytes([headBytes, resBody]));
        m._nginxw_eof(fd);
        this.#schedule();
      })
      .catch(() => {
        m._nginxw_conn_error(fd, 0);
        this.#schedule();
      });
  }

  #fixtureFallthrough(fd, fx) {
    const m = this.#m;
    this.#fixtures.delete(fd);

    if (!this.#net) {
      m._nginxw_conn_error(fd, 0);
      this.#schedule();
      return;
    }

    const pending = concatBytes(fx.chunks);
    const sock = this.#net.connect({ host: fx.ip, port: fx.port });
    this.#upstreams.set(fd, sock);
    sock.setNoDelay(true);
    sock.on('connect', () => {
      sock.write(pending);
      this.#schedule();
    });
    sock.on('data', (b) => {
      this.#push(fd, b);
      this.#pushGuard(fd, sock);
      this.#schedule();
    });
    sock.on('end', () => {
      m._nginxw_eof(fd);
      this.#schedule();
    });
    sock.on('error', () => {
      if (this.#upstreams.has(fd)) {
        m._nginxw_conn_error(fd, 0);
        this.#schedule();
      }
    });
  }

  #dispatchData(fd, h, bytes) {

    if (!h.stream || !h.headersDone) {
      h.chunks.push(bytes);
    }

    if (!h.stream) {

      h.received = (h.received || 0) + bytes.length;
      if (!h.closed && this.#bufferedComplete(h, bytes)) {
        h.closed = true;
        const out = concatBytes(h.chunks);
        this.#handlers.delete(fd);
        queueMicrotask(() => {
          h.resolveHead(null);
          h.resolveClosed(out);
        });
      }
      return;
    }

    if (h.closed) {
      return;
    }

    if (!h.headersDone) {
      const all = concatBytes(h.chunks);
      const sep = findHeaderEnd(all);
      if (sep === -1) {
        return;
      }
      h.headersDone = true;

      const headBytes = all.subarray(0, sep);
      const { headers } = parseHead(headBytes);
      if ((headers.get('transfer-encoding') || '').includes('chunked')) {
        h.decoder = new ChunkDecoder();
      } else {

        const cl = headers.get('content-length');
        h.remaining = cl != null ? parseInt(cl, 10) : null;
      }

      const rest = all.subarray(sep + 4).slice();
      h.chunks = [];
      const body = new ReadableStream(
        {
          start(controller) {
            h.controller = controller;
          },
          pull: () => {

            const bytes = this.#pull(h.fd);
            if (bytes && bytes.length) {
              this.#enqueue(h, bytes);
            }
            queueMicrotask(() => {
              if (this.#m && !h.closed) {
                this.#m._nginxw_writable(h.fd);
                this.#schedule();
              }
            });
          },
          cancel: () => {
            h.controller = null;
          },
        },
        typeof ByteLengthQueuingStrategy !== 'undefined'
          ? new ByteLengthQueuingStrategy({ highWaterMark: 1 << 20 })
          : undefined
      );

      h.resolveHead({ headBytes, body });
      if (rest.length) {
        this.#enqueue(h, rest);
      }
      return;
    }

    this.#enqueue(h, bytes);
  }

  #bufferedComplete(h, lastChunk) {
    if (!h.head) {
      const all = concatBytes(h.chunks);
      const sep = findHeaderEnd(all);
      if (sep === -1) {
        return false;
      }
      const { startLine, headers } = parseHead(all.subarray(0, sep));
      const { status } = parseStatusLine(startLine);
      if (status && status < 200) {
        return false;
      }
      const te = headers.get('transfer-encoding') || '';
      h.head = {
        bodyStart: sep + 4,
        noBody: h.method === 'HEAD' || status === 204 || status === 304,
        chunked: te.includes('chunked'),
        cl: headers.get('content-length'),
        tail: new Uint8Array(0),
      };
    }

    const head = h.head;
    if (head.noBody) {
      return true;
    }
    if (head.chunked) {

      let tail;
      if (lastChunk.length >= 7) {
        tail = lastChunk.subarray(lastChunk.length - 7);
      } else {
        const merged = head.tail.length ? concatBytes([head.tail, lastChunk]) : lastChunk;
        tail = merged.length > 7 ? merged.subarray(merged.length - 7) : merged;
      }
      head.tail = tail;
      return /(^|\r\n)0\r\n\r\n$/.test(latin1Decode(tail));
    }
    if (head.cl != null) {
      return h.received - head.bodyStart >= parseInt(head.cl, 10);
    }
    return false;
  }

  #enqueue(h, bytes) {
    if (!h.controller) {
      return;
    }
    try {
      if (h.decoder) {
        for (const part of h.decoder.push(bytes)) {
          h.controller.enqueue(part);
        }
        if (h.decoder.done) {
          h.controller.close();
          h.controller = null;
        }
      } else {
        h.controller.enqueue(bytes);
        if (h.remaining != null) {
          h.remaining -= bytes.length;
          if (h.remaining <= 0) {
            h.controller.close();
            h.controller = null;
            h.closed = true;
            this.#handlers.delete(h.fd);
          }
        }
      }
    } catch {}
  }

  #pump = () => {
    if (!this.#m) {
      return;
    }
    const next = this.#m._nginxw_tick();
    this.#resumeReads();
    const delay = next < 0 ? 1000 : Math.max(1, Math.min(next, 1000));
    this.#pumpTimer = setTimeout(this.#pump, delay);
    this.#pumpTimer.unref?.();
  };

  #schedule() {
    clearTimeout(this.#pumpTimer);
    this.#pumpTimer = setTimeout(this.#pump, 0);
    this.#pumpTimer.unref?.();
  }

  async #dispatch(request, opts = {}) {
    const m = this.#live();
    const url = new URL(request.url);
    const port = url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
    const wantStream = !!opts.stream && typeof ReadableStream !== 'undefined';
    const streamRequest = !!opts.streamRequest && !!request.body;

    let head = `${request.method} ${url.pathname}${url.search} HTTP/1.1\r\n`;
    head += `Host: ${url.host}\r\n`;
    for (const [k, v] of request.headers) {
      if (!/^(host|connection|content-length|transfer-encoding)$/i.test(k)) {
        head += `${k}: ${v}\r\n`;
      }
    }

    let body = null;
    if (streamRequest) {
      head += 'Transfer-Encoding: chunked\r\n';
    } else if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
      body = new Uint8Array(await request.arrayBuffer());
      head += `Content-Length: ${body.length}\r\n`;
    }
    head += 'Connection: close\r\n\r\n';

    const headBytes = new TextEncoder().encode(head);
    const raw = body ? concatBytes([headBytes, body]) : headBytes;

    this.#log.length = 0;

    const fd = m._nginxw_accept(...this.#cstr(port, opts.clientAddress || '127.0.0.1', 49152));
    if (fd < 0) {
      throw new Error(`nginx accept failed (code ${fd})`);
    }

    if (opts.trace) {
      m._nginxw_debug_conn(fd);
    }

    const h = {
      fd,
      method: request.method,
      stream: wantStream,
      chunks: [],
      headersDone: false,
      closed: false,
      controller: null,
      resolveHead: null,
      resolveClosed: null,
    };
    const headReady = new Promise((r) => (h.resolveHead = r));
    const closed = new Promise((r) => (h.resolveClosed = r));
    this.#handlers.set(fd, h);

    this.#push(fd, raw);
    this.#schedule();

    if (streamRequest) {
      (async () => {
        const enc = new TextEncoder();
        const reader = request.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          this.#push(fd, concatBytes([
            enc.encode(chunk.length.toString(16) + '\r\n'),
            chunk,
            enc.encode('\r\n'),
          ]));
          this.#schedule();
        }
        this.#push(fd, enc.encode('0\r\n\r\n'));
        this.#schedule();
      })().catch(() => {});
    }

    const timeoutMs = opts.timeout ?? 30000;

    const buildTrace = () =>
      this.#log
        .map((l) => l.replace(/^.*\[debug\] \d+#\d+: (\*\d+ )?/, ''))
        .filter((l) => l.length);

    const makeResponse = (headerBytes, bodySource) => {
      const { startLine, headers } = parseHead(headerBytes);
      const { status, statusText } = parseStatusLine(startLine);
      if (status < 200) {
        throw new Error(
          `nginx produced no complete response within ${timeoutMs}ms — ` +
            'if this request proxies to an unreachable upstream, lower ' +
            'proxy_connect_timeout, raise { timeout }, or use an upstream fixture'
        );
      }
      const canHaveBody =
        request.method !== 'HEAD' && status >= 200 && status !== 204 && status !== 304;

      const chunked = (headers.get('transfer-encoding') || '').includes('chunked');
      if (chunked) {
        headers.delete('transfer-encoding');
        if (bodySource instanceof Uint8Array) {
          bodySource = dechunkAll(bodySource);
        }
      }

      return new Response(canHaveBody && bodySource ? bodySource : null, {
        status,
        statusText,
        headers,
      });
    };

    if (wantStream) {
      const first = await this.#withTimeout(headReady, timeoutMs, fd);

      if (first) {

        return { response: makeResponse(first.headBytes, first.body), trace: buildTrace() };
      }

    }

    const out = await this.#withTimeout(closed, timeoutMs, fd)
      ?? concatBytes(h.chunks);

    const sep = findHeaderEnd(out);
    const headerBytes = sep === -1 ? out : out.subarray(0, sep);
    const bodyBytes = sep === -1 ? new Uint8Array(0) : out.subarray(sep + 4);

    return {
      response: makeResponse(headerBytes, bodyBytes.length ? bodyBytes : null),
      trace: buildTrace(),
      raw: out,
    };
  }

  async #withTimeout(promise, ms, fd) {

    let timer;
    const result = await Promise.race([
      promise,
      new Promise((r) => {
        timer = setTimeout(() => {
          this.#handlers.delete(fd);
          r(undefined);
        }, ms);
      }),
    ]);
    clearTimeout(timer);
    return result;
  }
}

export default Nginx;
