// JSON-LD (`Adaptadores/Schema.php`): estructura validada, lista blanca de @type, tope 20 KB y
// profundidad 12, re-codificado con `<`, `>`, `&` escapados (JSON_HEX_TAG | JSON_HEX_AMP).

export const TAMANO_MAXIMO = 20000;
export const PROFUNDIDAD = 12;
export const TIPOS = Object.freeze(["FAQPage", "HowTo", "Article", "BlogPosting", "BreadcrumbList"]);
export const TIPOS_ANIDADOS = Object.freeze([
  "Question", "Answer", "HowToStep", "HowToSection", "HowToDirection", "HowToTip", "HowToSupply", "HowToTool",
  "MonetaryAmount", "QuantitativeValue", "ListItem", "Person", "Organization", "ImageObject", "WebPage", "VideoObject", "Thing",
]);

export class SchemaInvalido extends Error {}

const esObjeto = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const esContenedor = (v) => v !== null && typeof v === "object";

function profundidad(v) {
  if (!esContenedor(v)) return 0;
  let max = 0;
  for (const h of Object.values(v)) max = Math.max(max, profundidad(h));
  return max + 1;
}

function tiposPermitidos(tipo, admitidos) {
  const tipos = Array.isArray(tipo) ? tipo : [tipo];
  if (tipos.length === 0) throw new SchemaInvalido("un @type vacío no vale");
  for (const t of tipos) {
    if (typeof t !== "string" || !admitidos.includes(t)) {
      throw new SchemaInvalido(`tipo de schema no admitido: ${typeof t === "string" ? t : "?"} (se admiten ${admitidos.join(", ")})`);
    }
  }
}

function hijosPermitidos(nodo, nivel) {
  if (nivel > PROFUNDIDAD) throw new SchemaInvalido("el schema es demasiado profundo");
  for (const [clave, hijo] of Object.entries(nodo)) {
    if (clave === "@graph") throw new SchemaInvalido("@graph solo puede ir en la raíz");
    if (!esContenedor(hijo)) continue;
    if (esObjeto(hijo) && Object.hasOwn(hijo, "@type")) tiposPermitidos(hijo["@type"], TIPOS_ANIDADOS);
    hijosPermitidos(hijo, nivel + 1);
  }
}

function soloDatos(v, nivel) {
  if (nivel > PROFUNDIDAD) return false;
  if (esContenedor(v)) return Object.values(v).every((h) => soloDatos(h, nivel + 1));
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

export function codificar(valor) {
  return JSON.stringify(valor)
    .replace(/</g, "\\u003C").replace(/>/g, "\\u003E").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** @returns {string} JSON canónico. Lanza SchemaInvalido. */
export function validarSchema(valor) {
  if (typeof valor === "string") {
    if (Buffer.byteLength(valor, "utf8") > TAMANO_MAXIMO) throw new SchemaInvalido(`máximo ${TAMANO_MAXIMO} bytes`);
    try {
      valor = JSON.parse(valor);
    } catch (e) {
      throw new SchemaInvalido(`no es JSON válido: ${e.message}`);
    }
    if (profundidad(valor) > PROFUNDIDAD) throw new SchemaInvalido("no es JSON válido: Maximum stack depth exceeded");
  }
  if (!esObjeto(valor) || !Object.hasOwn(valor, "@context")) throw new SchemaInvalido("se esperaba un objeto JSON-LD con @context");
  const contexto = typeof valor["@context"] === "string" ? valor["@context"].toLowerCase().replace(/\/+$/, "") : "";
  if (!["https://schema.org", "http://schema.org"].includes(contexto)) throw new SchemaInvalido("@context tiene que ser https://schema.org");
  let nodos;
  if (Object.hasOwn(valor, "@graph")) {
    if (Object.keys(valor).some((k) => k !== "@context" && k !== "@graph")) throw new SchemaInvalido("con @graph, la raíz solo lleva @context y @graph");
    nodos = valor["@graph"];
  } else nodos = [valor];
  if (!esContenedor(nodos) || Object.keys(nodos).length === 0) throw new SchemaInvalido("el schema no trae ningún nodo");
  for (const nodo of Object.values(nodos)) {
    if (!esObjeto(nodo) || !Object.hasOwn(nodo, "@type")) throw new SchemaInvalido("cada nodo del schema necesita @type");
    tiposPermitidos(nodo["@type"], TIPOS);
    hijosPermitidos(nodo, 0);
  }
  if (!soloDatos(valor, 0)) throw new SchemaInvalido("el schema solo admite textos, números, booleanos, listas y objetos");
  const json = codificar(valor);
  if (Buffer.byteLength(json, "utf8") > TAMANO_MAXIMO) throw new SchemaInvalido(`máximo ${TAMANO_MAXIMO} bytes`);
  return json;
}
