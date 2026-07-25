// test/mcp-doctor.test.mjs
//
// Unit tests for lib/mcp-doctor.mjs — el diagnóstico de la cadena completa.
//
// Cada comprobación de este módulo es un fallo que mordió de verdad durante
// el desarrollo, y ninguno era evidente desde fuera:
//
//   - Un WordPress escuchando en el puerto por defecto, respondiendo 302 a
//     todo, indistinguible de "el proxy no ha visto tráfico".
//   - `/health` devolviendo 404 porque el binario instalado era anterior a
//     0.3.0, lo que hacía que el enrutado cayera a directo EN SILENCIO.
//   - `/requests` vacío durante toda una sesión sin que nada dijera por qué.
//   - Las tools aplanadas, que hacen imposible la mitad del producto.
//
// La regla que gobierna el módulo: **una comprobación que no se pudo hacer
// es `unknown`, nunca `ok`**, y un veredicto global no puede ser 'ok' si
// alguna quedó sin saber. Un diagnóstico que dice "todo bien" sobre algo que
// no miró es peor que no diagnosticar.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diagnose } from '../lib/mcp-doctor.mjs';

const sano = {
  baseUrl: 'http://127.0.0.1:8899',
  reachable: true,
  isOxidegate: true,
  healthCode: 200,
  requestCount: 12,
  flattened: false,
  snapshot: { status: 'known', freshness: 'fresh', servers: [{ name: 'engram' }] },
  protection: { status: 'known', servers: ['engram'], source: 'file' },
  switchResult: { status: 'known', enabled: true, source: 'file' },
};

const check = (result, id) => result.checks.find((c) => c.id === id);

test('todo sano -> veredicto ok y ninguna comprobación en fallo', () => {
  const result = diagnose(sano);

  assert.equal(result.verdict, 'ok');
  assert.equal(result.checks.filter((c) => c.status === 'fail').length, 0);
});

test('/health 404 nombra el fallo SILENCIOSO, que es lo que lo hacía indiagnosticable', () => {
  const result = diagnose({ ...sano, healthCode: 404, requestCount: 0 });

  const health = check(result, 'health');
  assert.equal(health.status, 'fail');
  // Sin esta frase el usuario ve un 404 y no sabe que la consecuencia es que
  // TODO su tráfico se va directo al proveedor sin avisar.
  assert.match(health.detail + health.action, /silencio|silencios/i);
  assert.match(health.detail + health.action, /0\.3\.0/, 'debe decir desde qué versión existe');
  assert.equal(result.verdict, 'broken');
});

test('algo responde pero no es OxideGate -> nombra al okupa del puerto', () => {
  const result = diagnose({ ...sano, isOxidegate: false, healthCode: 404, requestCount: 0 });

  const identity = check(result, 'identity');
  assert.equal(identity.status, 'fail');
  assert.match(identity.detail + identity.action, /OXIDEGATE_PORT/, 'la salida es cambiar de puerto');
  assert.equal(result.verdict, 'broken');
});

test('inalcanzable no es lo mismo que roto: el proxy simplemente no está', () => {
  const result = diagnose({ ...sano, reachable: false, isOxidegate: false, healthCode: null, requestCount: null });

  const reach = check(result, 'reachable');
  assert.equal(reach.status, 'fail');
  // Y las que dependen de haber llegado no pueden opinar.
  assert.equal(check(result, 'health').status, 'unknown');
  assert.equal(check(result, 'traffic').status, 'unknown');
});

test('sin tráfico avisa, pero no lo llama roto si todo lo demás responde', () => {
  const result = diagnose({ ...sano, requestCount: 0 });

  const traffic = check(result, 'traffic');
  assert.equal(traffic.status, 'warn');
  assert.match(traffic.detail + traffic.action, /enruta|routing|enrutado/i);
  assert.equal(result.verdict, 'degraded', 'un proxy sano sin tráfico no está roto, está sin usar');
});

test('tools aplanadas: dice que la mitad USO no puede funcionar, y que esperar no ayuda', () => {
  const result = diagnose({ ...sano, flattened: true });

  const flat = check(result, 'attribution');
  assert.equal(flat.status, 'warn');
  assert.match(flat.detail + flat.action, /no.*(cambia|ayuda|sirve)/i, 'esperar más tráfico no lo arregla');
});

test('sin snapshot: la mitad PRECIO no puede funcionar, y se nombra la herramienta que lo produce', () => {
  const result = diagnose({ ...sano, snapshot: { status: 'unknown', reason: 'missing-file' } });

  const snap = check(result, 'price');
  assert.equal(snap.status, 'warn');
  assert.match(snap.detail + snap.action, /mcp-savings/);
});

test('config ilegible es un FALLO, no un aviso: el plugin no desconectará nada', () => {
  const result = diagnose({ ...sano, protection: { status: 'unknown', reason: 'malformed-json', source: 'file' } });

  const cfg = check(result, 'config');
  assert.equal(cfg.status, 'fail');
  assert.match(cfg.detail + cfg.action, /malformed-json/, 'el usuario no puede arreglar un error que no se nombra');
});

test('una comprobación desconocida impide un veredicto "ok"', () => {
  // La invariante de siempre: no se afirma sobre lo que no se miró.
  const result = diagnose({ ...sano, healthCode: null });

  assert.equal(check(result, 'health').status, 'unknown');
  assert.notEqual(result.verdict, 'ok', 'no se puede declarar todo bien con una comprobación sin hacer');
  assert.equal(result.verdict, 'unknown');
});

test('cada comprobación trae una acción concreta, no solo un síntoma', () => {
  const result = diagnose({ ...sano, healthCode: 404, requestCount: 0, flattened: true });

  for (const c of result.checks) {
    if (c.status === 'ok') continue;
    assert.ok(c.action && c.action.length > 10, `"${c.id}" describe un síntoma sin decir qué hacer`);
  }
});

test('un 200 en /health de algo que NO es OxideGate no vale: es unknown, no ok', () => {
  // Cazado ejecutándolo contra el WordPress que ocupa el 8080 de la máquina
  // de desarrollo: redirige todo a wp-admin/install.php, que responde 200.
  // El doctor decía "✖ no es OxideGate" y dos líneas después "✔ el proxy está
  // vivo y sirviendo" — sobre el mismo servicio que acababa de descartar.
  const result = diagnose({ ...sano, isOxidegate: false, healthCode: 200, requestCount: null });

  const health = check(result, 'health');
  assert.equal(health.status, 'unknown', 'un 200 de un desconocido no dice nada sobre OxideGate');
  assert.notEqual(health.status, 'ok');
});
