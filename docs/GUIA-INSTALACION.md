# Guía de instalación — paso a paso

Pensada para alguien **sin experiencia técnica**. Sigue los pasos en orden,
copia y pega lo que se indica, y funciona.

`oxidegate-lens` **no mide nada**: solo muestra datos que ya calculó OxideGate.
Por eso, la regla que no falla:

> **Si OxideGate no está encendido, no hay nada para mostrar. Nunca.**

Este proyecto tiene **una superficie principal** (el reporte de ahorro) y **dos
avanzadas** (experimentales). Si es tu primera vez, haz **solo la Parte A**. Las
partes B y C son opcionales.

---

## Antes de empezar

Marca cada casilla:

- [ ] **Node 24 o superior**. Para comprobarlo, en una terminal:
  ```sh
  node --version
  ```
  Si ves `v24.` o mayor, está bien.
- [ ] Tener el repo de **OxideGate** en tu máquina (es un proyecto aparte).
- [ ] (Opcional, sólo si usás Claude Code) el comando `claude` en tu PATH. El reporte
  lo usa para leer tu configuración MCP declarada y compararla contra lo que llegó al
  cable. Sin él, el reporte igual funciona — sólo pierde esa comparación y lo dice.

> En esta guía usamos el puerto **8899** en todos los ejemplos. Si eliges otro,
> sustituye `8899` por tu número en todos los comandos.

---

## Paso 0 — Encender OxideGate

Sin esto no hay nada que mostrar. Abre una terminal, entra en la carpeta de
OxideGate y lanza el proxy:

```sh
OXIDEGATE_PORT=8899 cargo run --bin oxidegate
```

**Deja esa terminal abierta**: el proxy vive ahí. Si la cierras, se apaga.

Cuando arranca bien, verás algo así:

```
🛰️  Escuchando en http://127.0.0.1:8899
📊 Estadísticas en vivo por modelo en http://127.0.0.1:8899/stats
🧾 Últimos requests en vivo en http://127.0.0.1:8899/requests
```

### Comprueba que responde

En **otra** terminal:

```sh
curl http://127.0.0.1:8899/stats
```

- Devuelve `[]` o datos → **encendido**. Sigue.
- Dice `Connection refused` → **apagado**. Vuelve arriba.

### ⚠️ El fallo más común: el puerto 8080 ya está ocupado

El puerto por defecto de OxideGate es el **8080** — el mismo que usan Apache,
Tomcat, Jenkins y media docena de herramientas más. Si lo tienes ocupado y
arrancas OxideGate sin `OXIDEGATE_PORT`, **no arranca** (`Address already in
use`), o peor: crees que arrancó y en realidad estás hablando con otro programa.

Para ver quién tiene cogido el 8080:

```sh
ss -ltn | grep :8080
```

No te pelees con el 8080. Usa otro puerto con `OXIDEGATE_PORT`, como hacemos
aquí con el 8899. **Ese mismo número tiene que ir en todos los pasos siguientes**
(el reporte, el bloque `provider` de OpenCode, el monitor).

---

# Parte A — El reporte de ahorro (principal)

Esto es lo que responde "¿cuánto peso me ahorro desconectando cada servidor MCP?" —
**cuando la respuesta es un ahorro real**. Es un **comando de terminal**, no un panel
dentro de ningún editor.

> **Importante si usás Claude Code:** necesita el comando `claude` en tu PATH — el
> reporte lo usa (`claude mcp list`) para leer cuántos servidores MCP tienes
> DISPONIBLES y compararlo contra lo que llegó al cable en `tools_by_server`. Esa
> resta se imprime en un bloque propio debajo de la tabla, y sólo dice el HECHO, sin
> elegir una causa:
>
> - Si tienes MÁS servidores disponibles de los que llegaron, el reporte te dice
>   cuáles faltan y se detiene ahí: puede ser que tu harness los esté reteniendo, o
>   que todavía no hayan terminado de conectar — las dos son causas reales y una
>   sola petición no alcanza para distinguirlas.
> - Si coinciden, lo dice y no agrega nada más.
> - Si no se pudo leer tu configuración disponible (por ejemplo, `claude` no está en
>   el PATH desde donde corres el reporte), lo dice explícitamente en vez de
>   adivinar — y nunca lo muestra igual que "0 servidores disponibles".
> - Si dos nombres de servidor DISTINTOS que tienes configurados colapsan al mismo
>   nombre en el cable (Claude Code reemplaza todo carácter fuera de
>   `[A-Za-z0-9_]` por `_`; `"foo bar"` y `"foo_bar"` sanitizan ambos a
>   `"foo_bar"`), el reporte no puede saber cuál de los dos llegó — lo dice y
>   saca ese par del conteo, en vez de fusionarlos en silencio.
> - Si la tabla trae una fila `(others)` (más de 32 servidores MCP distintos en la
>   misma petición: OxideGate solo trackea 32 de forma individual), un servidor
>   "sin fila propia" puede estar ahí adentro, sin nombre — el reporte lo dice en
>   vez de afirmar que no llegó.
>
> Además, en tráfico `anthropic` el reporte siempre agrega un aviso corto: algunos
> harnesses difieren esquemas MCP por defecto, pero ese diferido se cae a carga
> completa detrás de un `ANTHROPIC_BASE_URL` no-first-party — y OxideGate es
> exactamente eso. Te dice cómo comprobarlo vos mismo (repetir la petición sin el
> proxy), sin decidirlo por ti.
>
> **Ojo con una confusión distinta:** que Claude Code marque algún tool con
> `defer_loading` (columna nueva `tokens de contexto` al final del reporte) **no**
> abarata esa fila en bytes — el esquema sigue viajando entero en el body igual.
> Diferido ahorra contexto del modelo, no tráfico de red; `¿SE PUEDE QUITAR?` nunca
> lo consulta.

### Paso 1 — Ubicarte en la carpeta del proyecto

En la terminal, entra en la carpeta de `oxidegate-lens` (donde está este repo).

### Paso 2 — Correr el reporte

```sh
OXIDEGATE_PORT=8899 node bin/oxidegate-savings.mjs
```

Eso es todo. Vas a ver una tabla con cada servidor MCP y cuántos bytes pesa (siempre
desconectable, en bytes, si aparece en la tabla), un bloque aparte que compara
cuántos tienes disponibles contra cuántos llegaron a esta petición puntual, y un
aviso sobre el efecto del proxy en harnesses que difieren nativamente (ver arriba).

> **Truco opcional para no escribir la ruta larga cada vez:** una sola vez, ejecuta
> `npm link` dentro de la carpeta. Después puedes llamar a `oxidegate-savings` desde
> cualquier lugar:
> ```sh
> OXIDEGATE_PORT=8899 oxidegate-savings
> ```

### ¿Salió vacío o dio error?

Revisa, en este orden (el 90% está en los dos primeros):

1. **¿OxideGate está encendido?** `curl http://127.0.0.1:8899/stats` tiene que responder.
2. **¿El puerto es el correcto?** El de `OXIDEGATE_PORT` debe ser el de tu OxideGate.
3. **¿Pasó tráfico real con MCP?** El reporte muestra la última petición **con
   herramientas declaradas**. Si acabas de arrancarlo todo, usa tu agente un rato y
   vuelve a ejecutar el comando.

**Con la Parte A ya tienes lo esencial del proyecto.** Lo de abajo es opcional.

---

# Parte B — Plugin de OpenCode (EXPERIMENTAL)

> ⚠️ **Aviso honesto:** este plugin **nunca se probó** contra un OpenCode real.
> El hook que usa (`tool.execute.after`) no está verificado. Puede no funcionar
> como se describe. Es un punto de partida, no una integración probada. Si estás
> empezando, **sáltate esta parte**.

En OpenCode hacen falta **dos piezas**, no una:

| Pieza | Para qué sirve |
|-------|----------------|
| **1. El proveedor** (bloque `provider`) | Hace que el tráfico de OpenCode **pase por** OxideGate. Sin esto, OxideGate no ve nada. |
| **2. El plugin** | **Muestra** una línea por-petición. Sin la pieza 1, no tiene datos que mostrar. |

### Paso 1 — Copiar el plugin

```sh
cp opencode/oxidegate-lens.ts ~/.config/opencode/plugins/oxidegate-lens.ts
```

### Paso 2 — Editar `~/.config/opencode/opencode.json`

Copia de seguridad primero:

```sh
cp ~/.config/opencode/opencode.json ~/.config/opencode/opencode.json.bak
```

Añade **dos cosas**:

**a) El bloque del proveedor** (la pieza que enruta). Cambia `8899` por tu puerto:

```json
"provider": {
  "oxidegate": {
    "npm": "@ai-sdk/openai-compatible",
    "options": { "baseURL": "http://127.0.0.1:8899/v1" },
    "models": { "claude-opus-4-8": {} }
  }
}
```

**b) El plugin en la lista `plugin`** (usa tu ruta real de usuario):

```
"file:///home/TU_USUARIO/.config/opencode/plugins/oxidegate-lens.ts"
```

> ⚠️ El JSON es estricto con las comas: cada elemento se separa con coma,
> **menos el último**. Un error al abrir OpenCode casi siempre es una coma de más
> o de menos.

### Paso 3 — La API key

OxideGate es un **proxy transparente**: la API key que pongas se **reenvía al
proveedor real de arriba** (para `claude-opus-4-8`, Anthropic). No es una key
"de OxideGate". Al arrancar, OpenCode te la pedirá.

- Prueba primero con un valor cualquiera (ej. `sk-oxidegate-local`). Si OxideGate
  no valida la key del cliente, con eso alcanza.
- Si da error de auth, pon tu **API key real de Anthropic** (`sk-ant-...`).

> Tu login por OAuth de Anthropic (el del CLI) **no** cubre este camino: es para
> el proveedor nativo, no para este `openai-compatible` que pasa por el proxy.

### Paso 4 — Elegir el modelo y reiniciar

Dentro de OpenCode, usa el modelo del proveedor **`oxidegate`** (si usas otro, el
tráfico no pasa por el proxy). Reinicia OpenCode. La primera vez tarda un poco
porque instala solo el paquete del proveedor.

---

## Cómo desinstalar

**Reporte de ahorro (Parte A):** nada que desinstalar; es solo un comando. Si
hiciste `npm link`, ejecuta `npm unlink -g oxidegate-lens`.

**Plugin OpenCode (Parte B):** borra el bloque `provider.oxidegate` y la línea
del plugin en `opencode.json`, y borra
`~/.config/opencode/plugins/oxidegate-lens.ts`. O restaura tu copia `.bak`.

---

## En una frase

**OxideGate mide y enruta. `oxidegate-lens` solo muestra.** Empieza por la Parte A
(el reporte de ahorro): es el corazón del proyecto y lo único que necesitas para
responder "¿cuánto ahorro desconectando MCP?".
