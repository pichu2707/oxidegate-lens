# oxidegate-lens

`oxidegate-lens` es una capa de presentación para [OxideGate](https://github.com/pichu2707/OxideGate), un proxy local en Rust que mide costo, tokens y latencia entre clientes de IA y proveedores. Este proyecto solo lee los endpoints `GET /stats` y `GET /requests` de OxideGate por HTTP: nunca mide nada por cuenta propia, y no debe construirse para hacerlo.

## La pregunta que responde

Cada servidor MCP conectado añade sus esquemas de herramientas al cuerpo de
**todas** las peticiones, se usen o no. Se reenvían y se releen en cada turno.
`oxidegate-savings` dice cuánto pesa cada uno y cuánto se dejaría de enviar al
desconectarlo:

```sh
OXIDEGATE_PORT=8899 npx oxidegate-savings
```

```
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

Dos advertencias que la salida repite, porque ignorarlas lleva a conclusiones
falsas:

- **Son bytes medidos en el cable, no tokens ni dólares.** Cada proveedor
  tokeniza distinto, así que convertirlos exigiría una constante que no se
  tiene. Un byte medido es un hecho; un token inferido, una conjetura.
- **Las filas `native` no se quitan desconectando nada.** Son la superficie de
  herramientas del propio agente. Sólo se reducen con `--tools <lista>`, que
  cambia lo que el agente **puede hacer**, no sólo lo que carga. Y ojo:
  `--disallowedTools` no sirve para esto, porque es una puerta de permisos y no
  de carga — el esquema viaja igual.

## Ruta rápida

1. Confirmar que OxideGate está en ejecución y accesible (por ejemplo en `http://127.0.0.1:8899`).
2. Ejecutar `oxidegate-savings` para ver qué servidores MCP se están pagando en cada petición.
3. Opcionalmente, configurar la status line de Claude Code con el bloque de `examples/claude-settings.json`, apuntando al script `bin/oxidegate-status.mjs`.

## Qué es y qué no es

`oxidegate-lens` es una vitrina: toma los datos ya calculados por OxideGate y los presenta en dos superficies distintas, la status line de Claude Code y (de forma experimental) un plugin de OpenCode.

No es un medidor. La razón es de capas: el proxy ve los bytes y tokens exactos que viajan por la red entre el cliente y el proveedor. Un plugin dentro del agente solo ve la intención del agente, no el tráfico real de la red. Son capas distintas con visibilidad distinta, y duplicar la medición dentro de un plugin perdería precisión sin ganar nada a cambio.

En consecuencia:

- Este proyecto nunca mide costo, tokens ni latencia por su cuenta.
- Este proyecto solo lee `GET /stats` y `GET /requests` sobre HTTP.
- Si en algún momento surge la idea de que el plugin "mida en paralelo" para no depender del proxy, la respuesta correcta es no: eso reintroduce exactamente el problema que esta separación de capas busca evitar.

## Por qué es un proyecto aparte

`oxidegate-lens` vive en un repositorio propio, separado de OxideGate, por las siguientes razones:

- OxideGate es la fuente de verdad: un proxy en Rust con su propio ciclo de vida, pruebas y versionado.
- Esta capa de presentación tiene un ciclo de cambio distinto (scripts de status line, plugins de editores) y dependencias distintas (Node, la API de plugins de OpenCode).
- Mezclar ambos en un mismo repositorio acoplaría el versionado de un proxy de medición con el de scripts de visualización, sin necesidad real.

## Requisitos

- OxideGate en ejecución y accesible por HTTP (puerto por defecto 8080; en desarrollo puede estar en otro puerto, por ejemplo 8899, mediante la variable `OXIDEGATE_PORT`).
- Node 24 o superior (se usan `fetch` y `AbortSignal.timeout` globales, sin dependencias externas).

## Instalación de la status line

Claude Code permite configurar un comando externo como status line en `~/.claude/settings.json`. El bloque exacto (ver `examples/claude-settings.json`) es:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/absolute/path/to/oxidegate-lens/bin/oxidegate-status.mjs",
    "padding": 2,
    "refreshInterval": 5
  }
}
```

El valor de `command` debe reemplazarse por la ruta absoluta real al archivo `bin/oxidegate-status.mjs` dentro de la copia local de este proyecto (el valor de ejemplo `/absolute/path/to/oxidegate-lens/...` es solo un marcador de posición). Este bloque es un ejemplo dentro de este proyecto: no modifica el archivo `~/.claude/settings.json` real de nadie; cada persona debe copiarlo a mano en su propia configuración.

Claude Code envía por stdin un payload JSON con campos como `model.display_name`, `cwd`, `cost.total_cost_usd` y `context_window.used_percentage`, e invoca el comando después de cada mensaje del asistente, después de `/compact`, en cada cambio de modo de permisos, y cada `refreshInterval` segundos (con un debounce de 300 ms). El comando debe escribir texto plano por stdout; cada línea se convierte en una fila de la status line.

## Qué muestra cada campo y qué señala

La línea que imprime `bin/oxidegate-status.mjs` tiene esta forma:

```
oxidegate  claude-opus-4-8  tax 89.5%  tools 159.1 kB  ttft 3.0s  $0.2464
```

| Campo | Qué es | Qué puede señalar |
|-------|--------|---------------------|
| modelo | El modelo de la solicitud más reciente con `context_measured_bytes` no nulo. | Confirma contra qué proveedor/modelo se está trabajando en ese momento. |
| `tax` | `context_tax_ratio`: proporción del contexto que no corresponde al último turno (system, tools, historial). | Un valor alto sostenido sugiere que gran parte del contexto enviado es "impuesto" repetido (herramientas, historial) y no contenido nuevo del turno. |
| `tools` | `context_tools_bytes` humanizado en base 1000. | Un valor alto puede indicar muchos servidores MCP o herramientas nativas cargadas, aportando bytes en cada solicitud. |
| `ttft` | `ttft_ms` convertido a segundos. | Tiempo hasta el primer token; valores altos pueden reflejar carga del proveedor o un contexto grande de procesar. |
| costo | `cost_estimate_usd` formateado como `$X.XXXX`. | Costo estimado de esa solicitud puntual, no un acumulado. |

Estos valores son descriptivos, no prescriptivos: la línea muestra qué ocurrió en la última solicitud medida, sin indicar por sí misma si eso está bien o mal. Cualquier valor ausente, nulo o indefinido se muestra como `-`, nunca como `0` (convención tomada de OxideGate: un hueco honesto es preferible a un cero falso).

## El plugin de OpenCode (experimental)

El archivo `opencode/oxidegate-lens.ts` es **experimental y no verificado**. Está escrito contra la documentación pública de OpenCode (`https://opencode.ai/docs/plugins/` y `https://opencode.ai/docs/providers/`), que es dinámica y no versionada. La forma exacta del hook usado (`tool.execute.after`) no fue probada contra una instancia real de OpenCode en ejecución.

Advertencia importante: este plugin **no puede** configurar el `baseURL` de un proveedor. Eso corresponde a un bloque `"provider"` de nivel superior en `opencode.json` (ver `examples/opencode.json`), que debe agregarse a mano. Sin ese bloque, el tráfico real de modelos de OpenCode nunca pasa por OxideGate, y el plugin no tiene datos nuevos que leer. El plugin únicamente lee `GET /requests` después de que una solicitud ya ocurrió; no intercepta ni mide tráfico por su cuenta.

## Limitaciones conocidas

- La documentación de la status line de Claude Code no especifica un timeout para el comando externo. Por eso el script acota su propia solicitud HTTP (300 ms) y termina en silencio ante cualquier falla.
- La API de hooks de plugins de OpenCode no fue verificada contra una instancia real; puede diferir de lo documentado.
- Los endpoints de OxideGate (`/stats` y `/requests`) nunca exponen `prompt_hash`, `prompt_bytes` ni nombres de herramientas; solo etiquetas de servidor y conteos de bytes.

## Qué está verificado y qué no

**Verificado** (contra fuentes vivas, el día de creación de este proyecto):

- El mecanismo de la status line de Claude Code, según `https://code.claude.com/docs/en/statusline`.
- La forma de `GET /stats` y `GET /requests` de OxideGate, probada en vivo contra una instancia en ejecución en el puerto 8899.

**No verificado**:

- La API de hooks de plugins de OpenCode (`opencode/oxidegate-lens.ts`), tomada de documentación pública sin haber sido probada contra una instancia real.

## Enlace a OxideGate

https://github.com/pichu2707/OxideGate
