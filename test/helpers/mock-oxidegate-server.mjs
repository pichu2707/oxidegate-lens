// test/helpers/mock-oxidegate-server.mjs
//
// Throwaway HTTP stand-in for the real OxideGate proxy, used ONLY by tests.
// Never a real OxideGate. Never a fixed port: this project has been burned
// twice by a stale process squatting on a hard-coded port and answering with
// an old binary's data, producing a false green test. `listen(0, ...)` asks
// the OS for an ephemeral port; the assigned port is read back from
// `server.address()` and handed to the caller — nothing here ever assumes a
// port number in advance.

import { createServer } from 'node:http';

/**
 * Starts a throwaway HTTP server serving canned JSON at GET /requests,
 * GET /stats and GET /health.
 *
 * `/health` está aquí porque un OxideGate real lo sirve desde 0.3.0, y el
 * diagnóstico (`--doctor`) lo consulta. Un mock que no lo sirviera haría que
 * un proxy sano se diagnosticara como roto — el fixture tiene que
 * representar el sistema, no una versión anterior de él. Pásalo a `false`
 * para simular deliberadamente un proxy previo a 0.3.0.
 *
 * @param {{ requests?: unknown[], stats?: unknown[], health?: boolean }} fixtures
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startMockOxideGate({ requests = [], stats = [], health = true } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.url === '/health') {
        if (!health) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      const body = req.url === '/requests' ? requests : req.url === '/stats' ? stats : null;
      if (body === null) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
