// lib/mcp-project-config.mjs
//
// CONTRACT
// --------
// La capa de configuración POR PROYECTO, y su modelo de confianza. Función
// pura de dos entradas —los bytes de un fichero y un mapa de aprobaciones—
// sin leer `process.env` ni ambientar nada.
//
// Exports:
//   resolveProjectConfigPath(cwd) -> string
//   approvalFor(rawContent)       -> string   (hash del contenido)
//   readProjectConfig({ cwd, approvals }) -> ProjectResult
//
// ProjectResult es uno de:
//   { status: 'none' }
//   { status: 'pending',    path, approvalHash }
//   { status: 'approved',   path, config }
//   { status: 'unreadable', path, reason }
//
// EL PROBLEMA, Y POR QUÉ NO ES PARANOIA
// ---------------------------------------
// Un `.oxidegate-lens.json` dentro de un repo clonado es CÓDIGO AJENO. Puede
// desconectar servidores MCP que querías conservar, o —peor, porque es
// silencioso— marcar como protegido uno que querías apagar, dejándotelo
// cargado sin que lo notes. Que clonar un repo cambie qué MCP corres no puede
// ocurrir sin consentimiento.
//
// LA APROBACIÓN ES POR CONTENIDO, NO POR RUTA
// ---------------------------------------------
// Modelo de `direnv`, que lleva años resolviendo exactamente este problema.
// Aprobar una ruta para siempre dejaría que el repositorio cambiara el
// fichero mañana —un `git pull` basta— y se aplicara solo. Aprobar un
// CONTENIDO significa que cualquier edición vuelve a pedir permiso.
//
// La clave de aprobación es ruta + hash del contenido: el mismo contenido en
// otro proyecto NO queda aprobado, porque lo que se aprueba es «este fichero
// concreto diciendo esto concreto».
//
// UN PENDIENTE NUNCA ES SILENCIOSO
// ----------------------------------
// `status: 'pending'` existe para poder DECÍRSELO al usuario. Ignorar en
// silencio un fichero que él escribió es la otra mitad del mismo fallo:
// inseguro por un lado, desconcertante por el otro. Por eso un pendiente
// trae `path` y `approvalHash` —lo necesario para explicarlo y aprobarlo— y
// NO trae `config`: no puede haber nada que un llamador descuidado aplique.
//
// La misma disciplina de `lib/mcp-protection.mjs`: la forma del resultado
// hace el trabajo de seguridad que un comentario no puede hacer.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Dónde se guardan las aprobaciones: en la config del USUARIO, nunca en el
 * proyecto. Un fichero que se autoaprobara no sería una aprobación.
 */
export function resolveApprovalsPath() {
  return join(homedir(), '.config', 'oxidegate-lens', 'approvals.json');
}

/**
 * Mapa `ruta -> hash aprobado`.
 *
 * Cualquier fallo devuelve `{}`: nada aprobado. La dirección del fallo es
 * deliberada — un fichero de aprobaciones ilegible deja los proyectos
 * PENDIENTES, que es incómodo y seguro, en vez de aplicarlos, que sería
 * cómodo y peligroso.
 *
 * Aquí filtrar las entradas basura SÍ es correcto, al revés que en la lista
 * de protegidos de `mcp-protection.mjs`: una entrada que no es un hash no
 * puede aprobar nada, así que descartarla es MÁS restrictivo, no menos. La
 * asimetría entre los dos módulos es intencionada.
 */
export function readApprovals({ path = resolveApprovalsPath() } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && value) out[key] = value;
  }
  return out;
}

/** Un solo fichero, visible, en la raíz del proyecto. */
const PROJECT_FILE = '.oxidegate-lens.json';

export function resolveProjectConfigPath(cwd) {
  return join(cwd, PROJECT_FILE);
}

/**
 * Hash del contenido, que es lo que se aprueba. Corto a propósito: se enseña
 * al usuario para que reconozca lo que está aprobando, no es un secreto.
 */
export function approvalFor(rawContent) {
  return createHash('sha256').update(rawContent, 'utf8').digest('hex').slice(0, 16);
}

/**
 * @param {{ cwd?: string, approvals?: Record<string,string> }} opts
 *   approvals: mapa `ruta absoluta -> hash aprobado`.
 */
export function readProjectConfig({ cwd, approvals = {} } = {}) {
  if (!cwd) return { status: 'none' };

  const path = resolveProjectConfigPath(cwd);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    // No existe: este proyecto no declara nada. Cualquier otro fallo de
    // lectura sí es algo que decir, no un "no hay fichero".
    if (error && error.code === 'ENOENT') return { status: 'none' };
    return { status: 'unreadable', path, reason: 'unreadable' };
  }

  const approvalHash = approvalFor(raw);
  if (approvals[path] !== approvalHash) {
    // Sin `config`: un pendiente no puede entregar nada aplicable. Ver la
    // cabecera — la forma del resultado es la salvaguarda.
    return { status: 'pending', path, approvalHash };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'unreadable', path, reason: 'malformed-json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'unreadable', path, reason: 'unrecognized-shape' };
  }

  return { status: 'approved', path, config: parsed };
}
