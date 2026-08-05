import { Nginx } from './index.js';

export async function configTest(config, opts = {}) {

  const nginx = await Nginx.create(config, {
    upstream: async (req, target) =>
      new Response(JSON.stringify({ fixture: 'nginx-wasm', uri: new URL(req.url).pathname, target: target.addr }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ...opts,
  });
  return new ConfigTest(nginx);
}

export class ConfigTest {
  constructor(nginx) {
    this.nginx = nginx;
  }

  expect(spec, init = {}) {
    let request;
    if (spec instanceof Request) {
      request = spec;
    } else {
      const sp = String(spec).indexOf(' ');
      const method = sp === -1 ? 'GET' : spec.slice(0, sp);
      const url = sp === -1 ? spec : spec.slice(sp + 1);
      request = new Request(url, { method, ...init });
    }
    return new Expectation(this.nginx, request);
  }

  dispose() {
    this.nginx.dispose();
  }
}

class Expectation {
  #nginx;
  #request;
  #result = null;

  constructor(nginx, request) {
    this.#nginx = nginx;
    this.#request = request;
  }

  async #route() {
    this.#result ??= await this.#nginx.route(this.#request);
    return this.#result;
  }

  #fail(message, r) {
    const tail = r.trace
      .filter((l) => /using configuration|rewritten|internal redirect|http init upstream|connect to|finalize/.test(l))
      .slice(-12);
    const err = new Error(
      `${this.#request.method} ${this.#request.url}: ${message}` +
        (tail.length ? `\n  nginx trace:\n    ${tail.join('\n    ')}` : '')
    );
    err.route = r;
    throw err;
  }

  async toReturn(status) {
    const r = await this.#route();
    if (r.status !== status) {
      this.#fail(`expected status ${status}, got ${r.status}`, r);
    }
    return r;
  }

  async toMatchLocation(location) {
    const r = await this.#route();
    if (r.location !== location) {
      this.#fail(`expected location ${JSON.stringify(location)}, matched ${JSON.stringify(r.location)}`, r);
    }
    return r;
  }

  async toProxyTo(upstream) {
    const r = await this.#route();
    if (!r.proxied) {
      this.#fail(`expected a proxy to ${JSON.stringify(upstream)}, but the request was not proxied`, r);
    }
    const group = this.#nginx.config.upstreams[upstream];
    const ok = r.upstream === upstream || (Array.isArray(group) && group.includes(r.upstream));
    if (!ok) {
      this.#fail(`expected proxy to ${JSON.stringify(upstream)}, went to ${JSON.stringify(r.upstream)}`, r);
    }
    return r;
  }

  async toRedirectTo(url) {
    const r = await this.#route();
    const loc = r.response.headers.get('location');
    if (r.status < 300 || r.status >= 400 || loc !== url) {
      this.#fail(`expected a redirect to ${JSON.stringify(url)}, got ${r.status} ${JSON.stringify(loc)}`, r);
    }
    return r;
  }

  async toServeFile(path) {
    const r = await this.#route();
    const line = r.trace.find((l) => l.includes('http filename: "'));
    const served = line ? (line.match(/http filename: "(.*?)"/) || [])[1] : null;
    if (served !== path) {
      this.#fail(`expected file ${JSON.stringify(path)}, served ${JSON.stringify(served)}`, r);
    }
    return r;
  }

  async toRewriteTo(uri) {
    const r = await this.#route();
    if (!r.rewrites.includes(uri)) {
      this.#fail(`expected a rewrite to ${JSON.stringify(uri)}, rewrites were ${JSON.stringify(r.rewrites)}`, r);
    }
    return r;
  }
}
