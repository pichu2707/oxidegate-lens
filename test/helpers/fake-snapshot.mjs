// test/helpers/fake-snapshot.mjs
//
// Builds a throwaway HOME directory containing (or deliberately NOT
// containing) `.config/mcp-savings/snapshot.json` — the ONE file
// `lib/mcp-snapshot.mjs`'s `resolveSnapshotPath()` reads
// (`join(homedir(), '.config', 'mcp-savings', 'snapshot.json')`). Combine the
// returned `homePath` with `run-savings-cli.mjs`'s `homePath` option so a
// CLI-level test can exercise a real fresh/stale/malformed/missing snapshot
// without ever touching the real user's `$HOME`.
//
// Mirrors test/helpers/fake-claude.mjs's shape: an isolated `mkdtemp`
// directory plus a `cleanup()`. Always written inside its OWN mkdtemp
// directory, NEVER directly into the shared `os.tmpdir()` — run-savings-cli.mjs's
// default `HOME` relies on that shared directory staying snapshot-free.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * @param {{
 *   missing?: boolean,
 *   malformed?: boolean,
 *   raw?: string,
 *   timestamp?: number,
 *   mcpMeasurement?: Array<object>,
 * }} opts
 *   missing:   true -> do not create ANY snapshot file (not even the
 *              `.config` directory) — the 'missing-file' branch of
 *              `readMcpSavingsSnapshot`.
 *   malformed: true -> write deliberately torn/invalid JSON — the
 *              'malformed-json' branch. Ignored if `raw` is given.
 *   raw:       write this exact string as the file's content, bypassing
 *              JSON.stringify — for shapes `malformed` can't reach (e.g.
 *              valid JSON that is not the expected shape).
 *   timestamp: epoch ms for `snapshot.timestamp` (default: `Date.now()`,
 *              i.e. fresh). Pass `Date.now() - 30 * 60 * 60 * 1000` for a
 *              stale (>24h) snapshot.
 *   mcpMeasurement: raw `mcpMeasurement[]` entries, written verbatim.
 * @returns {Promise<{ homePath: string, cleanup: () => Promise<void> }>}
 */
export async function makeFakeSnapshot(opts = {}) {
  const { missing = false, malformed = false, raw, timestamp = Date.now(), mcpMeasurement = [] } = opts;

  const homePath = await mkdtemp(join(tmpdir(), 'oxidegate-lens-fake-snapshot-'));

  if (!missing) {
    const configDir = join(homePath, '.config', 'mcp-savings');
    await mkdir(configDir, { recursive: true });
    const content =
      raw !== undefined
        ? raw
        : malformed
          ? `{ "timestamp": ${timestamp}, "mcpMeasurement": [ { "server": "torn"`
          : JSON.stringify({ timestamp, mcpMeasurement });
    await writeFile(join(configDir, 'snapshot.json'), content);
  }

  return {
    homePath,
    cleanup: () => rm(homePath, { recursive: true, force: true }),
  };
}
