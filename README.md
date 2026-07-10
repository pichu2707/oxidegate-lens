# oxidegate-lens

Muestra **cuántos bytes te cuesta cada servidor MCP en cada petición** y cuánto
dejarías de enviar al desconectarlo. Lee esos datos de [OxideGate](https://github.com/pichu2707/OxideGate)
(un proxy local en Rust); **nunca mide nada por su cuenta**.

---

## Empezá acá

Un solo camino, tres pasos:

| | Paso | Comando / acción |
|--|------|------------------|
| **1** | Encendé OxideGate y confirmá que responde | `curl http://127.0.0.1:8899/stats` debe devolver datos |
| **2** | Corré el reporte de ahorro | `OXIDEGATE_PORT=8899 node bin/oxidegate-savings.mjs` |
| **3** | Leé la tabla | ↓ es exactamente lo que vas a ver |

```
fuente: 2026-07-10T19:26:53Z  claude-opus-4-8  (anthropic)

SERVIDOR                      KIND     TOOLS       BYTES   % TOOLS  ¿SE PUEDE QUITAR?
(native)                      native      29     86.2 kB     54.2%  no, sólo con --tools
claude_ai_Gmail               mcp         13     24.3 kB     15.3%  sí, desconectándolo
claude_ai_Google_Calendar     mcp          8     21.1 kB     13.2%  sí, desconectándolo
plugin_engram_engram          mcp         18     17.7 kB     11.1%  sí, desconectándolo
claude_ai_Google_Drive        mcp          8      9.7 kB      6.1%  sí, desconectándolo
overhead (corchetes/comas)    -            -        77 B         -

ahorro por petición desconectando los 4 servidores MCP: 72.9 kB (45.8% de los tools)
ya re-enviados en 10 peticiones observadas: 728.6 kB
```

> **Si la tabla sale vacía**, es por una de tres razones, en este orden:
> (1) OxideGate está apagado, (2) el puerto no es el que pusiste en `OXIDEGATE_PORT`,
> o (3) todavía no pasó ninguna petición **con MCP** por el proxy. No hay una cuarta.

Alternativa cómoda: `npm link` una vez y después llamás `oxidegate-savings` desde
cualquier lado (en vez de `node bin/oxidegate-savings.mjs`).

### Qué significa cada columna

| Columna | Qué es |
|---------|--------|
| `SERVIDOR` | El servidor que aporta esas herramientas (`(native)` es el propio agente). |
| `KIND` | `mcp` = servidor MCP conectado; `native` = superficie del agente. |
| `TOOLS` | Cuántas herramientas declara ese servidor. |
| `BYTES` | Cuánto pesan sus esquemas en el cuerpo de **cada** petición. |
| `% TOOLS` | Qué porción del total de herramientas representa. |
| `¿SE PUEDE QUITAR?` | `mcp` → sí, desconectándolo. `native` → sólo con `--tools`. |

---

## Cómo funciona en 30 segundos

```
OxideGate (proxy en Rust)            oxidegate-lens (este repo)
  ve el tráfico real         GET      solo LEE y MUESTRA
  entre cliente y proveedor  ───────▶   oxidegate-savings → la tabla de arriba
  mide bytes por servidor  /stats
                           /requests
```

OxideGate **mide**; este repo **muestra**. Son dos capas con visibilidad distinta:
el proxy ve los bytes exactos en la red; un plugin dentro del agente solo vería la
intención del agente, no el tráfico real. Por eso el lens nunca duplica la
medición — la perdería sin ganar nada.

---

## Las dos advertencias que la salida repite

Ignorarlas lleva a conclusiones falsas:

- **Son bytes medidos en el cable, no tokens ni dólares.** Cada proveedor
  tokeniza distinto, así que convertirlos exigiría una constante que no se tiene.
  Un byte medido es un hecho; un token inferido, una conjetura.
- **Las filas `native` no se quitan desconectando nada.** Son la superficie de
  herramientas del propio agente. Sólo se reducen con `--tools <lista>`, que
  cambia lo que el agente **puede hacer**, no sólo lo que carga. Ojo:
  `--disallowedTools` no sirve — es una puerta de permisos, no de carga; el
  esquema viaja igual.

---

## Requisitos

- **OxideGate** en ejecución y accesible por HTTP (puerto por defecto `8080`; en
  desarrollo suele ser otro, ej. `8899`, vía la variable `OXIDEGATE_PORT`).
- **Node 24 o superior** (usa `fetch` y `AbortSignal.timeout` globales, sin
  dependencias externas).

---

## Superficies avanzadas (experimentales)

El reporte de ahorro de arriba es el camino principal y está verificado. Estas
otras dos superficies existen, pero son secundarias — instalarlas y su
paso a paso están en **[docs/GUIA-INSTALACION.md](docs/GUIA-INSTALACION.md)**.

- **Status line de Claude Code** (`bin/oxidegate-status.mjs`): imprime una línea
  de resumen por-petición (`model  tax  tools  ttft  costo`). El mecanismo está
  verificado, pero es una vista secundaria, no el ahorro por MCP.
- **Plugin de OpenCode** (`opencode/oxidegate-lens.ts`): **experimental y no
  probado** contra un OpenCode real. El hook usado (`tool.execute.after`) no fue
  verificado. Además, por sí solo no enruta nada: hace falta un bloque `provider`
  en `opencode.json` (ver `examples/opencode.json`) para que el tráfico pase por
  OxideGate. Tratalo como punto de partida, no como integración probada.

---

## En qué harnesses sirve

Medir el costo de MCP no aplica igual en todos los asistentes de código. Algunos
ya difieren los esquemas (Claude Code), otros llaman desde su nube y no se pueden
medir en local (Warp), y solo uno expone un slot de UI para un panel propio
(OpenCode). El mapa completo — con la trampa de que «acepta base_url» no significa
«medible» — está en **[docs/COMPATIBILIDAD-HARNESSES.md](docs/COMPATIBILIDAD-HARNESSES.md)**.

---

## Por qué es un repo aparte

`oxidegate-lens` vive separado de OxideGate a propósito:

- OxideGate es la fuente de verdad: un proxy en Rust con su propio ciclo de vida,
  pruebas y versionado.
- Esta capa de presentación cambia por otras razones (scripts, plugins de
  editores) y depende de otras cosas (Node). Mezclarlas acoplaría el versionado
  de un medidor con el de scripts de visualización, sin necesidad real.

---

## Qué está verificado y qué no

**Verificado** (contra fuentes vivas, el día de creación del proyecto):

- La forma de `GET /stats` y `GET /requests` de OxideGate, probada en vivo contra
  una instancia en el puerto 8899.
- El mecanismo de la status line de Claude Code (`https://code.claude.com/docs/en/statusline`).

**No verificado**:

- La API de hooks de plugins de OpenCode (`opencode/oxidegate-lens.ts`), tomada de
  documentación pública sin probar contra una instancia real.

---

## Enlace a OxideGate

https://github.com/pichu2707/OxideGate
