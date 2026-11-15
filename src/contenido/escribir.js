// Escribir un `.md`: frontmatter con el API de documento de `yaml` (las claves que no se tocan
// conservan su forma y sus comentarios), validado contra las `reglas` de la config ANTES de tocar
// el disco, y fichero escrito dentro de su colección sin seguir enlaces simbólicos.

import { Document, parseDocument } from "yaml";
import { writeFileSync, renameSync, lstatSync, existsSync, realpathSync, openSync, closeSync, writeSync, unlinkSync } from "node:fs";
import { dirname, sep, basename } from "node:path";
import { ErrorVerbo } from "../errores.js";
import { leerMd } from "./frontmatter.js";
import { deZona } from "../util/fechas.js";

/** Existe la entrada de directorio (también un enlace simbólico roto: `existsSync` lo sigue). */
export function existe(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

const esVacio = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

function obtener(datos, ruta) {
  return ruta.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), datos);
}

/** Reglas de la config (copia en dato del Zod). Error → `tranquiseo_argumento_invalido` con el campo. */
export function validarReglas(col, datos) {
  for (const [campo, regla] of Object.entries(col.reglas)) {
    const v = obtener(datos, campo);
    if (esVacio(v)) {
      // Una regla de un subcampo (`imagen.alt`) solo obliga si el objeto padre existe.
      const padre = campo.includes(".") ? obtener(datos, campo.split(".")[0]) : true;
      if (regla.obligatorio || (padre && campo.includes(".") && (regla.min ?? 0) > 0)) {
        throw new ErrorVerbo("tranquiseo_argumento_invalido", `El campo ${campo} es obligatorio en esta web.`, { campo });
      }
      continue;
    }
    const largo = typeof v === "string" ? [...v].length : null;
    if (regla.max !== undefined && largo !== null && largo > regla.max) {
      throw new ErrorVerbo("tranquiseo_argumento_invalido", `El campo ${campo} admite como mucho ${regla.max} caracteres (tiene ${largo}).`, { campo, max: regla.max, largo });
    }
    if (regla.min !== undefined && largo !== null && largo < regla.min) {
      throw new ErrorVerbo("tranquiseo_argumento_invalido", `El campo ${campo} necesita al menos ${regla.min} caracteres (tiene ${largo}).`, { campo, min: regla.min, largo });
    }
    if (regla.empieza !== undefined && (typeof v !== "string" || !v.startsWith(regla.empieza))) {
      throw new ErrorVerbo("tranquiseo_argumento_invalido", `El campo ${campo} tiene que empezar por ${regla.empieza}.`, { campo });
    }
  }
}

/** Corta por palabra a `max` caracteres (sin puntos suspensivos inventados). */
export function cortar(texto, max) {
  const letras = [...texto];
  if (letras.length <= max) return texto;
  const corto = letras.slice(0, max).join("");
  const espacio = corto.lastIndexOf(" ");
  return (espacio > max * 0.5 ? corto.slice(0, espacio) : corto).replace(/[\s,;:.\-–—]+$/u, "");
}

/**
 * Rellena los derivados que falten (spec §4.1). `logicos` son los valores en el idioma del core
 * (titulo, extracto, fecha…), ya como texto plano. Un derivado nunca pisa un valor existente.
 */
export function aplicarDerivados(col, datos, logicos) {
  for (const [campo, d] of Object.entries(col.derivados)) {
    if (!esVacio(datos[campo])) continue;
    let v = logicos[d.desde];
    if (esVacio(v)) continue;
    if (typeof v !== "string") continue;
    if (d.hasta !== undefined && v.includes(d.hasta)) v = v.slice(0, v.indexOf(d.hasta)).trim();
    if (d.max !== undefined) v = cortar(v, d.max);
    if (v !== "") datos[campo] = v;
  }
}

/** `Y-m-d H:i:s` UTC → `YYYY-MM-DD` en la zona del sitio (como escribe fechas un blog Astro). */
export function diaLocal(utc, zona) {
  const t = new Date(utc.replace(" ", "T") + "Z");
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zona, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(t).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export { deZona };

/**
 * Texto completo del `.md`. Con `yamlPrevio` se editan solo las claves cambiadas.
 * @param {string|null} yamlPrevio
 * @param {object} datos frontmatter final completo
 * @param {string} cuerpo
 */
export function componerMd(yamlPrevio, datos, cuerpo) {
  let doc;
  if (yamlPrevio !== null && yamlPrevio !== undefined) {
    doc = parseDocument(yamlPrevio, { schema: "core" });
    const previos = doc.toJS() ?? {};
    for (const k of Object.keys(previos)) if (!Object.hasOwn(datos, k)) doc.delete(k);
    for (const [k, v] of Object.entries(datos)) {
      if (JSON.stringify(previos[k]) !== JSON.stringify(v)) doc.set(k, doc.createNode(v));
    }
  } else {
    doc = new Document(datos, { schema: "core" });
  }
  const yaml = doc.toString({ lineWidth: 0, aliasDuplicateObjects: false });
  const texto = `---\n${yaml}---\n\n${cuerpo.replace(/^\n+/, "").replace(/\s+$/, "")}\n`;
  // Se comprueba releyendo: lo escrito tiene que volver a leerse igual y sin nada raro.
  const vuelta = leerMd(texto);
  if (!vuelta.estandar || JSON.stringify(vuelta.datos) !== JSON.stringify(JSON.parse(JSON.stringify(datos)))) {
    throw new ErrorVerbo("tranquiseo_excepcion", "El frontmatter generado no se relee igual.", { detalle: "frontmatter_inestable" });
  }
  return texto;
}

/** La carpeta de destino tiene que existir, ser real y estar dentro del repo; el fichero no puede ser un enlace. */
export function comprobarDestino(sitio, abs) {
  const dir = dirname(abs);
  const raiz = realpathSync(sitio.raizRepo);
  if (!existsSync(dir)) throw new ErrorVerbo("tranquiseo_ruta_prohibida", "La carpeta de destino no existe.");
  const real = realpathSync(dir);
  if (!(real + sep).startsWith(raiz + sep)) throw new ErrorVerbo("tranquiseo_ruta_prohibida", "Ruta fuera del repo.");
  if (lstatSync(dir).isSymbolicLink()) throw new ErrorVerbo("tranquiseo_ruta_prohibida", "La carpeta de destino es un enlace simbólico.");
  if (existe(abs) && lstatSync(abs).isSymbolicLink()) throw new ErrorVerbo("tranquiseo_ruta_prohibida", "El fichero de destino es un enlace simbólico.");
  if (basename(abs).startsWith(".")) throw new ErrorVerbo("tranquiseo_ruta_prohibida", "Nombre de fichero no permitido.");
}

/** Crea un fichero nuevo; nunca sobrescribe (apertura exclusiva). */
export function crearFichero(sitio, abs, texto) {
  comprobarDestino(sitio, abs);
  const fd = openSync(abs, "wx");
  try {
    writeSync(fd, texto);
  } finally {
    closeSync(fd);
  }
}

/** Reescribe un fichero existente de forma atómica. */
export function reescribirFichero(sitio, abs, texto) {
  comprobarDestino(sitio, abs);
  const tmp = `${abs}.tq-tmp`;
  if (existe(tmp)) unlinkSync(tmp);
  writeFileSync(tmp, texto, { flag: "wx" });
  renameSync(tmp, abs);
}

/** Mueve un fichero dentro de su carpeta sin pisar nada. */
export function moverFichero(sitio, desde, hasta) {
  comprobarDestino(sitio, desde);
  comprobarDestino(sitio, hasta);
  if (existe(hasta)) throw new ErrorVerbo("tranquiseo_slug_ocupado", "Ya hay un fichero con ese nombre.");
  renameSync(desde, hasta);
}
