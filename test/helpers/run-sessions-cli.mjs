// test/helpers/run-sessions-cli.mjs
//
// Spawns the REAL bin/oxidegate-sessions.mjs (not a reimplementation of its
// logic) against a mock proxy. Mirrors test/helpers/run-savings-cli.mjs —
// same rationale: every one of the nine defects that suite guards against
// was a wrong SENTENCE printed next to a correct table, a bug class that
// only spawning the real binary and reading its real stdout catches. This
// second lens carries the same discipline from day one instead of
// discovering it the hard way a second time.
//
// Hermetic by construction: the child's `env` is built from scratch, never
// `{ ...process.env }` — see mock-oxidegate-server.mjs for why that matters.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', '..', 'bin', 'oxidegate-sessions.mjs');

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * @param {{ baseUrl: string, args?: string[], timeoutMs?: number }} opts
 * @returns {Promise<{ stdout: string, stderr: string, code: number | null }>}
 */
export function runSessionsCli({ baseUrl, args = [], timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const env = { OXIDEGATE_LENS_URL: baseUrl, PATH: '' };

    const child = spawn(process.execPath, [CLI_PATH, ...args], { env });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`oxidegate-sessions.mjs no terminó dentro de ${timeoutMs}ms (¿colgado?)`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Guards the honesty invariant at the render level, same discipline as
 * `assertNoFabricatedZero` in run-savings-cli.mjs: a line that already
 * states a measurement is unmeasured/unknown must not ALSO carry a
 * fabricated numeric `0 B` figure for that same finding.
 */
export function assertNoFabricatedZeroBytes(assert, stdout) {
  const lines = stdout.split('\n');
  for (const line of lines) {
    if (line.includes('no medido') || line.includes('desconocido')) {
      assert.ok(
        !/\b0\s?B\b/.test(line),
        `una línea de peaje fijo no medido no debe imprimir 0 B: ${line}`,
      );
    }
  }
}

/**
 * Guards Rule 2 (issue #18): a row whose cost is not attributable must never
 * print a bare `0.0000 $` — the "no atribuible" marker has to be in the SAME
 * line as the figure, never a separate paragraph a reader could miss.
 *
 * A `(0 filas)` total is EXEMPT on purpose: an empty group's total is a real
 * `0` because there was nothing to sum, not because a real cost got hidden
 * — a different fact from an unattributable bucket's cost, and marking it
 * "no atribuible" would itself be a fabrication this suite would then have
 * to guard against.
 */
export function assertNoUnmarkedZeroCost(assert, stdout) {
  const lines = stdout.split('\n');
  for (const line of lines) {
    if (line.includes('(0 filas)')) continue;
    if (/\b0\.0000 \$/.test(line)) {
      assert.ok(
        line.includes('no atribuible'),
        `un coste 0.0000 $ debe llevar "no atribuible" en la MISMA línea: ${line}`,
      );
    }
  }
}
