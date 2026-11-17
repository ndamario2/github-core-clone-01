// app.ts — the HTTP front door. One server, four surfaces: git smart HTTP,
// REST v3, GraphQL, and MCP. Every reply carries a non-empty
// X-GitHub-Request-Id; every JSON reply is application/json; a handler that
// throws answers 500 instead of taking the server down.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function decodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

export function createApp(store: Store, token: string): Server {
  let requestCounter = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const requestId = `req-${++requestCounter}`;
      const send = (status: number, contentType: string, body: Buffer | string, extraHeaders?: Record<string, string>): void => {
        const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
        response.writeHead(status, {
          'content-type': contentType,
          'content-length': String(payload.length),
          'x-github-request-id': requestId,
          ...extraHeaders,
        });
        response.end(payload);
      };
      const sendJson = (status: number, value: unknown, extraHeaders?: Record<string, string>): void => {
        send(status, 'application/json; charset=utf-8', JSON.stringify(value), extraHeaders);
      };
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const pathname = decodePath(url.pathname);
        const method = request.method ?? 'GET';
        const headers = request.headers;

        // Bearer auth. With no token configured, any Authorization header counts
        // as the viewer; without one the request is unauthenticated.
        const authorization = typeof headers.authorization === 'string' ? headers.authorization : '';
        const authed = token.length > 0 ? authorization === `Bearer ${token}` : authorization.length > 0;

        if (pathname === '/healthz' && method === 'GET') {
          sendJson(200, { ok: true });
          return;
        }

        const segments = pathname.split('/').filter((part) => part !== '');

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
          const owner = segments[0]!;
          const repoName = segments[1]!.slice(0, -'.git'.length);
          const tail = segments.slice(2);
          const gitProtocol = typeof headers['git-protocol'] === 'string' ? headers['git-protocol'] : '';
          const isV2 = gitProtocol.includes('version=2');
          if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            const answer = handleInfoRefs(store, owner, repoName, service, isV2);
            send(answer.status, answer.contentType, answer.body);
            return;
          }
          if (tail.length === 1 && tail[0] === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(request);
            const answer = handleUploadPack(store, owner, repoName, body, isV2);
            send(answer.status, answer.contentType, answer.body);
            return;
          }
          if (tail.length === 1 && tail[0] === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(request);
            const answer = handleReceivePack(store, owner, repoName, body);
            send(answer.status, answer.contentType, answer.body);
            return;
          }
          sendJson(404, { message: 'Not Found' });
          return;
        }

        // GraphQL.
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(404, { message: 'Not Found' });
            return;
          }
          const body = await readBody(request);
          const answer = handleGraphQL(store, body, authed);
          send(answer.status, 'application/json; charset=utf-8', answer.body);
          return;
        }

        // MCP.
        if (pathname === '/mcp') {
          if (method !== 'POST') {
            sendJson(405, { message: 'Method Not Allowed' });
            return;
          }
          const body = await readBody(request);
          const sessionId = typeof headers['mcp-session-id'] === 'string' ? headers['mcp-session-id'] : undefined;
          const answer = handleMcp(store, body, authed, sessionId);
          send(answer.status, 'application/json; charset=utf-8', answer.body, answer.headers);
          return;
        }

        // REST v3.
        if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(request);
          const answer = handleRest(store, {
            method,
            pathname,
            query: url.searchParams,
            origin: `http://${request.headers.host ?? '127.0.0.1'}`,
            body,
            authed,
          });
          send(answer.status, 'application/json; charset=utf-8', answer.body, answer.headers);
          return;
        }

        sendJson(404, { message: 'Not Found' });
      } catch (error) {
        if (!response.headersSent) {
          sendJson(500, { message: error instanceof Error ? error.message : 'internal error' });
        } else {
          response.end();
        }
      }
    })();
  });
  return server;
}
