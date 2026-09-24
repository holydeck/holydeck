import { createServer } from 'node:http';
import type { Server } from 'node:http';

export interface StubResponse {
  status: number;
  body: unknown;
}

/** Called for every request; returns undefined for anything the test didn't script, which answers 404. */
export type StubHandler = (method: string, path: string, requestBody: string) => StubResponse | undefined;

export interface StubCorpusServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * A minimal, hand-rolled `node:http` stand-in for the corpus server's sync/stats routes, so
 * `apps/cli` can be exercised end to end over real sockets without depending on `@holydeck/corpus`
 * (see the plan's Definition of Done — no in-process corpus, no new workspace dependency).
 */
export async function startStubCorpusServer(handler: StubHandler): Promise<StubCorpusServer> {
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const requestBody = Buffer.concat(chunks).toString('utf8');
      const path = request.url ?? '/';
      const result = handler(request.method ?? 'GET', path, requestBody);
      if (result === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'route_not_found', message: `no stub scripted for ${path}` } }));
        return;
      }
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub corpus server did not bind to a port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
