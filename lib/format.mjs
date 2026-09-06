// lib/format.mjs
//
// CONTRACT
// --------
// Pure, dependency-free rendering helpers shared between this repo's
// binaries. Extracted out of `bin/oxidegate-savings.mjs` — verbatim, no
// behavior changed — so `bin/oxidegate-sessions.mjs` renders the same
// numbers the same way instead of reimplementing byte humanization and
// column padding a second time. Two binaries formatting the same kind of
// figure two different ways would be its own small honesty bug: a reader
// comparing a savings report against a sessions report should never wonder
// whether "6.8 kB" here means the same thing as "6.8 kB" there.
//
// Exports:
//   humanizeBytes(bytes) -> string
//   pad(value, width, align?) -> string

// Decimal (base 1000), mirroring OxideGate's own `format_bytes`.
//
// Two boundaries matter and both have bitten us:
//   - Below 1000 bytes we print the exact count. Rendering 77 B as "0.1 kB"
//     rounds a real number down to something that reads as noise.
//   - The jump to MB is decided AFTER rounding, otherwise 999,950 B renders
//     as "1000.0 kB" instead of "1.0 MB" — a number that reads like a typo.
export function humanizeBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '-';
  if (bytes < 1000) return `${bytes} B`;
  const kb = Math.round((bytes / 1000) * 10) / 10;
  if (kb < 1000) return `${kb.toFixed(1)} kB`;
  const mb = Math.round((bytes / 1_000_000) * 10) / 10;
  return `${mb.toFixed(1)} MB`;
}

export function pad(value, width, align = 'left') {
  const text = String(value);
  if (text.length >= width) return text;
  const filler = ' '.repeat(width - text.length);
  return align === 'right' ? filler + text : text + filler;
}
