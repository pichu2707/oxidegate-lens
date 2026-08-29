// test/mcp-endpoint.test.mjs
//
// Unit tests for lib/mcp-endpoint.mjs — encontrar el proxy sin que el usuario
// tenga que decir dónde está.
//
// EL FALLO QUE ORIGINA ESTE MÓDULO
// ---------------------------------
// El puerto por defecto (8080) estaba ocupado por un WordPress. La lente le
// preguntaba a él, recibía un 302, y como no había forma de distinguir "esto
// no es OxideGate" de "OxideGate no ha visto tráfico", imprimía *«the proxy
// has not seen any request yet»*. Un falso negativo indistinguible del caso
// legítimo, durante meses.
//
// LA REGLA QUE GOBIERNA TODO EL MÓDULO
// -------------------------------------
// **Que algo conteste en un puerto no significa que sea OxideGate.** Un
// candidato solo se acepta si pasa la comprobación de IDENTIDAD, nunca por
// contestar. Esto es lo que mata la clase entera del okupa: da igual quién
// viva en el 8080, no va a superar el filtro.
//
// LA SEGUNDA REGLA: DESCUBRIR NO ES DESOBEDECER EN SILENCIO
// ----------------------------------------------------------
// Si el usuario fijó `OXIDEGATE_PORT` y ahí no está el proxy, se sigue
// buscando — pero el resultado DICE que se ignoró lo que él pidió y por qué.
// Corregir a alguien sin decírselo es como no corregirlo: la próxima vez
// vuelve a equivocarse igual, y encima con la herramienta funcionando.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseListeningUrl,
  buildEndpointCandidates,
  chooseEndpoint,
} from '../lib/mcp-endpoint.mjs';

// El formato REAL de ~/.config/oxidegate/proxy.log, copiado tal cual —
// emojis, doble espacio y todo. Si OxideGate cambia esta línea, este fixture
// es lo que debe romperse primero.
const LOG_REAL = `🚀 OxideGate inicializado en local.
📦 Almacenamiento de telemetría nativa en: "/home/javilazaro/.config/oxidegate"
🔍 Entorno OpenCode detectado en el sistema.
🛰️  Escuchando en http://127.0.0.1:8899
💚 Liveness en http://127.0.0.1:8899/health
🧾 Últimos requests en vivo en http://127.0.0.1:8899/requests
`;

// ---------------------------------------------------------------- parseListeningUrl

test('parseListeningUrl saca la URL de la línea que escribe OxideGate', () => {
  assert.equal(parseListeningUrl(LOG_REAL), 'http://127.0.0.1:8899');
});

test('parseListeningUrl NO se queda con la primera URL que ve, sino con la de "Escuchando"', () => {
  // `/health` aparece después y también es una URL. Un parser que buscara
  // "la primera http://" acertaría por casualidad aquí; uno que buscara
  // "la última" devolvería la de /requests. Ninguno de los dos sirve.
  const url = parseListeningUrl(LOG_REAL);
  assert.equal(url.endsWith('/health'), false);
  assert.equal(url.endsWith('/requests'), false);
});

test('parseListeningUrl se queda con el ÚLTIMO arranque, no con el primero', () => {
  // El log se ACUMULA entre reinicios. Si el proxy se levantó ayer en el 8899
  // y hoy en el 9100, la verdad es la de hoy. Quedarse con la primera línea
  // manda la lente a un puerto muerto con toda la confianza del mundo.
  const dosArranques = `🛰️  Escuchando en http://127.0.0.1:8899\n` + LOG_REAL.replace('8899', '9100');
  assert.equal(parseListeningUrl(dosArranques), 'http://127.0.0.1:9100');
});

test('parseListeningUrl devuelve null cuando no hay nada que leer', () => {
  assert.equal(parseListeningUrl(''), null);
  assert.equal(parseListeningUrl('registro sin ninguna línea de escucha'), null);
  assert.equal(parseListeningUrl(null), null);
  assert.equal(parseListeningUrl(undefined), null);
});

// ------------------------------------------------------------ buildEndpointCandidates

test('lo explícito va primero: OXIDEGATE_LENS_URL manda sobre todo lo demás', () => {
  const candidatos = buildEndpointCandidates({
    env: { OXIDEGATE_LENS_URL: 'http://127.0.0.1:7000', OXIDEGATE_PORT: '8899' },
    loggedUrl: 'http://127.0.0.1:9100',
  });

  assert.equal(candidatos[0].baseUrl, 'http://127.0.0.1:7000');
  assert.equal(candidatos[0].source, 'env-url');
});

test('OXIDEGATE_LENS_URL es un PIN: no se prueba nada más', () => {
  // Una URL completa nombra host Y puerto. Ponerse a adivinar otros sitios
  // después de que alguien haya dicho exactamente dónde mirar no es ayudar:
  // es ignorar una instrucción precisa. Un puerto es una pista sobre UN
  // campo; una URL es la dirección entera.
  const candidatos = buildEndpointCandidates({
    env: { OXIDEGATE_LENS_URL: 'http://127.0.0.1:7000', OXIDEGATE_PORT: '8899' },
    loggedUrl: 'http://127.0.0.1:9100',
  });

  assert.deepEqual(candidatos, [{ baseUrl: 'http://127.0.0.1:7000', source: 'env-url' }]);
});

test('OXIDEGATE_PORT va antes que lo descubierto', () => {
  const candidatos = buildEndpointCandidates({
    env: { OXIDEGATE_PORT: '8899' },
    loggedUrl: 'http://127.0.0.1:9100',
  });

  assert.equal(candidatos[0].baseUrl, 'http://127.0.0.1:8899');
  assert.equal(candidatos[0].source, 'env-port');
  assert.equal(candidatos[1].source, 'proxy-log');
});

test('sin nada configurado, el log del proxy es la primera fuente', () => {
  const candidatos = buildEndpointCandidates({ env: {}, loggedUrl: 'http://127.0.0.1:9100' });

  assert.equal(candidatos[0].baseUrl, 'http://127.0.0.1:9100');
  assert.equal(candidatos[0].source, 'proxy-log');
});

test('sin log tampoco se queda a ciegas: quedan los puertos conocidos', () => {
  const candidatos = buildEndpointCandidates({ env: {}, loggedUrl: null });
  const urls = candidatos.map((c) => c.baseUrl);

  assert.ok(urls.includes('http://127.0.0.1:8080'), 'el default histórico sigue estando');
  assert.ok(urls.includes('http://127.0.0.1:8899'), 'el puerto que enseña el README también');
});

test('no se sondea dos veces la misma URL aunque llegue por dos caminos', () => {
  const candidatos = buildEndpointCandidates({
    env: { OXIDEGATE_PORT: '8899' },
    loggedUrl: 'http://127.0.0.1:8899',
  });
  const urls = candidatos.map((c) => c.baseUrl);

  assert.equal(new Set(urls).size, urls.length);
  // Y gana la fuente más explícita, que es la que luego se le enseña al usuario.
  assert.equal(candidatos[0].source, 'env-port');
});

test('un OXIDEGATE_PORT que no es un puerto se ignora en vez de fabricar una URL rota', () => {
  for (const basura of ['', '   ', 'ocho mil', '-1', '70000', '80.5']) {
    const candidatos = buildEndpointCandidates({ env: { OXIDEGATE_PORT: basura }, loggedUrl: null });
    assert.equal(
      candidatos.some((c) => c.source === 'env-port'),
      false,
      `"${basura}" no debería producir un candidato`,
    );
  }
});

// ------------------------------------------------------------------- chooseEndpoint

// `verify` es la única puerta al mundo real, y va inyectada: el módulo no
// hace fetch. Aquí se simula un mapa de puerto -> qué vive ahí.
const verificadorDe = (mundo, registro = []) => async (baseUrl) => {
  registro.push(baseUrl);
  return mundo[baseUrl] ?? { reachable: false, isOxidegate: false };
};

const OXIDEGATE = { reachable: true, isOxidegate: true };
const WORDPRESS = { reachable: true, isOxidegate: false };

test('EL CASO QUE ORIGINA EL MÓDULO: el okupa contesta y aun así se le descarta', async () => {
  const mundo = {
    'http://127.0.0.1:8080': WORDPRESS,
    'http://127.0.0.1:8899': OXIDEGATE,
  };

  const resultado = await chooseEndpoint({
    candidates: buildEndpointCandidates({ env: {}, loggedUrl: null }),
    verify: verificadorDe(mundo),
  });

  assert.equal(resultado.status, 'found');
  assert.equal(resultado.baseUrl, 'http://127.0.0.1:8899');
});

test('contestar no basta: si NADA es OxideGate, no se elige nada', async () => {
  // La tentación es devolver "bueno, algo contestó". Eso es exactamente el
  // fallo original: el WordPress contestaba.
  const mundo = { 'http://127.0.0.1:8080': WORDPRESS, 'http://127.0.0.1:8899': WORDPRESS };

  const resultado = await chooseEndpoint({
    candidates: buildEndpointCandidates({ env: {}, loggedUrl: null }),
    verify: verificadorDe(mundo),
  });

  assert.equal(resultado.status, 'not-found');
  assert.equal(resultado.baseUrl, undefined);
});

test('el resultado cuenta TODO lo que probó, también lo que falló', async () => {
  const mundo = { 'http://127.0.0.1:8080': WORDPRESS };

  const resultado = await chooseEndpoint({
    candidates: buildEndpointCandidates({ env: {}, loggedUrl: null }),
    verify: verificadorDe(mundo),
  });

  const okupa = resultado.tried.find((t) => t.baseUrl === 'http://127.0.0.1:8080');
  assert.equal(okupa.reachable, true);
  assert.equal(okupa.isOxidegate, false);
  assert.ok(resultado.tried.length >= 2, 'no se detuvo en el primero que contestó');
});

test('para en cuanto encuentra: no gasta peticiones de más', async () => {
  const registro = [];
  const mundo = { 'http://127.0.0.1:8080': OXIDEGATE, 'http://127.0.0.1:8899': OXIDEGATE };

  await chooseEndpoint({
    candidates: buildEndpointCandidates({ env: {}, loggedUrl: null }),
    verify: verificadorDe(mundo, registro),
  });

  assert.deepEqual(registro, ['http://127.0.0.1:8080']);
});

test('descubrir no es desobedecer en silencio: dice que ignoró lo que le pidieron', async () => {
  const mundo = {
    'http://127.0.0.1:8080': WORDPRESS, // aquí apunta el usuario, y se equivoca
    'http://127.0.0.1:8899': OXIDEGATE, // aquí está de verdad, según el log
  };

  const resultado = await chooseEndpoint({
    candidates: buildEndpointCandidates({
      env: { OXIDEGATE_PORT: '8080' },
      loggedUrl: 'http://127.0.0.1:8899',
    }),
    verify: verificadorDe(mundo),
  });

  assert.equal(resultado.status, 'found');
  assert.equal(resultado.baseUrl, 'http://127.0.0.1:8899');
  assert.equal(resultado.source, 'proxy-log');
  // Lo que el usuario pidió, y que resultó no ser OxideGate. Sin esto la
  // lente le arregla el problema y le deja el error para la próxima.
  assert.equal(resultado.overrode.baseUrl, 'http://127.0.0.1:8080');
  assert.equal(resultado.overrode.source, 'env-port');
});

test('si lo explícito ES correcto, no hay nada que anunciar', async () => {
  const resultado = await chooseEndpoint({
    candidates: buildEndpointCandidates({ env: { OXIDEGATE_PORT: '8899' }, loggedUrl: null }),
    verify: verificadorDe({ 'http://127.0.0.1:8899': OXIDEGATE }),
  });

  assert.equal(resultado.source, 'env-port');
  assert.equal(resultado.overrode, null);
});

test('solo se anuncia el atropello de una orden EXPLÍCITA, no el de un puerto adivinado', async () => {
  // El 8080 lo probó la propia herramienta porque es su default histórico,
  // no porque nadie se lo pidiera. Anunciar "ignoré el 8080" cuando el
  // usuario jamás lo mencionó es ruido que le hace buscar un error que no
  // ha cometido.
  const mundo = { 'http://127.0.0.1:8080': WORDPRESS, 'http://127.0.0.1:8899': OXIDEGATE };

  const resultado = await chooseEndpoint({
    candidates: buildEndpointCandidates({ env: {}, loggedUrl: null }),
    verify: verificadorDe(mundo),
  });

  assert.equal(resultado.overrode, null);
});

test('un verify que revienta no tumba la búsqueda: ese candidato se descarta y se sigue', async () => {
  const explota = async (baseUrl) => {
    if (baseUrl === 'http://127.0.0.1:8080') throw new Error('ECONNRESET');
    return OXIDEGATE;
  };

  const resultado = await chooseEndpoint({
    candidates: buildEndpointCandidates({ env: {}, loggedUrl: null }),
    verify: explota,
  });

  assert.equal(resultado.status, 'found');
  assert.equal(resultado.baseUrl, 'http://127.0.0.1:8899');
});

test('sin candidatos no se inventa ninguno', async () => {
  const resultado = await chooseEndpoint({ candidates: [], verify: async () => OXIDEGATE });

  assert.equal(resultado.status, 'not-found');
  assert.deepEqual(resultado.tried, []);
});
