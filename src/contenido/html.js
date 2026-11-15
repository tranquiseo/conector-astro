// HTML que entra en un `.md` (spec §7.1, §7.2). Tres capas:
// 1. Fuera los `<script>` CON su contenido (como `Esquema.php`) y lista blanca equivalente a
//    `wp_kses_post` (sanitize-html): sin `on*`, sin `style`, sin iframe, solo http/https/mailto/tel.
// 2. El resultado vuelve a pasar por Markdown al compilar: en el texto se escapan como entidades
//    los caracteres que Markdown reinterpreta (un `[x](javascript:…)` que el saneador vio como
//    texto no puede acabar siendo un enlace), y nada de sangría ni líneas en blanco fuera de `<pre>`.
// 3. `id` en cada H2/H3 que no lo tenga, único dentro de la entrada.

import sanitizeHtml from "sanitize-html";
import { marked } from "marked";
import { sanitizeTitle, quitarEtiquetas } from "../util/texto.js";
import { decodificarEntidades } from "../sitio.js";

const ETIQUETAS = [
  "address", "article", "aside", "footer", "header", "h1", "h2", "h3", "h4", "h5", "h6", "hgroup", "section",
  "blockquote", "dd", "div", "dl", "dt", "figcaption", "figure", "hr", "li", "ol", "p", "pre", "ul",
  "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "dfn", "em", "i", "kbd", "mark", "q", "s", "samp",
  "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr", "del", "ins",
  "caption", "col", "colgroup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "img",
  // Como `wp_kses_post` (J8, M6): sin JS, y sin ellos un `content.update` se comería los vídeos.
  "video", "audio", "source", "track", "details", "summary",
];

const POLITICA = {
  allowedTags: ETIQUETAS,
  allowedAttributes: {
    "*": ["id", "class", "title", "lang", "dir"],
    a: ["href", "title", "rel", "target", "hreflang"],
    img: ["src", "alt", "width", "height", "loading", "decoding", "title"],
    td: ["colspan", "rowspan"], th: ["colspan", "rowspan", "scope"],
    ol: ["start", "reversed", "type"], li: ["value"], time: ["datetime"], data: ["value"],
    q: ["cite"], blockquote: ["cite"], del: ["datetime", "cite"], ins: ["datetime", "cite"],
    video: ["src", "poster", "width", "height", "controls", "loop", "muted", "playsinline", "preload"],
    audio: ["src", "controls", "loop", "muted", "preload"],
    source: ["src", "type", "media"], track: ["src", "kind", "srclang", "label", "default"],
    details: ["open"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https"] },
  allowedSchemesAppliedToAttributes: ["href", "src", "cite", "poster"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  nonTextTags: ["script", "style", "textarea", "option", "noscript", "iframe", "template", "svg", "math", "object", "embed"],
  parser: { decodeEntities: true },
};

// Lo que Markdown reinterpreta en un texto (spec §7.1).
const MARKDOWN = { "[": "&#91;", "]": "&#93;", "(": "&#40;", ")": "&#41;", "!": "&#33;", "*": "&#42;", _: "&#95;", "\\": "&#92;", "`": "&#96;", "~": "&#126;", "|": "&#124;", "#": "&#35;" };
const RE_MARKDOWN = /[[\]()!*_\\`~|#]/g;

function escaparMarkdown(texto) {
  return texto.replace(RE_MARKDOWN, (c) => MARKDOWN[c]);
}

// Marcas de bloque al principio de línea (listas, setext): se neutraliza el carácter. Se hace
// sobre el resultado entero (el analizador trocea el texto y por trozos no se ve el principio).
function marcasDeLinea(trozo) {
  return trozo.replace(/(^|\n)(\d+)([.)])/g, (_, a, n, p) => a + n + (p === "." ? "&#46;" : "&#41;")).replace(/(^|\n)([+\-=])/g, (_, a, c) => `${a}&#${c.charCodeAt(0)};`);
}

function quitarScripts(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "").replace(/<script\b[^>]*>[\s\S]*$/i, "");
}

// Fuera de `<pre>`: sin sangría inicial (bloque de código por 4 espacios) y sin líneas en blanco
// (así todo el cuerpo es un único bloque HTML para Markdown, que no lo vuelve a interpretar).
// Dentro de `<pre>` una línea en blanco cerraría el bloque HTML para Markdown (J8, leve 8): el
// salto se escribe como entidad, que se ve igual.
function lineasEnBlancoDePre(pre) {
  let previo;
  let s = pre.replace(/\r\n?/g, "\n");
  do {
    previo = s;
    s = s.replace(/\n([ \t]*)\n/g, "\n$1&#10;");
  } while (s !== previo);
  return s;
}

function aplanar(html) {
  return html
    .split(/(<pre\b[\s\S]*?<\/pre>)/i)
    .map((trozo, i) => (i % 2 === 1 ? lineasEnBlancoDePre(trozo) : trozo.replace(/\r\n?/g, "\n").replace(/^[ \t]+/gm, "").replace(/\n{2,}/g, "\n")))
    .map((trozo, i) => (i % 2 === 1 ? trozo : marcasDeLinea(trozo)))
    .join("")
    .trim();
}

function idsEnTitulos(html) {
  const usados = new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]));
  return html.replace(/<h([23])((?:\s[^>]*)?)>([\s\S]*?)<\/h\1>/g, (todo, n, attrs, interior) => {
    if (/\sid="/.test(attrs)) return todo;
    const base = sanitizeTitle(decodificarEntidades(quitarEtiquetas(interior))) || "seccion";
    let id = base;
    for (let i = 2; usados.has(id); i++) id = `${base}-${i}`;
    usados.add(id);
    return `<h${n} id="${id}"${attrs}>${interior}</h${n}>`;
  });
}

/** Saneado completo para el cuerpo de un `.md`. Idempotente. */
export function sanearHtml(html) {
  const limpio = sanitizeHtml(quitarScripts(String(html)), {
    ...POLITICA,
    textFilter: (texto) => escaparMarkdown(texto),
  });
  return idsEnTitulos(aplanar(limpio));
}

// Lo que el saneado no deja pasar (o pasa sin poder volver a escribirse) y que un cliente echaría
// de menos si un `content.update` lo quitara en silencio: «no se tocan vídeos» (J8, M6).
const INCRUSTADOS = ["iframe", "video", "audio", "embed", "object", "details", "summary"];

/**
 * Etiquetas incrustadas que tenía el cuerpo anterior y no tiene el nuevo (ya saneado).
 * @returns {string[]}
 */
export function incrustadosPerdidos(cuerpoAnterior, cuerpoNuevo) {
  const contar = (t, e) => (String(t).match(new RegExp(`<${e}\\b`, "gi")) ?? []).length;
  return INCRUSTADOS.filter((e) => contar(cuerpoNuevo, e) < contar(cuerpoAnterior, e));
}

/** Texto plano para el frontmatter (extracto, descripción): sin etiquetas, entidades decodificadas. */
export function textoPlano(html) {
  return decodificarEntidades(quitarEtiquetas(sanitizeHtml(quitarScripts(String(html)), { allowedTags: [], allowedAttributes: {}, nonTextTags: POLITICA.nonTextTags })))
    .replace(/\s+/g, " ")
    .trim();
}

/** Cuerpo de un `.md` tal como lo verá el core (HTML, como `post_content`). */
export function cuerpoComoHtml(cuerpo) {
  return marked.parse(cuerpo, { gfm: true, async: false }).trim();
}
