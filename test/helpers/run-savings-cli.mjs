// test/helpers/run-savings-cli.mjs
//
// Spawns the REAL bin/oxidegate-savings.mjs (not a reimplementation of its
// logic) against a mock proxy and, optionally, a fake `claude` on PATH. This
// is deliberate: all nine defects this suite guards against manifested as a
// wrong SENTENCE printed next to a true table — bugs that live in the
// script's own string-building, which only spawning the real binary and
// reading its real stdout can catch. Unit-testing the internal functions in
// isolation would have let every one of them through.
//
// Hermetic by construction: the child's `env` is built from scratch, never
// `{ ...process.env }`. If we inherited the host PATH, `claude mcp list`
// inside lib/mcp-config.mjs could reach the REAL `claude` binary this coding
// agent runs on — a nondeterministic dependency on whoever's machine runs
// the suite, exactly the kind of stale/live-process contamination this repo
// has already been burned by twice (see mock-oxidegate-server.mjs).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', '..', 'bin', 'oxidegate-savings.mjs');

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * @param {{ baseUrl: string, claudePath?: string | null, homePath?: string | null, timeoutMs?: number }} opts
 *   claudePath: directory containing a fake `claude` (see fake-claude.mjs),
 *   or null/omitted to guarantee `claude` is NOT reachable at all (empty
 *   PATH) — the child then hits ENOENT for any `claude` spawn, same as the
 *   'claude-not-found' scenario, unless the test deliberately wants that.
 *   homePath: directory to use as the child's `$HOME` — this is what
 *   `lib/mcp-snapshot.mjs`'s `resolveSnapshotPath()` keys off
 *   (`join(homedir(), '.config', 'mcp-savings', 'snapshot.json')`; verified
 *   against that module's source, not assumed). Pass the `homePath` returned
 *   by `test/helpers/fake-snapshot.mjs` to exercise a real fresh/stale/
 *   malformed snapshot. Omitted/null defaults to the shared OS tmp dir,
 *   which this suite's fixtures never write a `.config/mcp-savings/` into —
 *   so the snapshot always and reliably resolves to 'missing-file'. Without
 *   an explicit HOME, an unset env var falls through to the REAL invoking
 *   user's home directory (libuv's `getpwuid_r` fallback ignores a merely-
 *   absent HOME key), which would be exactly the non-hermetic, live-machine
 *   contamination this file already guards against for PATH/`claude`.
 * @returns {Promise<{ stdout: string, stderr: string, code: number | null }>}
 */
export function runSavingsCli({ baseUrl, claudePath = null, homePath = null, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const env = {
      OXIDEGATE_LENS_URL: baseUrl,
      PATH: claudePath ?? '',
      HOME: homePath ?? tmpdir(),
    };

    const child = spawn(process.execPath, [CLI_PATH], { env });

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
      reject(new Error(`oxidegate-savings.mjs no terminó dentro de ${timeoutMs}ms (¿colgado?)`));
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

// Identifiers this repo deliberately KILLED — see the "WHY THE OLD
// `clasificación:` LINE..." section at the top of bin/oxidegate-savings.mjs.
// If any of these strings ever appear in real stdout again, a causal claim
// about WHY bytes are/aren't on the wire has been reintroduced.
const DEAD_CAUSAL_ARTIFACTS = [
  'clasificación:',
  'classifyMcpRetention',
  'isClaudeCode',
  'WITHHELD',
  'NOTHING_WITHHELD',
  'EAGER_DIALECT',
];

/**
 * Shared regression guard: none of the nine defects were introduced by a
 * NEW forbidden phrase — every one of them was the SAME old causal claim
 * coming back in a new form. Every CLI-level test in this suite calls this
 * on its stdout, regardless of which specific defect it targets.
 */
export function assertNoDeadCausalArtifacts(assert, stdout) {
  for (const needle of DEAD_CAUSAL_ARTIFACTS) {
    assert.ok(
      !stdout.includes(needle),
      `stdout no debería contener "${needle}" — es un artefacto de una claim causal ya eliminada`,
    );
  }
}

/**
 * Guards the informed-valve section (d)'s window rule: a `0 usos` figure or
 * a `candidato a desconectar` label MUST carry its observation window in the
 * SAME line — never a bare zero, never a recommendation with the window a
 * paragraph (or a header) away. Checked line-by-line, since "same sentence"
 * for this file's line-oriented output means "same printed line".
 */
export function assertNoUnwindowedRecommendation(assert, stdout) {
  const lines = stdout.split('\n');
  for (const line of lines) {
    if (line.includes('candidato a desconectar')) {
      assert.ok(
        line.includes('ventana observada'),
        `"candidato a desconectar" debe llevar su ventana de observación en la MISMA línea: ${line}`,
      );
    }
    if (/\b0 usos\b/.test(line)) {
      assert.ok(
        line.includes('ventana observada'),
        `"0 usos" debe llevar su ventana de observación en la MISMA línea: ${line}`,
      );
    }
  }
}

/**
 * Guards the honesty invariant (an absent measurement is never a zero
 * measurement) at the render level: any line that already states a price or
 * a measurement is unknown/unmeasurable must NOT also carry a fabricated
 * numeric `0 B` / `0 tok` figure for that same finding.
 */
export function assertNoFabricatedZero(assert, stdout) {
  const lines = stdout.split('\n');
  for (const line of lines) {
    if (line.includes('no se pudo medir') || line.includes('desconocido')) {
      assert.ok(
        !/\b0\s?B\b/.test(line) && !/\b0\s?tok\b/.test(line),
        `una fila con precio/medición desconocida no debe imprimir una cifra de 0: ${line}`,
      );
    }
  }
}

/**
 * Guards Decision 6 (design.md): observed wire spend that matches no
 * snapshot server MUST still render, as an `unknown` row — never silently
 * dropped. Fails if any label in `expectedLabels` (wire labels the fixture
 * gave real spend to) does not appear anywhere in `stdout`.
 */
export function assertNoDroppedSpend(assert, stdout, expectedLabels) {
  for (const label of expectedLabels) {
    assert.ok(
      stdout.includes(label),
      `el gasto observado en "${label}" no debe desaparecer del stdout — atribuido o como gasto sin atribuir, nunca ausente`,
    );
  }
}
