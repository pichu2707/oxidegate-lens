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

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', '..', 'bin', 'oxidegate-savings.mjs');

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * @param {{ baseUrl: string, claudePath?: string | null, timeoutMs?: number }} opts
 *   claudePath: directory containing a fake `claude` (see fake-claude.mjs),
 *   or null/omitted to guarantee `claude` is NOT reachable at all (empty
 *   PATH) — the child then hits ENOENT for any `claude` spawn, same as the
 *   'claude-not-found' scenario, unless the test deliberately wants that.
 * @returns {Promise<{ stdout: string, stderr: string, code: number | null }>}
 */
export function runSavingsCli({ baseUrl, claudePath = null, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const env = {
      OXIDEGATE_LENS_URL: baseUrl,
      PATH: claudePath ?? '',
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
