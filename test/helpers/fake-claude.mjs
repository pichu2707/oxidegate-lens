// test/helpers/fake-claude.mjs
//
// Builds a throwaway directory containing an executable `claude` script
// whose `mcp list` output — or failure mode — we fully control, so tests
// never spawn a REAL `claude` binary. That matters here specifically:
// this agent's own execution environment has a real `claude` on PATH, so a
// test that forgot to override PATH would silently talk to it instead of
// the fixture it thought it built, and pass or fail on live machine state
// instead of the scenario it names.
//
// Callers combine the returned `path` with `run-savings-cli.mjs`, which
// builds the child's PATH from scratch (never inherits the host's).

import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * @param {{ stdout?: string, exitCode?: number, hangMs?: number, missing?: boolean }} opts
 *   missing: true  -> do not create a `claude` executable at all, so
 *                      `spawn('claude', ...)` fails with ENOENT — the
 *                      'claude-not-found' branch of the FAILURE POLICY.
 *   hangMs: sleeps this many ms (via setTimeout, no shell dependency)
 *           before writing stdout and exiting — for timeout tests.
 * @returns {Promise<{ path: string, cleanup: () => Promise<void> }>}
 *   `path` is a directory suitable for use as a child's ENTIRE PATH env var
 *   (containing nothing but `claude`, or nothing at all if `missing`).
 */
export async function makeFakeClaude(opts = {}) {
  const { stdout = '', exitCode = 0, hangMs = 0, missing = false } = opts;
  const dir = await mkdtemp(join(tmpdir(), 'oxidegate-lens-fake-claude-'));

  if (!missing) {
    // Deliberately NOT a shell script: a plain Node script with no
    // import/export/top-level-await avoids depending on the host having
    // `bash`, and avoids any ambiguity in how Node decides CJS vs ESM for
    // an extension-less file run via shebang.
    //
    // The shebang embeds `process.execPath` DIRECTLY rather than using
    // `#!/usr/bin/env node`: run-savings-cli.mjs deliberately sets the
    // child's PATH to contain NOTHING but this fake-claude directory (for
    // hermeticity — see that file's header), which means `env` itself would
    // have no PATH to find `node` with, and every invocation would fail
    // with `env: 'node': No such file or directory` before it ever reached
    // the `claude mcp list` logic under test. An absolute shebang needs no
    // PATH lookup at all.
    const script = `#!${process.execPath}
function done() {
  process.stdout.write(${JSON.stringify(stdout)});
  process.exit(${exitCode});
}
${hangMs > 0 ? `setTimeout(done, ${hangMs});` : 'done();'}
`;
    const binPath = join(dir, 'claude');
    await writeFile(binPath, script);
    await chmod(binPath, 0o755);
  }

  return {
    path: dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
