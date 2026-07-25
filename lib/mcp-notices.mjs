// lib/mcp-notices.mjs
//
// CONTRACT
// --------
// The words the user actually reads. Pure functions of already-computed
// facts — this module never reads a status, never diffs, never decides what
// to disconnect. It only phrases what `lib/mcp-transitions.mjs` and
// `lib/mcp-protection.mjs` already established.
//
// Exports:
//   startupNotice({ partition, plan }) -> { title, message, variant } | null
//   transitionNotice(diff)             -> { title, message, variant } | null
//
// Comments and identifiers are English like every other lib module. The
// notice STRINGS are Spanish, matching the plugin's existing user-facing
// text (`summarizeMcpStatus` already emits "MCP actual (SDK): ...").
//
// RULE 1 — SILENCE WHEN NOTHING HAPPENED
// ---------------------------------------
// `transitionNotice` runs on every poll. A notifier that speaks each time is
// a notifier the user turns off, and then the one notice that mattered is the
// one they never see. `null` is the common, correct answer, and both "no
// movement" and "could not read" return it.
//
// RULE 2 — NEVER STATE A COUNT WE COULD NOT TAKE
// ------------------------------------------------
// "0 desconectados" and "no se pudo leer el estado" are different sentences
// and only one of them is a fact. An unreadable partition produces a notice
// that says so and contains no digit — asserted, because the natural way to
// write this function renders `undefined.length` or a stray zero.
//
// WHY A REFUSAL IS THE LOUDEST THING HERE
// -----------------------------------------
// `plan.action === 'refuse'` means the user wrote a protection config we
// could not parse, so nothing was disconnected. Staying quiet would leave
// them believing their configuration applied. It is the only `variant:
// 'warning'` in this module, and it names the parse reason, because a user
// cannot fix an error we will not name.

const TITLE = 'OxideGate — MCP';

const list = (names) => names.join(', ');

/**
 * Decimal (base 1000), byte-for-byte the same rendering as
 * `bin/oxidegate-savings.mjs`'s `humanizeBytes`. Duplicated rather than
 * imported because that file is an executable script, not a module this one
 * may depend on; the two must agree, and a divergence would show up as the
 * same server priced differently in the toast and in the report.
 */
function humanizeBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '-';
  if (bytes < 1000) return `${bytes} B`;
  const kb = Math.round((bytes / 1000) * 10) / 10;
  if (kb < 1000) return `${kb.toFixed(1)} kB`;
  const mb = Math.round((bytes / 1_000_000) * 10) / 10;
  return `${mb.toFixed(1)} MB`;
}

/**
 * Renders one server as `name (17.2 kB)`, or bare `name` when its price is
 * not known.
 *
 * Two inherited rules, both load-bearing:
 *   - An unknown price prints NO figure. Never a fabricated zero — the same
 *     invariant the rest of this repo is built around.
 *   - A stale snapshot carries its staleness marker in the SAME parenthesis
 *     as the number, never as a separate sentence a reader could fail to
 *     connect to the figure above it.
 */
function withPrice(name, prices) {
  const price = prices?.byName?.[name];
  if (!price || price.status !== 'known') return name;
  const stale = prices.freshness === 'stale' ? ', precio DESACTUALIZADO' : '';
  return `${name} (${humanizeBytes(price.bytes)}${stale})`;
}

const withPrices = (names, prices) => list(names.map((name) => withPrice(name, prices)));

/**
 * @param {{ partition: object, plan: object }} input
 *   partition: from `partitionByConnected`
 *   plan:      from `planMcpDisable`
 */
export function startupNotice({ partition, plan, prices }) {
  // A refusal outranks everything else on this screen: it means the user's
  // configuration did not take effect at all.
  if (plan?.action === 'refuse') {
    return {
      title: TITLE,
      variant: 'warning',
      message:
        `no se desconectó ningún MCP: no se pudo leer qué servidores están protegidos ` +
        `(${plan.protectionReason}). Revisa ~/.config/oxidegate-lens/config.json — ` +
        `hasta entonces se prefiere no tocar nada antes que desconectar algo que querías conservar.`,
    };
  }

  if (partition?.status !== 'known') {
    return {
      title: TITLE,
      variant: 'warning',
      message: 'no se pudo leer el estado de los MCP en este arranque. No es que no haya ninguno: es que no se sabe.',
    };
  }

  const parts = [];
  if (partition.notConnected.length > 0) {
    parts.push(
      `empiezas con ${partition.notConnected.length} MCP sin conectar: ${withPrices(partition.notConnected, prices)}.` +
        (partition.connected.length > 0 ? ` Siguen activos: ${withPrices(partition.connected, prices)}.` : ''),
    );
    // Ver y medir sin poder actuar deja al usuario con un dato y sin salida.
    parts.push('Para volver a abrir alguno: oxidegate_lens_mcp_connect. Detalle completo: oxidegate_lens_mcp_valve.');
  } else if (prices?.byName && partition.connected.length > 0) {
    // Nada que desconectar, pero sí algo que MEDIR. Entrar al programa debería
    // enseñarte lo que cuesta lo que tienes puesto, sin ejecutar un comando.
    parts.push(`MCP activos: ${withPrices(partition.connected, prices)}.`);
  }

  // A protected name matching no live server is not an error — the server may
  // simply be off — but it is also exactly what a typo looks like, and the
  // user believes they protected something.
  if (plan?.unmatchedProtections?.length > 0) {
    parts.push(
      `protegiste ${list(plan.unmatchedProtections)}, que no aparece entre los MCP de esta sesión ` +
        `(puede estar apagado, o ser un nombre mal escrito).`,
    );
  }

  if (parts.length === 0) return null;
  return { title: TITLE, variant: 'info', message: parts.join(' ') };
}

/**
 * @param {object} diff from `diffMcpStatus`
 */
export function transitionNotice(diff) {
  if (!diff || diff.status !== 'compared') return null;

  const parts = [];
  if (diff.connected.length > 0) {
    parts.push(`se ${diff.connected.length === 1 ? 'ha' : 'han'} conectado: ${list(diff.connected)}`);
  }
  if (diff.disconnected.length > 0) {
    parts.push(`se ${diff.disconnected.length === 1 ? 'ha' : 'han'} desconectado: ${list(diff.disconnected)}`);
  }
  if (diff.appeared.length > 0) {
    // Deliberately NOT "se ha conectado". We never watched these transition —
    // they were absent from the previous reading entirely, so we do not know
    // whether they came up a second ago or an hour ago. See
    // lib/mcp-transitions.mjs's header.
    const names = diff.appeared.map((entry) => `${entry.name} (${entry.connected ? 'conectado' : 'sin conectar'})`);
    parts.push(`aparecen por primera vez: ${list(names)}`);
  }
  if (diff.vanished.length > 0) {
    parts.push(`ya no figuran en la configuración: ${list(diff.vanished)}`);
  }

  if (parts.length === 0) return null;
  return { title: TITLE, variant: 'info', message: `${parts.join('; ')}.` };
}
