import { Nginx, CreateOptions } from './index.js';

export interface HandlerContext {
  remoteAddr: string | null;
  location: string | null;
  params: Record<string, string | null>;
  vars(name: string): string | null;
}

export type Handler = (request: Request, ctx: HandlerContext) => Response | Promise<Response>;

export interface LocationBuilder {
  raw(line: string): this;
  return(status: number, body?: string): this;
  root(path: string): this;
  alias(path: string): this;
  index(...files: string[]): this;
  tryFiles(...args: string[]): this;
  internal(): this;
  expires(value: string): this;
  rewrite(pattern: string | RegExp, replacement: string, flag?: 'last' | 'break' | 'redirect' | 'permanent'): this;
  proxyPass(url: string, opts?: { http11?: boolean; setHeader?: Record<string, string> }): this;
  addHeader(name: string, value: string, always?: boolean): this;
  setHeader(name: string, value: string): this;
  errorPage(codes: number | number[], uri: string): this;
  allow(cidr: string): this;
  deny(cidr?: string): this;
  limitReq(zone: string, opts?: { burst?: number; nodelay?: boolean }): this;
  limitConn(zone: string, n: number): this;
  handle(fn: Handler): this;
  location(matcher: string | RegExp): LocationBuilder;
}

export interface ServerBuilder {
  raw(line: string): this;
  listen(port: number, opts?: { ssl?: boolean; http2?: boolean }): this;
  serverName(...names: string[]): this;
  root(path: string): this;
  index(...files: string[]): this;
  cert(certPath: string, keyPath: string): this;
  errorPage(codes: number | number[], uri: string): this;
  addHeader(name: string, value: string, always?: boolean): this;
  gzip(opts?: { minLength?: number; types?: string[] }): this;
  location(matcher: string | RegExp): LocationBuilder;
  get(path: string, fn: Handler): this;
  post(path: string, fn: Handler): this;
  put(path: string, fn: Handler): this;
  delete(path: string, fn: Handler): this;
  patch(path: string, fn: Handler): this;
  all(path: string, fn: Handler): this;
  use(fn: Handler): this;
}

export interface UpstreamBuilder {
  server(addr: string, opts?: { weight?: number; maxFails?: number; backup?: boolean }): this;
  method(m: 'least_conn' | 'ip_hash' | 'random' | string): this;
  keepalive(n: number): this;
}

export interface App {
  server(): ServerBuilder;
  upstream(name: string): UpstreamBuilder;
  http(line: string): this;
  map(source: string, mapping: Record<string, string>, into: string): this;
  limitReqZone(name: string, opts: { key?: string; size?: string; rate: string }): this;
  limitConnZone(name: string, opts?: { key?: string; size?: string }): this;
  toConf(): string;
  build(opts?: CreateOptions): Promise<Nginx>;
}

export function compose(): App;
export default compose;
