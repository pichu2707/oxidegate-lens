// Conversor md -> HTML autocontenido, acotado al subconjunto que usa el
// informe: encabezados, tablas, listas, código, citas, negrita, hr.
// Los bloques ```mermaid se sustituyen por SVG escrito a mano, porque no hay
// mermaid-cli y el CSP de un Chrome headless offline no traería un CDN.
import { readFileSync, writeFileSync } from 'node:fs';

const SVGS = [
  // 1. Arquitectura
  `<svg viewBox="0 0 900 300" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="13">
    <defs><marker id="a" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#64748b"/></marker></defs>
    <rect x="10" y="120" width="140" height="52" rx="7" fill="#eef2ff" stroke="#6366f1"/>
    <text x="80" y="142" text-anchor="middle" fill="#312e81">Agente</text>
    <text x="80" y="159" text-anchor="middle" fill="#4f46e5" font-size="11">OpenCode / pi</text>
    <rect x="230" y="120" width="150" height="52" rx="7" fill="#ecfdf5" stroke="#10b981"/>
    <text x="305" y="142" text-anchor="middle" fill="#065f46">OxideGate</text>
    <text x="305" y="159" text-anchor="middle" fill="#047857" font-size="11">proxy local :8899</text>
    <rect x="460" y="20" width="150" height="52" rx="7" fill="#fef2f2" stroke="#ef4444"/>
    <text x="535" y="42" text-anchor="middle" fill="#7f1d1d">Proveedor</text>
    <text x="535" y="59" text-anchor="middle" fill="#b91c1c" font-size="11">OpenAI / Codex</text>
    <rect x="460" y="120" width="150" height="60" rx="7" fill="#f8fafc" stroke="#94a3b8"/>
    <text x="535" y="141" text-anchor="middle" fill="#334155" font-size="11">/requests · /stats</text>
    <text x="535" y="158" text-anchor="middle" fill="#334155" font-size="11">/health</text>
    <text x="535" y="174" text-anchor="middle" fill="#64748b" font-size="10">uso observado</text>
    <rect x="230" y="230" width="150" height="52" rx="7" fill="#fffbeb" stroke="#f59e0b"/>
    <text x="305" y="252" text-anchor="middle" fill="#78350f">mcp-savings</text>
    <text x="305" y="269" text-anchor="middle" fill="#b45309" font-size="11">snapshot.json</text>
    <rect x="700" y="120" width="180" height="70" rx="7" fill="#f5f3ff" stroke="#8b5cf6" stroke-width="2"/>
    <text x="790" y="145" text-anchor="middle" fill="#4c1d95" font-weight="600">oxidegate-lens</text>
    <text x="790" y="164" text-anchor="middle" fill="#6d28d9" font-size="11">une precio × uso</text>
    <text x="790" y="180" text-anchor="middle" fill="#7c3aed" font-size="10">no mide nada</text>
    <line x1="152" y1="146" x2="226" y2="146" stroke="#64748b" marker-end="url(#a)"/>
    <line x1="382" y1="135" x2="456" y2="60" stroke="#64748b" marker-end="url(#a)"/>
    <line x1="382" y1="150" x2="456" y2="150" stroke="#64748b" marker-end="url(#a)"/>
    <line x1="612" y1="150" x2="696" y2="150" stroke="#64748b" marker-end="url(#a)"/>
    <path d="M380,256 C560,256 640,210 700,180" stroke="#64748b" fill="none" marker-end="url(#a)"/>
    <text x="188" y="140" text-anchor="middle" fill="#64748b" font-size="10">tráfico</text>
    <text x="520" y="245" text-anchor="middle" fill="#64748b" font-size="10">precio medido</text>
  </svg>`,
  // 2. La cadena rota
  `<svg viewBox="0 0 900 260" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="13">
    <defs><marker id="b" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#64748b"/></marker>
    <marker id="br" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#dc2626"/></marker></defs>
    <rect x="20" y="15" width="150" height="40" rx="6" fill="#eef2ff" stroke="#6366f1"/>
    <text x="95" y="40" text-anchor="middle" fill="#312e81">fetch-patch</text>
    <rect x="360" y="15" width="170" height="40" rx="6" fill="#fef2f2" stroke="#ef4444"/>
    <text x="445" y="40" text-anchor="middle" fill="#7f1d1d">OxideGate 0.2.1</text>
    <rect x="700" y="15" width="150" height="40" rx="6" fill="#f8fafc" stroke="#94a3b8"/>
    <text x="775" y="40" text-anchor="middle" fill="#334155">Proveedor</text>
    <line x1="95" y1="60" x2="95" y2="240" stroke="#cbd5e1" stroke-dasharray="4"/>
    <line x1="445" y1="60" x2="445" y2="240" stroke="#cbd5e1" stroke-dasharray="4"/>
    <line x1="775" y1="60" x2="775" y2="240" stroke="#cbd5e1" stroke-dasharray="4"/>
    <line x1="97" y1="95" x2="441" y2="95" stroke="#64748b" marker-end="url(#b)"/>
    <text x="269" y="88" text-anchor="middle" fill="#334155" font-size="11">GET /health (probe)</text>
    <line x1="443" y1="130" x2="99" y2="130" stroke="#dc2626" marker-end="url(#br)"/>
    <text x="269" y="123" text-anchor="middle" fill="#dc2626" font-size="11" font-weight="600">404 — la ruta no existe en 0.2.1</text>
    <rect x="110" y="150" width="320" height="30" rx="4" fill="#fef9c3" stroke="#eab308"/>
    <text x="270" y="170" text-anchor="middle" fill="#713f12" font-size="11">alive = false → fallback SILENCIOSO</text>
    <line x1="97" y1="205" x2="771" y2="205" stroke="#dc2626" marker-end="url(#br)"/>
    <text x="430" y="198" text-anchor="middle" fill="#dc2626" font-size="11">petición directa: el proxy nunca la ve</text>
    <text x="445" y="238" text-anchor="middle" fill="#7f1d1d" font-size="11" font-weight="600">/requests queda vacío para siempre</text>
  </svg>`,
  // 3. Decisión de protección
  `<svg viewBox="0 0 900 300" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="12">
    <defs><marker id="c" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#64748b"/></marker></defs>
    <rect x="30" y="130" width="120" height="42" rx="6" fill="#f8fafc" stroke="#94a3b8"/>
    <text x="90" y="156" text-anchor="middle" fill="#334155">config.json</text>
    <path d="M250,151 L310,125 L370,151 L310,177 z" fill="#eef2ff" stroke="#6366f1"/>
    <text x="310" y="148" text-anchor="middle" fill="#312e81" font-size="11">¿se puede</text>
    <text x="310" y="162" text-anchor="middle" fill="#312e81" font-size="11">leer?</text>
    <rect x="470" y="20" width="200" height="52" rx="6" fill="#ecfdf5" stroke="#10b981"/>
    <text x="570" y="41" text-anchor="middle" fill="#065f46">known: nada protegido</text>
    <text x="570" y="58" text-anchor="middle" fill="#047857" font-size="10">el usuario nunca lo pidió</text>
    <rect x="470" y="125" width="200" height="52" rx="6" fill="#ecfdf5" stroke="#10b981"/>
    <text x="570" y="146" text-anchor="middle" fill="#065f46">known: la lista declarada</text>
    <text x="570" y="163" text-anchor="middle" fill="#047857" font-size="10">se aplica el plan</text>
    <rect x="470" y="230" width="200" height="56" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
    <text x="570" y="251" text-anchor="middle" fill="#7f1d1d" font-weight="600">unknown: SIN lista</text>
    <text x="570" y="268" text-anchor="middle" fill="#b91c1c" font-size="10">no se desconecta NADA</text>
    <text x="570" y="281" text-anchor="middle" fill="#b91c1c" font-size="10">y se avisa con la razón</text>
    <line x1="152" y1="151" x2="246" y2="151" stroke="#64748b" marker-end="url(#c)"/>
    <path d="M310,123 C310,70 400,46 466,46" stroke="#64748b" fill="none" marker-end="url(#c)"/>
    <line x1="372" y1="151" x2="466" y2="151" stroke="#64748b" marker-end="url(#c)"/>
    <path d="M310,179 C310,235 400,258 466,258" stroke="#dc2626" fill="none" marker-end="url(#c)"/>
    <text x="385" y="70" fill="#64748b" font-size="10">no existe</text>
    <text x="400" y="145" fill="#64748b" font-size="10">legible</text>
    <text x="330" y="245" fill="#dc2626" font-size="10">ilegible</text>
  </svg>`,
  // 4. Precedencia y puerta de aprobación
  `<svg viewBox="0 0 900 330" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="12">
    <defs><marker id="d" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#64748b"/></marker>
    <marker id="dr" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#dc2626"/></marker></defs>
    <rect x="20" y="18" width="190" height="40" rx="6" fill="#eef2ff" stroke="#6366f1"/>
    <text x="115" y="42" text-anchor="middle" fill="#312e81">¿Hay variable de entorno?</text>
    <rect x="330" y="18" width="150" height="40" rx="6" fill="#ecfdf5" stroke="#10b981"/>
    <text x="405" y="42" text-anchor="middle" fill="#065f46">Gana la variable</text>
    <rect x="20" y="95" width="190" height="40" rx="6" fill="#eef2ff" stroke="#6366f1"/>
    <text x="115" y="113" text-anchor="middle" fill="#312e81" font-size="11">¿Hay</text>
    <text x="115" y="127" text-anchor="middle" fill="#312e81" font-size="11">.oxidegate-lens.json?</text>
    <path d="M300,200 L420,165 L540,200 L420,235 z" fill="#fffbeb" stroke="#f59e0b" stroke-width="2"/>
    <text x="420" y="196" text-anchor="middle" fill="#78350f" font-size="11">¿El HASH de su</text>
    <text x="420" y="210" text-anchor="middle" fill="#78350f" font-size="11">contenido está aprobado?</text>
    <rect x="620" y="128" width="250" height="52" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
    <text x="745" y="149" text-anchor="middle" fill="#7f1d1d" font-weight="600">PENDIENTE — no se aplica</text>
    <text x="745" y="166" text-anchor="middle" fill="#b91c1c" font-size="10">y se avisa con el hash</text>
    <rect x="620" y="222" width="250" height="52" rx="6" fill="#ecfdf5" stroke="#10b981" stroke-width="2"/>
    <text x="745" y="243" text-anchor="middle" fill="#065f46" font-weight="600">Gana el proyecto</text>
    <text x="745" y="260" text-anchor="middle" fill="#047857" font-size="10">REEMPLAZANDO lo global</text>
    <rect x="150" y="285" width="220" height="36" rx="6" fill="#f8fafc" stroke="#94a3b8"/>
    <text x="260" y="308" text-anchor="middle" fill="#334155">Gana la config global</text>
    <line x1="212" y1="38" x2="326" y2="38" stroke="#64748b" marker-end="url(#d)"/>
    <text x="255" y="30" fill="#64748b" font-size="10">sí</text>
    <line x1="115" y1="60" x2="115" y2="91" stroke="#64748b" marker-end="url(#d)"/>
    <text x="122" y="80" fill="#64748b" font-size="10">no</text>
    <path d="M115,137 C115,300 130,303 146,303" stroke="#64748b" fill="none" marker-end="url(#d)"/>
    <text x="122" y="220" fill="#64748b" font-size="10">no hay</text>
    <line x1="212" y1="120" x2="330" y2="180" stroke="#64748b" marker-end="url(#d)"/>
    <text x="250" y="140" fill="#64748b" font-size="10">sí hay</text>
    <line x1="480" y1="182" x2="616" y2="154" stroke="#dc2626" marker-end="url(#dr)"/>
    <text x="520" y="160" fill="#dc2626" font-size="10">no aprobado</text>
    <line x1="480" y1="218" x2="616" y2="246" stroke="#64748b" marker-end="url(#d)"/>
    <text x="520" y="245" fill="#64748b" font-size="10">aprobado</text>
    <path d="M700,182 C560,182 400,270 374,300" stroke="#94a3b8" fill="none" stroke-dasharray="4" marker-end="url(#d)"/>
    <text x="530" y="292" fill="#94a3b8" font-size="10">cae a lo global</text>
  </svg>`,
  // 5. El cruce de los dos instrumentos
  `<svg viewBox="0 0 900 300" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="12">
    <defs><marker id="e" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#64748b"/></marker></defs>
    <rect x="15" y="30" width="185" height="58" rx="7" fill="#f8fafc" stroke="#94a3b8"/>
    <text x="107" y="52" text-anchor="middle" fill="#334155" font-size="11">Cable aplanado</text>
    <text x="107" y="70" text-anchor="middle" fill="#64748b" font-size="10">(native): 40 tools</text>
    <rect x="15" y="180" width="185" height="72" rx="7" fill="#fffbeb" stroke="#f59e0b"/>
    <text x="107" y="202" text-anchor="middle" fill="#78350f" font-size="11">snapshot mcp-savings</text>
    <text x="107" y="220" text-anchor="middle" fill="#b45309" font-size="9">engram: mem_search, mem_save…</text>
    <text x="107" y="235" text-anchor="middle" fill="#b45309" font-size="9">context7: query-docs…</text>
    <rect x="250" y="30" width="180" height="58" rx="7" fill="#ecfdf5" stroke="#10b981"/>
    <text x="340" y="50" text-anchor="middle" fill="#065f46" font-size="11">OxideGate publica</text>
    <text x="340" y="66" text-anchor="middle" fill="#047857" font-size="10">los NOMBRES</text>
    <text x="340" y="80" text-anchor="middle" fill="#047857" font-size="9">sin deducir nada</text>
    <rect x="480" y="110" width="180" height="62" rx="7" fill="#f5f3ff" stroke="#8b5cf6" stroke-width="2"/>
    <text x="570" y="133" text-anchor="middle" fill="#4c1d95" font-weight="600">oxidegate-lens</text>
    <text x="570" y="151" text-anchor="middle" fill="#6d28d9" font-size="10">CRUZA nombre</text>
    <text x="570" y="164" text-anchor="middle" fill="#6d28d9" font-size="10">contra lista declarada</text>
    <rect x="710" y="30" width="180" height="34" rx="5" fill="#ecfdf5" stroke="#10b981"/>
    <text x="800" y="52" text-anchor="middle" fill="#065f46" font-size="11">mem_search → engram</text>
    <rect x="710" y="120" width="180" height="34" rx="5" fill="#ecfdf5" stroke="#10b981"/>
    <text x="800" y="142" text-anchor="middle" fill="#065f46" font-size="11">query-docs → context7</text>
    <rect x="710" y="205" width="180" height="48" rx="5" fill="#f8fafc" stroke="#94a3b8"/>
    <text x="800" y="225" text-anchor="middle" fill="#334155" font-size="11">delegation_list → nadie</text>
    <text x="800" y="241" text-anchor="middle" fill="#64748b" font-size="10">sigue siendo nativa</text>
    <line x1="202" y1="59" x2="246" y2="59" stroke="#64748b" marker-end="url(#e)"/>
    <line x1="432" y1="70" x2="476" y2="120" stroke="#64748b" marker-end="url(#e)"/>
    <line x1="202" y1="212" x2="476" y2="158" stroke="#64748b" marker-end="url(#e)"/>
    <line x1="662" y1="130" x2="706" y2="55" stroke="#64748b" marker-end="url(#e)"/>
    <line x1="662" y1="141" x2="706" y2="138" stroke="#64748b" marker-end="url(#e)"/>
    <line x1="662" y1="155" x2="706" y2="222" stroke="#64748b" marker-end="url(#e)"/>
  </svg>`,
  // 6. Estado de la cadena
  `<svg viewBox="0 0 900 240" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="12">
    <defs><marker id="f" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#10b981"/></marker>
    <marker id="fr" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#dc2626"/></marker></defs>
    <rect x="15" y="25" width="165" height="48" rx="6" fill="#fffbeb" stroke="#f59e0b"/>
    <text x="97" y="45" text-anchor="middle" fill="#78350f" font-size="11">mcp-savings</text>
    <text x="97" y="61" text-anchor="middle" fill="#b45309" font-size="10">mide el precio</text>
    <rect x="15" y="140" width="165" height="48" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
    <text x="97" y="160" text-anchor="middle" fill="#7f1d1d" font-size="11">OxideGate main</text>
    <text x="97" y="176" text-anchor="middle" fill="#b91c1c" font-size="10">tiene tool_names</text>
    <rect x="250" y="140" width="175" height="48" rx="6" fill="#f8fafc" stroke="#94a3b8"/>
    <text x="337" y="160" text-anchor="middle" fill="#334155" font-size="11">OxideGate 0.3.1</text>
    <text x="337" y="176" text-anchor="middle" fill="#64748b" font-size="10">instalado</text>
    <rect x="490" y="80" width="175" height="52" rx="6" fill="#f5f3ff" stroke="#8b5cf6" stroke-width="2"/>
    <text x="577" y="102" text-anchor="middle" fill="#4c1d95" font-weight="600">oxidegate-lens</text>
    <text x="577" y="120" text-anchor="middle" fill="#6d28d9" font-size="10">cruce implementado</text>
    <rect x="720" y="80" width="165" height="52" rx="6" fill="#f8fafc" stroke="#94a3b8" stroke-dasharray="4"/>
    <text x="802" y="100" text-anchor="middle" fill="#334155" font-size="10">atribución por servidor</text>
    <text x="802" y="115" text-anchor="middle" fill="#64748b" font-size="10">en rutas aplanadas</text>
    <line x1="182" y1="55" x2="486" y2="95" stroke="#10b981" marker-end="url(#f)"/>
    <text x="300" y="65" fill="#059669" font-size="10">✔ funciona</text>
    <line x1="182" y1="164" x2="246" y2="164" stroke="#dc2626" stroke-dasharray="5" marker-end="url(#fr)"/>
    <text x="150" y="215" fill="#dc2626" font-size="11" font-weight="600">✖ sin publicar: el tag no alcanza al código</text>
    <line x1="427" y1="158" x2="486" y2="128" stroke="#94a3b8" marker-end="url(#f)"/>
    <text x="400" y="120" fill="#64748b" font-size="10">sin tool_names</text>
    <line x1="667" y1="106" x2="716" y2="106" stroke="#94a3b8" stroke-dasharray="4" marker-end="url(#f)"/>
    <text x="640" y="150" fill="#64748b" font-size="10">esperando el release</text>
  </svg>`,
];

/**
 * Un bloque nuevo empieza SOLO con estas formas exactas. La versión anterior
 * cortaba ante cualquier línea que empezara por ` - | # > `, lo que partía en
 * dos cualquier párrafo iniciado con código inline o un guion — y en el PDF
 * se veía media frase perdida. Visto leyendo el PDF, no el código.
 */
const isBlockStart = (l) =>
  /^```/.test(l) || /^\|/.test(l) || /^#{1,6} /.test(l) || /^> /.test(l) || /^---+$/.test(l) || /^[-*] /.test(l) || /^\d+\. /.test(l);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) =>
  esc(s)
    // Enlaces ANTES que el resto: el texto del enlace puede llevar negrita o
    // código, y la URL no debe pasar por esos reemplazos. Faltaba porque
    // hasta que el informe citó issues no había ni un `[texto](url)`, y se
    // veía el markdown en crudo en el PDF.
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*]+)\*/g, '$1<em>$2</em>');

const src = readFileSync(process.argv[2], 'utf8').split('\n');
const out = [];
let i = 0;
let mermaidIdx = 0;

const flushTable = (rows) => {
  const cells = (r) => r.split('|').slice(1, -1).map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  out.push('<table><thead><tr>' + head.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>');
  for (const r of body) out.push('<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
  out.push('</tbody></table>');
};

while (i < src.length) {
  const line = src[i];

  if (line.startsWith('```')) {
    const lang = line.slice(3).trim();
    const buf = [];
    i += 1;
    while (i < src.length && !src[i].startsWith('```')) buf.push(src[i++]);
    i += 1;
    if (lang === 'mermaid') out.push(`<figure>${SVGS[mermaidIdx++] ?? ''}</figure>`);
    else out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
    continue;
  }
  if (line.startsWith('|')) {
    const rows = [];
    while (i < src.length && src[i].startsWith('|')) rows.push(src[i++]);
    flushTable(rows);
    continue;
  }
  const h = line.match(/^(#{1,6}) (.*)$/);
  if (h) {
    out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    i += 1;
    continue;
  }
  if (/^---+$/.test(line)) {
    out.push('<hr/>');
    i += 1;
    continue;
  }
  if (line.startsWith('> ')) {
    const buf = [];
    while (i < src.length && (src[i].startsWith('>') || (buf.length && src[i].trim() && !src[i].startsWith('#')))) {
      buf.push(src[i].replace(/^>\s?/, ''));
      i += 1;
      if (i < src.length && !src[i].startsWith('>')) break;
    }
    out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
    continue;
  }
  if (/^[-*] /.test(line) || /^\d+\. /.test(line)) {
    const ordered = /^\d+\. /.test(line);
    const items = [];
    while (i < src.length) {
      if (/^[-*] /.test(src[i]) || /^\d+\. /.test(src[i])) {
        items.push(src[i].replace(/^([-*]|\d+\.) /, ''));
        i += 1;
        continue;
      }
      // Continuación de un item: una línea indentada, o simplemente el resto
      // de una frase que en el .md ocupa varias líneas. Sin esto la lista se
      // rompe a la mitad y el texto sale suelto debajo — se vio en el PDF.
      if (items.length && src[i].trim() !== '' && !isBlockStart(src[i])) {
        items[items.length - 1] += ' ' + src[i].trim();
        i += 1;
        continue;
      }
      break;
    }
    out.push(`<${ordered ? 'ol' : 'ul'}>` + items.map((t) => `<li>${inline(t)}</li>`).join('') + `</${ordered ? 'ol' : 'ul'}>`);
    continue;
  }
  if (line.trim() === '') {
    i += 1;
    continue;
  }
  const buf = [];
  while (i < src.length && src[i].trim() !== '' && !isBlockStart(src[i])) buf.push(src[i++]);
  if (buf.length) out.push(`<p>${inline(buf.join(' '))}</p>`);
  else i += 1;
}

const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Informe: la válvula MCP informada</title>
<style>
@page { size: A4; margin: 18mm 16mm; }
body { font: 10.5pt/1.55 -apple-system,"Segoe UI",Roboto,sans-serif; color:#1e293b; max-width:none; }
h1 { font-size:22pt; color:#0f172a; border-bottom:3px solid #8b5cf6; padding-bottom:8px; margin-top:0; }
h2 { font-size:15pt; color:#4c1d95; margin-top:26px; border-bottom:1px solid #e2e8f0; padding-bottom:4px; page-break-after:avoid; }
h3 { font-size:12pt; color:#334155; margin-top:18px; page-break-after:avoid; }
table { border-collapse:collapse; width:100%; margin:12px 0; font-size:9.5pt; page-break-inside:avoid; }
th { background:#f1f5f9; text-align:left; padding:6px 8px; border:1px solid #cbd5e1; color:#0f172a; }
td { padding:6px 8px; border:1px solid #e2e8f0; vertical-align:top; }
tr:nth-child(even) td { background:#fafafa; }
code { background:#f1f5f9; padding:1px 4px; border-radius:3px; font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:9pt; }
/* En pantalla un bloque largo puede desplazarse; en PAPEL no. Una barra de
   scroll en un PDF no es una barra: es texto perdido, y se vio recortado en
   la primera revisión. Se envuelve en vez de cortar. */
pre { background:#0f172a; color:#e2e8f0; padding:11px 13px; border-radius:6px; page-break-inside:avoid;
      white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; }
pre code { background:none; color:inherit; font-size:8.5pt; line-height:1.45; }
blockquote { border-left:4px solid #8b5cf6; background:#faf5ff; margin:12px 0; padding:9px 14px; color:#4c1d95; page-break-inside:avoid; }
figure { margin:16px 0; text-align:center; page-break-inside:avoid; }
figure svg { max-width:100%; height:auto; }
a { color:#6d28d9; text-decoration:none; border-bottom:1px solid #ddd6fe; }
hr { border:none; border-top:1px solid #e2e8f0; margin:22px 0; }
ul,ol { padding-left:22px; }
li { margin:3px 0; }
strong { color:#0f172a; }
</style></head><body>
${out.join('\n')}
</body></html>`;

writeFileSync(process.argv[3], html);
console.log('HTML escrito:', process.argv[3], '|', html.length, 'bytes');
