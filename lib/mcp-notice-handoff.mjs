// lib/mcp-notice-handoff.mjs
//
// CONTRACT
// --------
// A one-file mailbox from the OpenCode 2.x SERVER plugin to the TUI plugin.
//
// WHY IT EXISTS
// -------------
// Only the TUI can show a toast, but the disable-by-default startup notice is
// composed by the server plugin (it depends on the protection plan, which the
// TUI does not have). The two are separate plugins in separate contexts, so the
// finished notice is dropped in a small JSON file under the XDG state dir and
// picked up by the TUI. Best-effort by design: any failure means "no notice",
// never an invented one.
//
// Exports:
//   resolveHandoffPath(env)                         -> string
//   writeStartupNotice({ path, notice, now })       -> id | null
//   readFreshStartupNotice({ path, now, maxAgeMs, seenId }) -> { id, notice } | null

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export function resolveHandoffPath(env = process.env) {
  const state = env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state');
  return join(state, 'oxidegate-lens', 'startup-notice.json');
}

/** Returns the id written, or null when there was nothing to write / it failed. */
export function writeStartupNotice({ path, notice, now }) {
  if (!notice) return null;
  try {
    const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ id, at: now, notice }));
    return id;
  } catch {
    return null;
  }
}

/** Null for anything but a fresh, well-formed, not-yet-shown notice. */
export function readFreshStartupNotice({ path, now, maxAgeMs, seenId }) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || typeof data.id !== 'string' || typeof data.at !== 'number' || !data.notice) return null;
    if (data.id === seenId) return null;
    if (now - data.at > maxAgeMs) return null;
    return { id: data.id, notice: data.notice };
  } catch {
    return null;
  }
}
