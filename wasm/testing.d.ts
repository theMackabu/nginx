import { Nginx, ConfigInput, CreateOptions, RouteResult } from './index.js';

export function configTest(config: ConfigInput, opts?: CreateOptions): Promise<ConfigTest>;

export class ConfigTest {
  nginx: Nginx;
  expect(spec: string | Request, init?: RequestInit): Expectation;
  dispose(): void;
}

export interface Expectation {
  toReturn(status: number): Promise<RouteResult>;
  toMatchLocation(location: string): Promise<RouteResult>;
  toProxyTo(upstreamNameOrAddr: string): Promise<RouteResult>;
  toRedirectTo(url: string): Promise<RouteResult>;
  toServeFile(absolutePath: string): Promise<RouteResult>;
  toRewriteTo(uri: string): Promise<RouteResult>;
}
