// Leer un `.md`: frontmatter YAML + cuerpo. YAML con el esquema `core` (sin tipos de la 1.1, sin
// fechas mágicas), sin alias. Un frontmatter con tags (`!!`, `!x`) o anclas no es «estándar»: la
// entrada se puede leer pero no se reescribe (spec §7.3).

import { parseDocument, visit, isAlias, isNode } from "yaml";

const INICIO = /^---\r?\n/;

/**
 * @param {string} texto
 * @returns {{datos: object, cuerpo: string, estandar: boolean, motivo: string|null, yaml: string|null}}
 */
export function leerMd(texto) {
  const t = texto.replace(/^﻿/, "");
  if (!INICIO.test(t)) return { datos: {}, cuerpo: t, estandar: true, motivo: null, yaml: null };
  const resto = t.replace(INICIO, "");
  const fin = /(^|\r?\n)---[ \t]*(\r?\n|$)/.exec(resto);
  if (!fin) return { datos: {}, cuerpo: t, estandar: false, motivo: "frontmatter_sin_cerrar", yaml: null };
  const yamlTexto = resto.slice(0, fin.index);
  const cuerpo = resto.slice(fin.index + fin[0].length);

  let doc;
  try {
    doc = parseDocument(yamlTexto, { schema: "core", maxAliasCount: 0, uniqueKeys: true, prettyErrors: false });
  } catch {
    return { datos: {}, cuerpo, estandar: false, motivo: "frontmatter_no_estandar", yaml: null };
  }
  let raro = doc.errors.length > 0 || doc.warnings.length > 0;
  if (!raro) {
    visit(doc, (_clave, nodo) => {
      if (isAlias(nodo) || (isNode(nodo) && (nodo.tag || nodo.anchor))) {
        raro = true;
        return visit.BREAK;
      }
      return undefined;
    });
  }
  if (raro) return { datos: {}, cuerpo, estandar: false, motivo: "frontmatter_no_estandar", yaml: null };
  const datos = doc.toJS({ maxAliasCount: 0 }) ?? {};
  if (typeof datos !== "object" || Array.isArray(datos)) return { datos: {}, cuerpo, estandar: false, motivo: "frontmatter_no_estandar", yaml: null };
  return { datos, cuerpo, estandar: true, motivo: null, yaml: yamlTexto };
}
