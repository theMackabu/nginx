export interface CreateOptions {
  mounts?: Record<string, string>;
  files?: Record<string, string | Uint8Array | ArrayBuffer>;
  hosts?: Record<string, string>;
  logLevel?: 'debug' | 'info' | 'notice' | 'warn' | 'error' | 'crit';
  upstream?: (request: Request, target: UpstreamTarget) => Response | Promise<Response>;
}

export interface UpstreamTarget {
  host: string;
  port: number;
  addr: string;
}

export interface DispatchOptions {
  clientAddress?: string;
  timeout?: number;
  buffer?: boolean;
  streamRequest?: boolean;
}

export interface RouteResult {
  status: number;
  location: string | null;
  locationsTried: string[];
  internalRedirects: string[];
  rewrites: string[];
  proxied: boolean;
  upstream: string | null;
  response: Response;
  trace: string[];
}

export interface ConfigDescription {
  servers: Array<{ name: string }>;
  upstreams: Record<string, string[]>;
}

export interface TestResult {
  ok: boolean;
  error?: string;
  file?: string | null;
  line?: number | null;
}

export interface UnsupportedDirective {
  directive: string;
  line: number;
  note: string;
}

export type ConfigInput = string | { conf: string };

export class Nginx {
  static versions: Record<string, string>;
  static create(config: ConfigInput, opts?: CreateOptions): Promise<Nginx>;
  static test(config: ConfigInput, opts?: CreateOptions): Promise<TestResult>;
  handle(request: Request, opts?: DispatchOptions): Promise<Response>;
  route(request: Request, opts?: DispatchOptions): Promise<RouteResult>;
  serve(opts?: { port?: number; host?: string; nginxPort?: number }): Promise<import('node:net').Server>;
  reload(config?: ConfigInput extends { conf: string } ? never : string): Promise<void>;
  readonly ports: number[];
  readonly config: ConfigDescription;
  readonly unsupported: UnsupportedDirective[];
  dispose(): void;
}

export default Nginx;
