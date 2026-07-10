# Guía de instalación — paso a paso

Pensada para alguien **sin experiencia técnica**. Seguí los pasos en orden,
copiá y pegá lo que se indica, y funciona.

`oxidegate-lens` **no mide nada**: solo muestra datos que ya calculó OxideGate.
Por eso, la regla que no falla:

> **Si OxideGate no está encendido, no hay nada para mostrar. Nunca.**

Este proyecto tiene **una superficie principal** (el reporte de ahorro) y **dos
avanzadas** (experimentales). Si es tu primera vez, hacé **solo la Parte A**. Las
partes B y C son opcionales.

---

## Antes de empezar

Marcá cada casilla:

- [ ] **OxideGate encendido** y respondiendo (por ejemplo en `http://127.0.0.1:8899`).
- [ ] **Node 24 o superior**. Para comprobarlo, en una terminal:
  ```sh
  node --version
  ```
  Si ves `v24.` o mayor, estás bien.
- [ ] Saber **en qué puerto** corre tu OxideGate. Por defecto es `8080`, pero
  suele ser otro (ej. `8899`). Anotalo: lo vas a usar varias veces.

> En esta guía usamos **8899** como ejemplo. Si el tuyo es otro, reemplazá `8899`
> por tu número en todos lados.

### Comprobá que OxideGate está encendido

```sh
curl http://127.0.0.1:8899/stats
```

- Aparece texto con datos → **encendido**. Seguí.
- Dice `Connection refused` → **apagado**. Encendé OxideGate y volvé a probar.

---

# Parte A — El reporte de ahorro (principal)

Esto es lo que responde "¿cuánto peso me ahorro desconectando cada servidor MCP?".
Es un **comando de terminal**, no un panel dentro de ningún editor.

### Paso 1 — Ubicarte en la carpeta del proyecto

En la terminal, entrá a la carpeta de `oxidegate-lens` (donde está este repo).

### Paso 2 — Correr el reporte

```sh
OXIDEGATE_PORT=8899 node bin/oxidegate-savings.mjs
```

Eso es todo. Vas a ver una tabla con cada servidor MCP, cuántos bytes pesa, y
cuánto ahorrarías desconectándolo.

> **Truco opcional para no escribir la ruta larga cada vez:** una sola vez, corré
> `npm link` dentro de la carpeta. Después podés llamar `oxidegate-savings` desde
> cualquier lugar:
> ```sh
> OXIDEGATE_PORT=8899 oxidegate-savings
> ```

### ¿Salió vacío o dio error?

Revisá, en este orden (el 90% está en los dos primeros):

1. **¿OxideGate está encendido?** `curl http://127.0.0.1:8899/stats` tiene que responder.
2. **¿El puerto es el correcto?** El de `OXIDEGATE_PORT` debe ser el de tu OxideGate.
3. **¿Pasó tráfico real con MCP?** El reporte muestra la última petición **con
   herramientas declaradas**. Si recién arrancaste todo, usá tu agente un rato y
   volvé a correr el comando.

**Con la Parte A ya tenés lo esencial del proyecto.** Lo de abajo es opcional.

---

# Parte B — Status line de Claude Code (avanzado)

Muestra una línea de resumen por-petición en la barra de estado de Claude Code
(`model  tax  tools  ttft  costo`). **No** es el reporte de ahorro: es otra vista.

### Paso 1 — Editar la configuración de Claude Code

El archivo está en `~/.claude/settings.json`. Hacé una copia primero:

```sh
cp ~/.claude/settings.json ~/.claude/settings.json.bak
```

Agregá este bloque (poné la **ruta absoluta real** al script dentro de tu copia
del proyecto):

```json
"statusLine": {
  "type": "command",
  "command": "/home/TU_USUARIO/oxidegate-lens/bin/oxidegate-status.mjs",
  "padding": 2,
  "refreshInterval": 5
}
```

### Paso 2 — Reiniciar Claude Code

Cerralo y abrilo. En la barra de estado deberías ver algo como:

```
oxidegate  claude-opus-4-8  tax 89.5%  tools 159.1 kB  ttft 3.0s  $0.2464
```

Igual que siempre: la status line solo **muestra**. Para que haya datos, el
tráfico de Claude tiene que pasar por OxideGate (eso se configura del lado de
**OxideGate**, no acá).

---

# Parte C — Plugin de OpenCode (EXPERIMENTAL)

> ⚠️ **Aviso honesto:** este plugin **nunca se probó** contra un OpenCode real.
> El hook que usa (`tool.execute.after`) no está verificado. Puede no funcionar
> como se describe. Es un punto de partida, no una integración probada. Si estás
> empezando, **salteate esta parte**.

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

Agregá **dos cosas**:

**a) El bloque del proveedor** (la pieza que enruta). Cambiá `8899` por tu puerto:

```json
"provider": {
  "oxidegate": {
    "npm": "@ai-sdk/openai-compatible",
    "options": { "baseURL": "http://127.0.0.1:8899/v1" },
    "models": { "claude-opus-4-8": {} }
  }
}
```

**b) El plugin en la lista `plugin`** (usá tu ruta real de usuario):

```
"file:///home/TU_USUARIO/.config/opencode/plugins/oxidegate-lens.ts"
```

> ⚠️ El JSON es quisquilloso con las comas: cada elemento se separa con coma,
> **menos el último**. Un error al abrir OpenCode casi siempre es una coma de más
> o de menos.

### Paso 3 — La API key

OxideGate es un **proxy transparente**: la API key que pongas se **reenvía al
proveedor real de arriba** (para `claude-opus-4-8`, Anthropic). No es una key
"de OxideGate". Al arrancar, OpenCode te la va a pedir.

- Probá primero con un valor cualquiera (ej. `sk-oxidegate-local`). Si OxideGate
  no valida la key del cliente, con eso alcanza.
- Si da error de auth, poné tu **API key real de Anthropic** (`sk-ant-...`).

> Tu login por OAuth de Anthropic (el del CLI) **no** cubre este camino: es para
> el proveedor nativo, no para este `openai-compatible` que pasa por el proxy.

### Paso 4 — Elegir el modelo y reiniciar

Dentro de OpenCode, usá el modelo del proveedor **`oxidegate`** (si usás otro, el
tráfico no pasa por el proxy). Reiniciá OpenCode. La primera vez tarda un poco
porque instala solo el paquete del proveedor.

---

## Cómo desinstalar

**Reporte de ahorro (Parte A):** nada que desinstalar; es solo un comando. Si
hiciste `npm link`, corré `npm unlink -g oxidegate-lens`.

**Status line (Parte B):** borrá el bloque `statusLine` de
`~/.claude/settings.json`, o restaurá tu copia `.bak`.

**Plugin OpenCode (Parte C):** borrá el bloque `provider.oxidegate` y la línea
del plugin en `opencode.json`, y borrá
`~/.config/opencode/plugins/oxidegate-lens.ts`. O restaurá tu copia `.bak`.

---

## En una frase

**OxideGate mide y enruta. `oxidegate-lens` solo muestra.** Empezá por la Parte A
(el reporte de ahorro): es el corazón del proyecto y lo único que necesitás para
responder "¿cuánto me ahorro desconectando MCP?".
