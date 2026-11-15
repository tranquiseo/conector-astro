// Reglas del parche entre jobs que comparten la fase aplicar (que lo escribe) y las fases compilar y
// publicar (que lo leen). Aparte para que `ciclo.js` y `fases.js` no se importen en círculo.

export const TOPE_PARCHE = 64 * 1024 * 1024; // bytes de `parche.json`

/** Una ruta del parche: relativa, con `/`, sin `..`, sin `.git` en ningún segmento, sin nada raro. */
export function rutaDeParcheValida(ruta) {
  if (typeof ruta !== "string" || ruta.length === 0 || ruta.length > 1024) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\\]/.test(ruta) || ruta.startsWith("/")) return false;
  const seg = ruta.split("/");
  return seg.every((s) => s !== "" && s !== "." && s !== ".." && !/^\.git$/i.test(s.replace(/[. ]+$/, "")));
}
