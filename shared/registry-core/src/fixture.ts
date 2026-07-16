import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';

export interface FixtureResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly delayMs?: number;
  readonly etag?: string;
  readonly lastModified?: string;
}

export interface FixtureRoute {
  readonly method?: string;
  readonly path: string;
  readonly responses: readonly FixtureResponse[];
}

export interface FixtureRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

export interface FixtureServer {
  readonly url: string;
  readonly requests: readonly FixtureRequest[];
  close(): Promise<void>;
}

function writeFixture(response: ServerResponse, fixture: FixtureResponse): void {
  const status = fixture.status ?? 200;
  const headers: Record<string, string> = { ...fixture.headers };
  if (fixture.etag) {
    headers.etag = fixture.etag;
  }
  if (fixture.lastModified) {
    headers['last-modified'] = fixture.lastModified;
  }
  const body = fixture.body === undefined
    ? ''
    : typeof fixture.body === 'string' || Buffer.isBuffer(fixture.body)
      ? fixture.body
      : JSON.stringify(fixture.body);
  if (fixture.body !== undefined && typeof fixture.body !== 'string' && !Buffer.isBuffer(fixture.body)) {
    headers['content-type'] ??= 'application/json';
  }
  response.writeHead(status, headers);
  response.end(body);
}

function normalizeEntityTag(tag: string): string {
  return tag.trim().replace(/^W\//i, '');
}

function parseEntityTagList(value: string): string[] {
  const tags: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && (value[index] === ' ' || value[index] === '\t' || value[index] === ',')) {
      index += 1;
    }
    if (index >= value.length) {
      break;
    }
    if (value[index] === '*') {
      tags.push('*');
      index += 1;
      continue;
    }
    const start = index;
    if (value.slice(index, index + 2).toUpperCase() === 'W/') {
      index += 2;
    }
    if (value[index] !== '"') {
      while (index < value.length && value[index] !== ',') {
        index += 1;
      }
      continue;
    }
    index += 1;
    while (index < value.length && value[index] !== '"') {
      index += 1;
    }
    if (index >= value.length) {
      break;
    }
    index += 1;
    tags.push(value.slice(start, index).trim());
    while (index < value.length && (value[index] === ' ' || value[index] === '\t')) {
      index += 1;
    }
    if (index < value.length && value[index] !== ',') {
      while (index < value.length && value[index] !== ',') {
        index += 1;
      }
    }
  }
  return tags;
}

function ifNoneMatchMatches(header: string | string[], etag: string): boolean {
  const value = Array.isArray(header) ? header.join(',') : header;
  return parseEntityTagList(value)
    .some(candidate => candidate === '*' || normalizeEntityTag(candidate) === normalizeEntityTag(etag));
}

export async function startFixtureServer(routes: readonly FixtureRoute[]): Promise<FixtureServer> {
  const routeState = new Map(routes.map(route => [
    `${route.method?.toUpperCase() ?? 'GET'} ${route.path}`,
    { route, index: 0 }
  ]));
  const requests: FixtureRequest[] = [];
  const server: Server = createServer(async (request, response) => {
    const bodyChunks: Buffer[] = [];
    for await (const chunk of request) {
      bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const path = new URL(request.url ?? '/', 'http://fixture.local').pathname;
    requests.push({
      method: request.method ?? 'GET',
      path,
      headers: { ...request.headers },
      body: Buffer.concat(bodyChunks).toString('utf8')
    });
    const state = routeState.get(`${request.method ?? 'GET'} ${path}`);
    if (!state) {
      writeFixture(response, { status: 404, body: { error: 'fixture route not found' } });
      return;
    }
    const fixtures = state.route.responses;
    const fixture = fixtures[Math.min(state.index, fixtures.length - 1)];
    state.index += 1;
    if (!fixture) {
      writeFixture(response, { status: 500, body: { error: 'fixture route has no responses' } });
      return;
    }
    const ifNoneMatch = request.headers['if-none-match'];
    const notModified = ifNoneMatch !== undefined
      ? fixture.etag !== undefined && ifNoneMatchMatches(ifNoneMatch, fixture.etag)
      : fixture.lastModified !== undefined &&
        request.headers['if-modified-since'] === fixture.lastModified;
    if (notModified) {
      writeFixture(response, {
        status: 304,
        ...(fixture.etag === undefined ? {} : { etag: fixture.etag }),
        ...(fixture.lastModified === undefined ? {} : { lastModified: fixture.lastModified })
      });
      return;
    }
    if (fixture.delayMs) {
      await new Promise(resolve => setTimeout(resolve, fixture.delayMs));
    }
    writeFixture(response, fixture);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to determine fixture server address');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    get requests() {
      return requests;
    },
    close: async () => {
      server.close();
      await once(server, 'close');
    }
  };
}
