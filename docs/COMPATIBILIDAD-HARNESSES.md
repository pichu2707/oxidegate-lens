# Compatibilidad de harnesses — dónde sirve medir el costo de MCP

Este documento responde una sola pregunta: **¿en qué asistentes de código (harnesses)
sirve `oxidegate-lens`, y de qué forma?** Está basado en un barrido de ~18 herramientas
y en mediciones reales sobre el cable con OxideGate, no en suposiciones.

Si venís a instalar, andá a [`GUIA-INSTALACION.md`](./GUIA-INSTALACION.md). Esto es el
mapa de terreno: qué se puede medir, qué no, y por qué.

---

## Las dos formas del producto

No es un solo producto. Son dos, y no cubren lo mismo:

1. **Panel dentro del harness.** Un plugin que dibuja el costo de MCP en un panel
   persistente de la propia interfaz del agente. Necesita **tres cosas a la vez**:
   que el harness cargue los esquemas MCP *eager* (que haya algo que mostrar), que
   exponga un **slot de UI sancionado** para terceros, y que sea medible.

2. **Lens sobre el proxy.** Lo que ya hace este repo: leer los datos que OxideGate
   captura en el cable. No necesita la UI del harness. Solo necesita **poder meter
   OxideGate en medio** de las llamadas al modelo.

La forma (1) es escasa. La forma (2) es casi universal… **con una trampa** que se
explica abajo.

---

## La trampa: «acepta base_url» NO significa «medible»

Es el aprendizaje más importante del barrido, y cuesta caro si no se sabe.

Que un harness te deje configurar un `base_url` propio **no garantiza** que puedas
medirlo con un proxy local. Lo que decide es **desde dónde se ejecuta la llamada**:

- **Cliente** (desde tu máquina): un proxy local en `localhost` sí ve el tráfico.
- **Nube** (desde el servidor del harness): `localhost` es *su* localhost, no el
  tuyo. Inalcanzable. Solo medible con un túnel público, y ni así es el cable local.

**Warp es el ejemplo canónico:** acepta `base_url`, parecía medible, y no lo es —
su backend arma la request y llama a tu endpoint desde su nube, rechazando `localhost`
de forma explícita. Ver la fila de Warp abajo.

Por eso la columna que importa no es «¿acepta base_url?» sino **«¿medible en local?»**.

---

## La matriz

| Harness | Carga eager | Slot UI de terceros | Medible en local | Clasificación |
|---|---|---|---|---|
| **OpenCode** | Sí | Sí (`slots.register`) | **Sí, verificado** | **Target in-harness (único limpio)** |
| Claude Code | No (difiere por defecto) | Sí (statusline/plugins) | Sí, verificado | Ya resuelto — nada que mostrar |
| **Codex CLI** | Desconocido | No | Sí, verificado | Lens sobre proxy |
| **Gemini CLI** | Desconocido | No | Sí, verificado | Lens sobre proxy |
| pi.dev | No (lazy por defecto; eager opt-in) | Widget/statusline (sin sidebar) | Probable (pendiente) | Condicional (solo con servers eager) |
| openclaw.ai | Sí | No (habría que forkear el Gateway) | Probable (pendiente) | Lens sobre proxy |
| Cline | Desconocido | No (webview propia) | Probable (pendiente) | Lens sobre proxy |
| Roo Code | Desconocido | No | Probable (pendiente) | Lens sobre proxy |
| Kilo Code | Desconocido | No | Probable (pendiente) | Lens sobre proxy |
| Continue.dev | Desconocido | No | Probable (pendiente) | Lens sobre proxy |
| Aider | Desconocido (MCP experimental) | No | Probable (pendiente) | Lens sobre proxy |
| Crush | Desconocido | No | Probable (pendiente) | Lens sobre proxy |
| Void | Desconocido | No | Probable (pendiente) | Lens sobre proxy |
| Qwen Code | Desconocido | No | Probable (pendiente) | Lens sobre proxy |
| Goose | Probable (host MCP) | No (solo UI de respuesta de tool) | Probable (pendiente) | Lens sobre proxy |
| **Warp** | Sí (server-side) | No | **No — llama desde su nube, rechaza localhost** | Solo con túnel público |
| Cursor | Sí | No | Solo el chat (el agente va a su backend) | Fuera |
| Amp | Desconocido | No (solo modales) | No (backend fijo) | Fuera |
| Windsurf | Desconocido | No | No (backend propietario) | Fuera |
| Kiro | Desconocido | No | No (proveedores curados) | Fuera |

**Leyenda de «Medible en local»:**
- **Verificado** — se corrió tráfico real a través de OxideGate y se capturó.
- **Probable (pendiente)** — acepta `base_url`, pero falta confirmar cliente-vs-nube.
- **No** — la arquitectura impide un proxy local (nube, backend cerrado).

---

## Conclusiones

1. **Para el panel dentro del harness, OpenCode es el único target limpio.** Barrido
   exhaustivo: ningún otro harness documenta un slot de UI persistente para terceros
   junto con carga eager. El `slots.register` de OpenCode es único.

2. **Para el lens sobre proxy, el alcance es amplio pero hay que auditarlo.** Una
   docena de harnesses acepta `base_url`. Pero tras el caso Warp, ninguno se da por
   «medible» hasta confirmar que la llamada sale del cliente y no de la nube. Los
   verificados hoy son OpenCode, Claude Code, Codex CLI y Gemini CLI.

3. **Warp queda fuera del alcance local.** Orquesta en su nube y rechaza `localhost`.
   Medible solo con un túnel público, lo que no es un flujo razonable para un usuario.

4. **Claude Code no necesita esto.** Difiere los esquemas MCP por defecto (tool search):
   el costo ya está mitigado por el propio cliente. No hay ahorro que mostrar.

---

## Pendiente

- Re-auditar la columna «Medible en local» de cada fila marcada *Probable*, confirmando
  cliente-vs-nube antes de darla por buena.
- Medir OpenCode en local con OxideGate para cuantificar el MCP eager real por request.

_Última actualización: 2026-07-10._
