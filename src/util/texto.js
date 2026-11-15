// Utilidades de texto que imitan a las de WordPress que el contrato da por hechas.

const MARCAS = /[̀-ͯ]/g;

export function sinTildes(s) {
  return String(s).normalize("NFD").replace(MARCAS, "");
}

/** Como `sanitize_title()`: minúsculas, sin tildes, `[a-z0-9-]`, guiones simples, ≤200. */
export function sanitizeTitle(s) {
  return sinTildes(quitarEtiquetas(String(s)))
    .toLowerCase()
    .replace(/&[a-z0-9#]+;/g, "")
    .replace(/[^a-z0-9\s_-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200)
    .replace(/-+$/g, "");
}

/** Quita etiquetas HTML (y el contenido de `script`/`style`, como `wp_strip_all_tags`). */
export function quitarEtiquetas(s) {
  return String(s)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<[^>]*>/g, "");
}

/**
 * Como `sanitize_text_field()`: sin etiquetas, sin saltos ni tabuladores, espacios simples,
 * sin octetos `%xx`, recortado. Un `<` suelto (que no abre etiqueta) queda como `&lt;`.
 */
export function sanitizeTextField(s) {
  let v = String(s);
  if (v.includes("<")) {
    v = v.replace(/<(?=[^a-zA-Z/!?]|$)/g, "&lt;");
    v = quitarEtiquetas(v);
  }
  v = v.replace(/[\r\n\t ]+/g, " ");
  let antes;
  do {
    antes = v;
    v = v.replace(/%[a-f0-9]{2}/gi, "");
  } while (v !== antes);
  return v.replace(/ +/g, " ").trim();
}

/** Texto comparable en búsquedas: sin tildes, minúsculas, espacios simples. */
export function normalizarBusqueda(s) {
  return sinTildes(String(s)).toLowerCase().replace(/\s+/g, " ").trim();
}

/** Palabras del texto visible (letras Unicode; `str_word_count` de PHP solo cuenta ASCII). */
export function contarPalabras(html) {
  const m = quitarEtiquetas(html).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return m ? m.length : 0;
}
