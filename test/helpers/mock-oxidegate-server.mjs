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
 * Starts a throwaway HTTP server serving canned JSON at GET /requests and
 * GET /stats — the only two endpoints `bin/oxidegate-savings.mjs` reads.
 *
 * @param {{ requests?: unknown[], stats?: unknown[] }} fixtures
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startMockOxideGate({ requests = [], stats = [] } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
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
