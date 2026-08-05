import { Nginx } from './index.js';

function quote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function normalizeMatcher(m) {
  if (m instanceof RegExp) {
    return { modifier: m.flags.includes('i') ? '~*' : '~', pattern: m.source };
  }
  const s = String(m).trim();
  const mm = s.match(/^(=|~\*|~|\^~)\s+(.*)$/);
  if (mm) {
    return { modifier: mm[1], pattern: mm[2] };
  }
  return { modifier: '', pattern: s };
}

const PARAM_PREFIX = 'p_';

function escapeRegexLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parsePathParams(path) {

  const params = [];
  let regex = '';
  let last = 0;
  for (const m of path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
    regex += escapeRegexLiteral(path.slice(last, m.index));
    if (params.includes(m[1])) {
      throw new Error(`duplicate route param ":${m[1]}" in "${path}"`);
    }
    params.push(m[1]);
    regex += `(?<${PARAM_PREFIX}${m[1]}>[^/]+)`;
    last = m.index + m[0].length;
  }
  regex += escapeRegexLiteral(path.slice(last));
  return { hasParams: params.length > 0, regex: '^' + regex + '$', params };
}

class LocationBuilder {
  constructor(app, matcher) {
    this.app = app;
    this.match = normalizeMatcher(matcher);
    this.directives = [];
    this.inner = [];
  }

  raw(line) { this.directives.push(line); return this; }

  return(status, body) {
    return this.raw(body === undefined ? `return ${status};` : `return ${status} ${quote(body)};`);
  }
  root(path) { return this.raw(`root ${path};`); }
  alias(path) { return this.raw(`alias ${path};`); }
  index(...files) { return this.raw(`index ${files.join(' ')};`); }
  tryFiles(...args) { return this.raw(`try_files ${args.join(' ')};`); }
  internal() { return this.raw('internal;'); }
  expires(value) { return this.raw(`expires ${value};`); }

  rewrite(pattern, replacement, flag) {
    const re = pattern instanceof RegExp ? pattern.source : pattern;
    return this.raw(`rewrite ${re} ${replacement}${flag ? ' ' + flag : ''};`);
  }

  proxyPass(url, opts = {}) {
    this.raw(`proxy_pass ${url};`);
    if (opts.http11) this.raw('proxy_http_version 1.1;');
    for (const [k, v] of Object.entries(opts.setHeader || {})) {
      this.raw(`proxy_set_header ${k} ${quote(v)};`);
    }
    return this;
  }

  addHeader(name, value, always) {
    return this.raw(`add_header ${name} ${quote(value)}${always ? ' always' : ''};`);
  }

  setHeader(name, value) { return this.addHeader(name, value); }

  errorPage(codes, uri) {
    return this.raw(`error_page ${[].concat(codes).join(' ')} ${uri};`);
  }

  allow(cidr) { return this.raw(`allow ${cidr};`); }
  deny(cidr = 'all') { return this.raw(`deny ${cidr};`); }

  limitReq(zone, opts = {}) {
    let d = `limit_req zone=${zone}`;
    if (opts.burst != null) d += ` burst=${opts.burst}`;
    if (opts.nodelay) d += ' nodelay';
    return this.raw(d + ';');
  }
  limitConn(zone, n) { return this.raw(`limit_conn ${zone} ${n};`); }

  handle(fn, info = {}) {
    const id = this.app._registerHandler('h', fn, { location: this.match.pattern || '/', ...info });
    this.raw(`wasm_js_content ${id};`);
    return this;
  }

  location(matcher) {
    const loc = new LocationBuilder(this.app, matcher);
    this.inner.push(loc);
    return loc;
  }

  _render(indent) {
    const pad = '  '.repeat(indent);
    const head = ['location', this.match.modifier, this.match.pattern].filter(Boolean).join(' ');
    const lines = [`${pad}${head} {`];
    for (const d of this.directives) lines.push(`${pad}  ${d}`);
    for (const inner of this.inner) lines.push(inner._render(indent + 1));
    lines.push(`${pad}}`);
    return lines.join('\n');
  }
}

class ServerBuilder {
  constructor(app) {
    this.app = app;
    this.directives = [];
    this.locations = [];
    this.routes = new Map();
    this.materialized = false;
  }

  raw(line) { this.directives.push(line); return this; }

  listen(port, opts = {}) {
    let d = `listen ${port}`;
    if (opts.ssl) d += ' ssl';
    this.raw(d + ';');
    if (opts.http2) this.raw('http2 on;');
    return this;
  }

  serverName(...names) { return this.raw(`server_name ${names.join(' ')};`); }
  root(path) { return this.raw(`root ${path};`); }
  index(...files) { return this.raw(`index ${files.join(' ')};`); }
  cert(certPath, keyPath) {
    return this.raw(`ssl_certificate ${certPath};`).raw(`ssl_certificate_key ${keyPath};`);
  }
  errorPage(codes, uri) { return this.raw(`error_page ${[].concat(codes).join(' ')} ${uri};`); }
  addHeader(name, value, always) {
    return this.raw(`add_header ${name} ${quote(value)}${always ? ' always' : ''};`);
  }

  gzip(opts = {}) {
    this.raw('gzip on;');
    if (opts.minLength != null) this.raw(`gzip_min_length ${opts.minLength};`);
    if (opts.types) this.raw(`gzip_types ${opts.types.join(' ')};`);
    return this;
  }

  location(matcher) {
    const loc = new LocationBuilder(this.app, matcher);
    this.locations.push(loc);
    return loc;
  }

  #route(verb, path, fn) {
    let route = this.routes.get(path);
    if (!route) {
      route = { params: parsePathParams(path), methods: new Map() };
      this.routes.set(path, route);
    }
    route.methods.set(verb, fn);
    return this;
  }
  get(path, fn) { return this.#route('GET', path, fn); }
  post(path, fn) { return this.#route('POST', path, fn); }
  put(path, fn) { return this.#route('PUT', path, fn); }
  delete(path, fn) { return this.#route('DELETE', path, fn); }
  patch(path, fn) { return this.#route('PATCH', path, fn); }
  all(path, fn) { return this.#route('*', path, fn); }

  use(fn) {
    const id = this.app._registerHandler('a', fn);
    this.raw(`wasm_js_access ${id};`);
    return this;
  }

  _materialize() {
    if (this.materialized) return;
    this.materialized = true;

    for (const [path, route] of this.routes) {
      const methods = route.methods;
      const allow = [...methods.keys()].filter((v) => v !== '*').join(', ');
      const dispatch = async (req, ctx) => {
        const fn = methods.get(req.method) || methods.get('*');
        if (!fn) {
          return new Response(null, { status: 405, headers: { allow } });
        }
        return fn(req, ctx);
      };

      const { hasParams, regex, params } = route.params;
      const loc = new LocationBuilder(this.app, path);
      loc.match = hasParams ? { modifier: '~', pattern: regex } : normalizeMatcher(path);

      loc.handle(dispatch, { params, location: path });
      this.locations.push(loc);
    }
  }

  _render() {
    this._materialize();
    const lines = ['  server {'];
    for (const d of this.directives) lines.push(`    ${d}`);
    for (const loc of this.locations) lines.push(loc._render(2));
    lines.push('  }');
    return lines.join('\n');
  }
}

class UpstreamBuilder {
  constructor(name) {
    this.name = name;
    this.directives = [];
  }
  server(addr, opts = {}) {
    let d = `server ${addr}`;
    if (opts.weight != null) d += ` weight=${opts.weight}`;
    if (opts.maxFails != null) d += ` max_fails=${opts.maxFails}`;
    if (opts.backup) d += ' backup';
    this.directives.push(d + ';');
    return this;
  }
  method(m) { this.directives.unshift(`${m};`); return this; }
  keepalive(n) { this.directives.push(`keepalive ${n};`); return this; }
  _render() {
    return `  upstream ${this.name} {\n${this.directives.map((d) => '    ' + d).join('\n')}\n  }`;
  }
}

class App {
  constructor() {
    this.servers = [];
    this.upstreams = [];
    this.httpDirectives = [];
    this.handlers = {};
    this.handlerInfo = {};
    this.seq = 0;
  }

  server() {
    const s = new ServerBuilder(this);
    this.servers.push(s);
    return s;
  }

  upstream(name) {
    const u = new UpstreamBuilder(name);
    this.upstreams.push(u);
    return u;
  }

  http(line) { this.httpDirectives.push(line); return this; }

  limitReqZone(name, { key = '$binary_remote_addr', size = '1m', rate }) {
    this.httpDirectives.push(`limit_req_zone ${key} zone=${name}:${size} rate=${rate};`);
    return this;
  }
  limitConnZone(name, { key = '$binary_remote_addr', size = '1m' }) {
    this.httpDirectives.push(`limit_conn_zone ${key} zone=${name}:${size};`);
    return this;
  }

  map(source, mapping, into) {
    const lines = [`map ${source} ${into} {`];
    for (const [k, v] of Object.entries(mapping)) {
      lines.push(`    ${k} ${quote(v)};`);
    }
    lines.push('  }');
    this.httpDirectives.push(lines.join('\n  '));
    return this;
  }

  _registerHandler(prefix, fn, info = {}) {
    const id = prefix + (this.seq++).toString(36);
    this.handlers[id] = fn;
    this.handlerInfo[id] = info;
    return id;
  }

  _materialize() {
    for (const s of this.servers) s._materialize();
  }

  toConf() {
    this._materialize();
    const lines = [];
    for (const d of this.httpDirectives) lines.push('  ' + d);
    for (const u of this.upstreams) lines.push(u._render());
    for (const s of this.servers) lines.push(s._render());
    return `http {\n  include mime.types;\n  default_type application/octet-stream;\n  access_log off;\n${lines.join('\n')}\n}`;
  }

  async build(opts = {}) {
    return Nginx.create(this.toConf(), {
      ...opts,
      jsHandlers: this.handlers,
      jsHandlerInfo: this.handlerInfo,
    });
  }
}

export function compose() {
  return new App();
}

export default compose;
