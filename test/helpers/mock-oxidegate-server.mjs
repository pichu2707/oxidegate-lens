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
 * GET /stats, GET /health and GET /version.
 *
 * `/health` está aquí porque un OxideGate real lo sirve desde 0.3.0, y el
 * diagnóstico (`--doctor`) lo consulta. Un mock que no lo sirviera haría que
 * un proxy sano se diagnosticara como roto — el fixture tiene que
 * representar el sistema, no una versión anterior de él. Pásalo a `false`
 * para simular deliberadamente un proxy previo a 0.3.0.
 *
 * `/version` es el endpoint de CAPACIDADES que lee `lib/proxy-version.mjs`.
 * Tres estados configurables:
 *   - sin pasar `version` (default): 404 — el mismo comportamiento que un
 *     OxideGate real anterior a la introducción del endpoint. Es el default
 *     A PROPÓSITO: la mayoría de los tests de --doctor no hablan de
 *     capacidades y no deben tener que declarar nada para seguir
 *     representando un proxy real y viejo.
 *   - `version: {...}`: responde 200 con ese objeto tal cual, como el
 *     contrato real (`{contract, endpoints, fields, oxidegate}`).
 *   - `version: 'fail'`: destruye el socket sin responder, para simular un
 *     fallo de red a media petición.
 *
 * `/sessions` es el endpoint que lee `lib/session-report.mjs` (issue #18).
 * Mismo patrón tri-estado que `/version`, MÁS validación real de `?since=`:
 *   - sin pasar `sessions` (default): 404 — un OxideGate anterior a este
 *     endpoint. Default a propósito: ningún test existente habla de
 *     sesiones y no debe tener que declarar nada para seguir representando
 *     un proxy real y viejo.
 *   - `sessions: {saturated, sessions: [...]}`: responde 200 con ese cuerpo
 *     tal cual — SALVO que `?since=` no cumpla el contrato real
 *     (`YYYY-MM-DD` o `<n>d`), en cuyo caso responde 400 con el mismo texto
 *     plano (no JSON) que el proxy real, para que la lente pueda testear que
 *     relaya ese mensaje verbatim.
 *   - `sessions: 'fail'`: destruye el socket sin responder.
 *
 * @param {{ requests?: unknown[], stats?: unknown[], health?: boolean, version?: object|'fail', sessions?: object|'fail' }} fixtures
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startMockOxideGate({ requests = [], stats = [], health = true, version, sessions } = {}) {
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
      if (req.url === '/version') {
        if (version === 'fail') {
          req.socket.destroy();
          return;
        }
        if (version === undefined) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(version));
        return;
      }
      if (req.url === '/sessions' || req.url.startsWith('/sessions?')) {
        if (sessions === 'fail') {
          req.socket.destroy();
          return;
        }
        if (sessions === undefined) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        const since = new URL(req.url, 'http://127.0.0.1').searchParams.get('since');
        // Mismo contrato que el proxy real: `YYYY-MM-DD` o un número de días
        // como `7d`. Cualquier otra cosa es un 400 en TEXTO PLANO, no JSON —
        // igual que la respuesta real capturada con curl.
        const validSince = since === null || /^\d{4}-\d{2}-\d{2}$/.test(since) || /^\d+d$/.test(since);
        if (!validSince) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end(`\`since=${since}\`: use una fecha YYYY-MM-DD o un numero de dias como \`7d\`\n`);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(sessions));
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
