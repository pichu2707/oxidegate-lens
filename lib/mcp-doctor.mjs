// lib/mcp-doctor.mjs
//
// CONTRACT
// --------
// Diagnoses the whole chain and says which link is broken. PURE: it receives
// observations already taken and returns a verdict. No fetch, no disk, no
// clock — the binary gathers, this judges, the binary prints.
//
// Exports:
//   diagnose(observations) -> { checks: Check[], verdict }
//
// Check: { id, status: 'ok'|'warn'|'fail'|'unknown', title, detail, action }
// verdict: 'ok' | 'degraded' | 'broken' | 'unknown'
//
// WHY THIS EXISTS
// ----------------
// Every check below is a failure that actually bit during development, and
// not one of them was obvious from the outside:
//
//   - A WordPress squatting the default port, answering 302 to everything —
//     indistinguishable from "the proxy has seen no traffic".
//   - `/health` returning 404 because the INSTALLED binary predated 0.3.0,
//     which made the routing patch fall back to the provider IN SILENCE.
//   - `/requests` empty for an entire session with nothing saying why.
//   - Flattened tools, which make half the product impossible on that route.
//
// Each one cost real time to find. Together they are a one-second command.
//
// THE RULE THAT GOVERNS EVERY BRANCH
// ------------------------------------
// A check that could not be made is `unknown`, NEVER `ok`, and the overall
// verdict cannot be `ok` while any check is unknown. A diagnostic that
// reports "all good" about something it did not look at is worse than no
// diagnostic: it actively closes the investigation that would have found the
// problem. This is the same invariant as the rest of the repo — an absent
// measurement is never a zero — applied to an answer instead of a number.
//
// EVERY NON-OK CHECK CARRIES AN ACTION
// --------------------------------------
// A symptom without a next step just relocates the confusion. Asserted in
// the tests, not left to discipline.

/**
 * Pliega las comprobaciones en un veredicto.
 *
 * El orden importa y no es el obvio: un `warn` gana a un `unknown`. Un primer
 * intento puso `unknown` por encima, y con el proxy sano pero sin tráfico el
 * veredicto salía «unknown» — enterrando el único aviso accionable ("nadie
 * está enrutando") detrás de un desconocido que es CONSECUENCIA suyo, no un
 * problema aparte. Sin tráfico no se puede saber si el cable conserva
 * atribución; eso no es una segunda avería.
 *
 * Lo que sí se mantiene intacto: un `unknown` impide declarar `ok`. No se
 * afirma que todo está bien sobre algo que no se miró.
 */
function foldVerdict(checks) {
  const has = (status) => checks.some((c) => c.status === status);
  if (has('fail')) return 'broken';
  if (has('warn')) return 'degraded';
  if (has('unknown')) return 'unknown';
  return 'ok';
}

function checkReachable({ baseUrl, reachable }) {
  if (reachable) {
    return { id: 'reachable', status: 'ok', title: 'El proxy responde', detail: `${baseUrl} contesta.`, action: '' };
  }
  return {
    id: 'reachable',
    status: 'fail',
    title: 'Nada responde en la URL configurada',
    detail: `${baseUrl} no contesta.`,
    action:
      'Arranca OxideGate, o corrige el puerto con OXIDEGATE_PORT. Si el proxy escucha ' +
      'en otro sitio, esta herramienta mira donde le digas, no donde esté.',
  };
}

function checkIdentity({ baseUrl, reachable, isOxidegate }) {
  if (!reachable) {
    return { id: 'identity', status: 'unknown', title: 'No se pudo comprobar qué escucha ahí', detail: 'No hubo respuesta que examinar.', action: 'Resuelve primero la conectividad.' };
  }
  if (isOxidegate) {
    return { id: 'identity', status: 'ok', title: 'Lo que responde ES OxideGate', detail: '/requests devolvió un array.', action: '' };
  }
  return {
    id: 'identity',
    status: 'fail',
    title: 'Responde algo, pero no es OxideGate',
    detail: `${baseUrl} contesta con algo que no es la API de OxideGate.`,
    action:
      'Hay otro servicio ocupando ese puerto — el 8080 lo suelen tener Apache, Tomcat o ' +
      'Jenkins. Fija OXIDEGATE_PORT al puerto donde escuche OxideGate de verdad.',
  };
}

function checkHealth({ reachable, isOxidegate, healthCode }) {
  if (!reachable || healthCode === null || healthCode === undefined) {
    return { id: 'health', status: 'unknown', title: 'No se pudo sondear /health', detail: 'La comprobación no llegó a hacerse.', action: 'Resuelve primero la conectividad y vuelve a ejecutar.' };
  }
  // Un 200 de algo que ya sabemos que NO es OxideGate no dice nada. Cazado
  // ejecutándolo contra un WordPress en el 8080: redirige todo a
  // wp-admin/install.php, que responde 200, y el diagnóstico afirmaba "el
  // proxy está vivo y sirviendo" dos líneas después de haber descartado que
  // ese servicio fuera OxideGate. Interpretar el código de estado de un
  // desconocido es exactamente el error que este módulo existe para no
  // cometer.
  if (!isOxidegate) {
    return {
      id: 'health',
      status: 'unknown',
      title: 'No se puede interpretar /health',
      detail: `Contestó ${healthCode}, pero lo que hay en ese puerto no es OxideGate.`,
      action: 'Apunta al puerto correcto antes de leer nada de esta ruta.',
    };
  }
  if (healthCode === 200) {
    return { id: 'health', status: 'ok', title: '/health responde 200', detail: 'El proxy está vivo y sirviendo.', action: '' };
  }
  return {
    id: 'health',
    status: 'fail',
    title: `/health devuelve ${healthCode}`,
    detail:
      'La ruta existe desde OxideGate 0.3.0, así que un 404 aquí significa que el binario ' +
      'INSTALADO es anterior — aunque el código fuente ya la tenga.',
    action:
      'Actualiza el proxy (brew upgrade oxidegate) y REINÍCIALO: actualizar el binario no ' +
      'reinicia el proceso. Importa más de lo que parece, porque los clientes sondean esta ' +
      'ruta antes de decidir si enrutan por el proxy: con un 404 caen al proveedor directo ' +
      'EN SILENCIO, sin error y sin log, y el reporte se queda vacío sin explicación.',
  };
}

function checkTraffic({ reachable, isOxidegate, requestCount }) {
  if (!reachable || !isOxidegate || requestCount === null || requestCount === undefined) {
    return { id: 'traffic', status: 'unknown', title: 'No se pudo leer el tráfico observado', detail: 'No hubo /requests que leer.', action: 'Resuelve primero la conectividad y la identidad del puerto.' };
  }
  if (requestCount > 0) {
    return { id: 'traffic', status: 'ok', title: `${requestCount} peticiones observadas`, detail: 'El proxy está viendo tráfico.', action: '' };
  }
  return {
    id: 'traffic',
    status: 'warn',
    title: 'El proxy está vivo pero no ha visto ni una petición',
    detail: 'Nadie está enrutando su tráfico a través de él.',
    action:
      'Comprueba que tu agente apunta al proxy: un bloque provider en opencode.json, una ' +
      'variable de base URL, o un plugin que parchee fetch. Que el proxy funcione no ' +
      'significa que alguien lo esté usando.',
  };
}

function checkAttribution({ reachable, isOxidegate, requestCount, flattened }) {
  if (!reachable || !isOxidegate || !requestCount) {
    return { id: 'attribution', status: 'unknown', title: 'Sin tráfico no se sabe si conserva atribución', detail: 'Hace falta al menos una petición observada.', action: 'Genera tráfico a través del proxy y vuelve a ejecutar.' };
  }
  if (!flattened) {
    return { id: 'attribution', status: 'ok', title: 'El cable conserva la atribución por servidor', detail: 'Las tools llegan identificadas por su servidor MCP.', action: '' };
  }
  return {
    id: 'attribution',
    status: 'warn',
    title: 'Las tools llegan APLANADAS (tools_flattened)',
    detail:
      'Este dialecto manda todas las tools en un único bloque sin decir de qué servidor ' +
      'viene cada una. Las MCP están ahí dentro, pero son indistinguibles.',
    action:
      'La mitad PRECIO del reporte sigue siendo válida; la mitad USO no puede funcionar ' +
      'en esta ruta, y acumular más tráfico NO lo cambia. Haría falta una ruta o un ' +
      'dialecto que conserve la atribución.',
  };
}

function checkPrice({ snapshot }) {
  if (snapshot?.status === 'known') {
    const n = snapshot.servers?.length ?? 0;
    const stale = snapshot.freshness === 'stale' ? ' (DESACTUALIZADO)' : '';
    return { id: 'price', status: stale ? 'warn' : 'ok', title: `Precio disponible para ${n} servidor(es)${stale}`, detail: 'El snapshot de mcp-savings se pudo leer.', action: stale ? 'Vuelve a ejecutar mcp-savings para refrescar los precios.' : '' };
  }
  return {
    id: 'price',
    status: 'warn',
    title: 'No hay precio por servidor',
    detail: `No se pudo leer el snapshot (${snapshot?.reason ?? 'razón desconocida'}).`,
    action:
      'Instala y ejecuta mcp-savings, que es quien mide el peso de cada servidor. Sin él ' +
      'el reporte puede contar tráfico pero no decir qué cuesta cada MCP. Esto NO es un ' +
      'precio de cero: es un precio desconocido.',
  };
}

function checkProject({ projectConfig }) {
  if (!projectConfig || projectConfig.status === 'none') {
    return { id: 'project', status: 'ok', title: 'Sin configuración de proyecto', detail: 'Manda la configuración global.', action: '' };
  }
  if (projectConfig.status === 'approved') {
    return { id: 'project', status: 'ok', title: 'Configuración de proyecto aprobada y activa', detail: `${projectConfig.path} — reemplaza a la global en lo que declara.`, action: '' };
  }
  if (projectConfig.status === 'unreadable') {
    return {
      id: 'project',
      status: 'warn',
      title: 'Hay una configuración de proyecto que no se puede leer',
      detail: `${projectConfig.path} (${projectConfig.reason}).`,
      action: 'Arréglala o bórrala. Mientras tanto manda la configuración global, que es la tuya.',
    };
  }
  return {
    id: 'project',
    status: 'warn',
    title: 'Hay una configuración de proyecto SIN aprobar, y no se está aplicando',
    detail: `${projectConfig.path} — contenido ${projectConfig.approvalHash}.`,
    action:
      'Un fichero de config dentro de un repo clonado es código ajeno: puede desconectar ' +
      'servidores MCP que querías conservar. Por eso no se aplica solo. Revísalo y, si te ' +
      'parece bien, apruébalo con `oxidegate-mcp --approve`. La aprobación es del CONTENIDO: ' +
      'si el fichero cambia, vuelve a pedirse.',
  };
}

function checkConfig({ protection, switchResult }) {
  if (protection?.status !== 'known') {
    return {
      id: 'config',
      status: 'fail',
      title: 'La configuración de servidores protegidos no se puede leer',
      detail: `Razón: ${protection?.reason ?? 'desconocida'}.`,
      action:
        'Revisa ~/.config/oxidegate-lens/config.json, o arréglalo con `oxidegate-mcp`. ' +
        'Mientras siga ilegible el plugin NO desconectará nada — prefiere no tocar antes ' +
        'que desconectar algo que querías conservar.',
    };
  }
  if (switchResult?.status !== 'known') {
    return { id: 'config', status: 'fail', title: 'El interruptor de desconexión no se puede leer', detail: `Razón: ${switchResult?.reason ?? 'desconocida'}.`, action: 'Revisa ~/.config/oxidegate-lens/config.json o arréglalo con `oxidegate-mcp`.' };
  }
  const n = protection.servers.length;
  return {
    id: 'config',
    status: 'ok',
    title: switchResult.enabled ? `Desconectar al arrancar: ACTIVADO (${n} protegido/s)` : 'Desconectar al arrancar: desactivado',
    detail: `Origen: ${switchResult.source}.`,
    action: '',
  };
}

/**
 * @param {object} observations ya tomadas por el binario
 */
export function diagnose(observations) {
  const checks = [
    checkReachable(observations),
    checkIdentity(observations),
    checkHealth(observations),
    checkTraffic(observations),
    checkAttribution(observations),
    checkPrice(observations),
    checkConfig(observations),
    checkProject(observations),
  ];

  return { checks, verdict: foldVerdict(checks) };
}
