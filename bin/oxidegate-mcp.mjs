#!/usr/bin/env node
// bin/oxidegate-mcp.mjs
//
// Selector de qué servidores MCP se preservan al arrancar y cuáles se
// desconectan. Escribe `~/.config/oxidegate-lens/config.json`, que es lo que
// lee el plugin.
//
// ESTE ARCHIVO ES UNA CÁSCARA. Toda decisión —qué filas existen, qué hace una
// tecla, qué texto sale— vive en `lib/mcp-config-editor.mjs`, que sí se puede
// ejecutar con `node --test`. Es la misma división que con el plugin de
// OpenCode (design.md Decisión 1): una TUI es lo menos testeable que puede
// tener un repo, así que aquí solo quedan las tres cosas que ninguna función
// pura puede hacer — leer teclas, pintar, y escribir el fichero.
//
// FUNCIONA SIN OPENCODE, y a propósito. La configuración es del usuario, no
// del harness: sirve igual con OpenCode, con pi o con lo que venga. Lo único
// que este binario NO puede hacer es conectar o desconectar una sesión EN
// MARCHA — eso requiere el SDK del harness y vive en el plugin. Aquí se
// decide qué pasará la próxima vez que arranques.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readMcpSavingsSnapshot } from '../lib/mcp-snapshot.mjs';
import {
  readProtectedServers,
  readDisableByDefault,
  resolveProtectionConfigPath,
} from '../lib/mcp-protection.mjs';
import {
  readProjectConfig,
  readApprovals,
  resolveApprovalsPath,
} from '../lib/mcp-project-config.mjs';
import {
  buildEditorState,
  moveCursor,
  toggleAtCursor,
  toggleDisableByDefault,
  mergeIntoConfig,
  renderEditor,
} from '../lib/mcp-config-editor.mjs';

const HELP = `oxidegate-mcp — elige qué servidores MCP se preservan al arrancar

USO:
    oxidegate-mcp              Selector interactivo (necesita un terminal)
    oxidegate-mcp --print      Imprime la configuración actual y sale
    oxidegate-mcp --approve    Aprueba el .oxidegate-lens.json de este proyecto
    oxidegate-mcp --help       Muestra esta ayuda

TECLAS (modo interactivo):
    ↑ ↓ / k j    moverse por la lista
    espacio      preservar / desconectar el servidor bajo el cursor
    d            activar o desactivar el desconectado al arrancar
    enter        guardar y salir
    q / Esc      salir SIN guardar

DÓNDE ESCRIBE:
    ${resolveProtectionConfigPath()}

    Las variables OXIDEGATE_MCP_DISABLE_BY_DEFAULT y OXIDEGATE_MCP_ALLOWLIST
    siguen ganando sobre este fichero cuando están definidas. Si tienes alguna
    puesta, lo que elijas aquí no se aplicará mientras siga definida.

LO QUE ESTE BINARIO NO HACE:
    No conecta ni desconecta una sesión EN MARCHA — eso necesita el SDK del
    harness y vive en el plugin (oxidegate_lens_mcp_connect / _disconnect).
    Aquí se decide qué pasará la PRÓXIMA vez que arranques.
`;

function wants(args, ...flags) {
  return args.slice(2).some((a) => flags.includes(a));
}

/** Lee el estado actual desde las mismas fuentes que lee el plugin. */
function loadProject() {
  return readProjectConfig({ cwd: process.cwd(), approvals: readApprovals({}) });
}

function loadState() {
  const projectConfig = loadProject();
  return buildEditorState({
    snapshot: readMcpSavingsSnapshot({}),
    protection: readProtectedServers({ env: {}, projectConfig }),
    switchResult: readDisableByDefault({ env: {}, projectConfig }),
  });
}

/**
 * Aprueba la configuración de proyecto del directorio actual.
 *
 * La aprobación es del CONTENIDO, no de la ruta: se guarda el hash, así que
 * cualquier edición posterior —tuya o de un `git pull`— vuelve a pedir
 * permiso. Es el modelo de `direnv`, y existe porque un fichero de config
 * dentro de un repo clonado es código ajeno que puede desconectar servidores
 * MCP que querías conservar.
 */
function approveProject() {
  const project = loadProject();
  if (project.status === 'none') {
    process.stdout.write('\n  No hay ninguna configuración de proyecto aquí que aprobar.\n\n');
    process.exitCode = 1;
    return;
  }
  if (project.status === 'approved') {
    process.stdout.write(`\n  Ya estaba aprobada: ${project.path}\n\n`);
    return;
  }
  if (project.status === 'unreadable') {
    process.stdout.write(`\n  No se puede aprobar lo que no se puede leer: ${project.path} (${project.reason}).\n\n`);
    process.exitCode = 1;
    return;
  }

  // Se le enseña ANTES de aprobar. Aprobar a ciegas no es consentir.
  process.stdout.write(`\n  Vas a aprobar este fichero:\n\n      ${project.path}\n\n`);
  try {
    process.stdout.write(`${readFileSync(project.path, 'utf8').trimEnd()}\n\n`);
  } catch {
    // Se leyó hace un instante para calcular el hash; si falla ahora, seguir
    // sin mostrarlo es peor que abortar.
    process.stdout.write('  (no se pudo releer para mostrarlo — no se aprueba)\n\n');
    process.exitCode = 1;
    return;
  }

  const approvalsPath = resolveApprovalsPath();
  const approvals = readApprovals({});
  approvals[project.path] = project.approvalHash;
  mkdirSync(dirname(approvalsPath), { recursive: true });
  writeFileSync(approvalsPath, `${JSON.stringify(approvals, null, 2)}\n`);

  process.stdout.write(`  Aprobado (contenido ${project.approvalHash}).\n`);
  process.stdout.write('  Si el fichero cambia, volverá a pedirse.\n\n');
}

/**
 * Lee lo que ya hay y delega la fusión en `mergeIntoConfig`, que vive en
 * lib/ y sí está cubierta por tests. Aquí solo queda el I/O.
 */
function save(state) {
  const path = resolveProtectionConfigPath();
  let existing = {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
  } catch {
    // No existe, o no se puede interpretar. En el segundo caso NO se conserva
    // nada: un fichero ilegible no tiene claves rescatables, y adivinar sería
    // peor que empezar limpio con lo que el usuario acaba de elegir.
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(mergeIntoConfig(existing, state), null, 2)}\n`);
  return path;
}

function printOnce(state) {
  // El pie —dónde se guarda y QUIÉN lo aplica— lo compone renderEditor, que
  // está en lib/ y sí tiene tests. Construirlo aquí fue el error original:
  // vivía sólo en esta función, así que el modo interactivo nunca lo enseñaba.
  process.stdout.write(`\n${renderEditor(state, { configPath: resolveProtectionConfigPath() })}\n\n`);
  if (state.status === 'ready') {
    process.stdout.write('  Para cambiarla: oxidegate-mcp (en un terminal interactivo)\n\n');
  }
}

function runInteractive(initial) {
  let state = initial;
  const { stdin, stdout } = process;

  const draw = () => {
    stdout.write('\x1b[2J\x1b[H');
    stdout.write(`\n${renderEditor(state, { configPath: resolveProtectionConfigPath() })}\n\n`);
    stdout.write('  ↑↓ mover · espacio preservar/desconectar · d interruptor · enter guardar · q salir\n');
  };

  // SIEMPRE restaurar el terminal. Dejarlo en raw mode rompe la shell del
  // usuario al salir, y eso pasa igual si salimos bien, por error o por Ctrl-C.
  const restore = () => {
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    stdout.write('\x1b[?25h');
  };

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  stdout.write('\x1b[?25l');
  draw();

  // Escapados explícitos, no caracteres de control literales. Incrustados en
  // crudo funcionan, pero cualquier editor o copiado que los coma dejaría al
  // usuario atrapado en una pantalla de la que no se puede salir — un fallo
  // silencioso y muy caro para lo poco que cuesta escribirlo así.
  const CTRL_C = '\u0003';
  const ESC = '\u001b';
  const UP = '\u001b[A';
  const DOWN = '\u001b[B';

  stdin.on('data', (key) => {
    if (key === CTRL_C || key === 'q' || key === ESC) {
      restore();
      stdout.write('\n  Salido sin guardar.\n\n');
      process.exit(0);
    }
    if (key === UP || key === 'k') state = moveCursor(state, -1);
    else if (key === DOWN || key === 'j') state = moveCursor(state, 1);
    else if (key === ' ') state = toggleAtCursor(state);
    else if (key === 'd') state = toggleDisableByDefault(state);
    else if (key === '\r' || key === '\n') {
      const path = save(state);
      restore();
      stdout.write(`\n  Guardado en ${path}\n`);
      stdout.write('  Reinicia el harness para que lo aplique.\n\n');
      process.exit(0);
    }
    draw();
  });

  process.on('SIGINT', () => {
    restore();
    process.exit(130);
  });
}

function main() {
  // Cortar la salida con `| head` o `| less` cierra stdout antes de que
  // terminemos de escribir, y sin esto Node lanza EPIPE con veinte líneas de
  // stack. Pipear a head es uso normal de un CLI, no un error del usuario:
  // aquí se sale en silencio, que es lo que hace cualquier herramienta Unix.
  process.stdout.on('error', (error) => {
    if (error?.code === 'EPIPE') process.exit(0);
    throw error;
  });

  const args = process.argv;
  if (wants(args, '--help', '-h')) {
    process.stdout.write(HELP);
    return;
  }

  if (wants(args, '--approve')) {
    approveProject();
    return;
  }

  const state = loadState();

  // Sin inventario no hay nada que seleccionar: explicarlo y salir, en vez de
  // abrir una pantalla vacía que parecería decir "no tienes servidores MCP".
  if (state.status !== 'ready') {
    printOnce(state);
    process.exitCode = 1;
    return;
  }

  // Sin TTY no hay TUI. Es exactamente el fallo que tenía oxidegate-monitor:
  // por una tubería o desde un script moría con "No such device or address"
  // en vez de decir lo que sabe.
  if (wants(args, '--print') || !process.stdin.isTTY || !process.stdout.isTTY) {
    printOnce(state);
    return;
  }

  runInteractive(state);
}

main();
