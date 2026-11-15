// `tranquiseo.config.json`: dato, nunca código. Esquema cerrado: una clave que no está aquí es un
// error, y el error dice cuál (spec §4).

import { readFileSync, existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";

export const NOMBRE = "tranquiseo.config.json";

export const CAMPOS_LOGICOS = Object.freeze([
  "titulo", "seo_titulo", "seo_descripcion", "fecha", "actualizado", "extracto",
  "etiquetas", "categorias", "imagen", "schema", "canonical", "robots", "palabra_clave",
]);

export class ErrorDeConfig extends Error {
  constructor(clave, motivo) {
    super(`tranquiseo.config.json: «${clave}» ${motivo}`);
    this.clave = clave;
  }
}

const esObjeto = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const CLAVE_FM = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function cerrado(obj, clave, permitidas) {
  if (!esObjeto(obj)) throw new ErrorDeConfig(clave, "tiene que ser un objeto");
  for (const k of Object.keys(obj)) if (!permitidas.includes(k)) throw new ErrorDeConfig(clave ? `${clave}.${k}` : k, "no es una clave permitida");
}

function obligatorio(obj, clave, ruta) {
  if (!Object.hasOwn(obj, clave)) throw new ErrorDeConfig(ruta ? `${ruta}.${clave}` : clave, "falta");
  return obj[clave];
}

function texto(v, clave, { max = 500, vacio = false } = {}) {
  if (typeof v !== "string" || (!vacio && v === "") || v.length > max) throw new ErrorDeConfig(clave, "tiene que ser texto");
  return v;
}

function entero(v, clave, min, max) {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new ErrorDeConfig(clave, `tiene que ser un entero entre ${min} y ${max}`);
  return v;
}

function booleano(v, clave) {
  if (typeof v !== "boolean") throw new ErrorDeConfig(clave, "tiene que ser true o false");
  return v;
}

// Ruta relativa al repo (o a la raíz Astro): sin absoluta, sin «..», sin barra invertida.
export function rutaRelativa(v, clave, { barraFinal = false } = {}) {
  texto(v, clave, { max: 300 });
  if (v.startsWith("/") || v.includes("\\") || v.includes("\0") || /^[A-Za-z]:/.test(v)) throw new ErrorDeConfig(clave, "tiene que ser una ruta relativa");
  const partes = v.split("/").filter((p) => p !== "");
  if (partes.some((p) => p === ".." )) throw new ErrorDeConfig(clave, "no puede contener «..»");
  if (barraFinal && !v.endsWith("/")) throw new ErrorDeConfig(clave, "tiene que acabar en «/»");
  return v;
}

function argv(v, clave) {
  if (!Array.isArray(v) || v.length === 0 || v.length > 20 || v.some((a) => typeof a !== "string" || a === "" || a.length > 200)) {
    throw new ErrorDeConfig(clave, "tiene que ser una lista de argumentos (argv), nunca una línea de shell");
  }
  return [...v];
}

function urlHttps(v, clave) {
  texto(v, clave, { max: 300 });
  let u;
  try {
    u = new URL(v);
  } catch {
    throw new ErrorDeConfig(clave, "no es una URL");
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname))) throw new ErrorDeConfig(clave, "tiene que ser https");
  if (u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) throw new ErrorDeConfig(clave, "tiene que ser solo el origen (https://dominio)");
  return v.replace(/\/+$/, "");
}

function rutaUrl(v, clave) {
  texto(v, clave, { max: 300 });
  if (!v.startsWith("/") || v.startsWith("//") || v.includes("\\")) throw new ErrorDeConfig(clave, "tiene que ser una ruta que empiece por «/»");
  return v;
}

function coleccion(c, clave, tipo) {
  cerrado(c, clave, ["nombre", "dir", "url", "campos", "derivados", "reglas", "borradores", "crear"]);
  const nombre = texto(obligatorio(c, "nombre", clave), `${clave}.nombre`, { max: 64 });
  if (!/^[a-z0-9_-]+$/i.test(nombre)) throw new ErrorDeConfig(`${clave}.nombre`, "solo letras, números, - y _");
  const dir = rutaRelativa(obligatorio(c, "dir", clave), `${clave}.dir`).replace(/\/+$/, "");
  const url = rutaUrl(obligatorio(c, "url", clave), `${clave}.url`);
  if ((url.match(/\{slug\}/g) || []).length !== 1) throw new ErrorDeConfig(`${clave}.url`, "tiene que llevar «{slug}» una vez");

  const camposEnt = obligatorio(c, "campos", clave);
  cerrado(camposEnt, `${clave}.campos`, CAMPOS_LOGICOS);
  if (!Object.hasOwn(camposEnt, "titulo")) throw new ErrorDeConfig(`${clave}.campos.titulo`, "falta");
  const campos = Object.fromEntries(CAMPOS_LOGICOS.map((k) => [k, null]));
  for (const [k, v] of Object.entries(camposEnt)) {
    if (v !== null && (typeof v !== "string" || !CLAVE_FM.test(v))) throw new ErrorDeConfig(`${clave}.campos.${k}`, "tiene que ser un nombre de campo o null");
    campos[k] = v;
  }

  const derivados = {};
  for (const [k, d] of Object.entries(c.derivados ?? {})) {
    const cd = `${clave}.derivados.${k}`;
    if (!CLAVE_FM.test(k)) throw new ErrorDeConfig(cd, "nombre de campo inválido");
    cerrado(d, cd, ["desde", "hasta", "max"]);
    const desde = texto(obligatorio(d, "desde", cd), `${cd}.desde`);
    if (!CAMPOS_LOGICOS.includes(desde)) throw new ErrorDeConfig(`${cd}.desde`, "tiene que ser un campo lógico");
    const salida = { desde };
    if (d.hasta !== undefined) {
      if (typeof d.hasta !== "string" || [...d.hasta].length !== 1) throw new ErrorDeConfig(`${cd}.hasta`, "tiene que ser un solo carácter");
      salida.hasta = d.hasta;
    }
    if (d.max !== undefined) salida.max = entero(d.max, `${cd}.max`, 1, 5000);
    derivados[k] = salida;
  }

  const reglas = {};
  for (const [k, r] of Object.entries(c.reglas ?? {})) {
    const cr = `${clave}.reglas.${k}`;
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(k)) throw new ErrorDeConfig(cr, "nombre de campo inválido");
    cerrado(r, cr, ["max", "min", "obligatorio", "empieza"]);
    const salida = {};
    if (r.max !== undefined) salida.max = entero(r.max, `${cr}.max`, 0, 100000);
    if (r.min !== undefined) salida.min = entero(r.min, `${cr}.min`, 0, 100000);
    if (r.obligatorio !== undefined) salida.obligatorio = booleano(r.obligatorio, `${cr}.obligatorio`);
    if (r.empieza !== undefined) salida.empieza = texto(r.empieza, `${cr}.empieza`, { max: 200 });
    reglas[k] = salida;
  }

  let borradores = null;
  if (c.borradores !== undefined && c.borradores !== null) {
    cerrado(c.borradores, `${clave}.borradores`, ["modo", "campo"]);
    const modo = obligatorio(c.borradores, "modo", `${clave}.borradores`);
    if (modo === "prefijo") borradores = { modo };
    else if (modo === "campo") {
      const campo = texto(obligatorio(c.borradores, "campo", `${clave}.borradores`), `${clave}.borradores.campo`);
      if (!CLAVE_FM.test(campo)) throw new ErrorDeConfig(`${clave}.borradores.campo`, "nombre de campo inválido");
      borradores = { modo, campo };
    } else throw new ErrorDeConfig(`${clave}.borradores.modo`, "tiene que ser «prefijo» o «campo»");
  }

  return {
    tipo, nombre, dir, url, campos, derivados, reglas, borradores,
    crear: c.crear === undefined ? true : booleano(c.crear, `${clave}.crear`),
  };
}

const CLAVES = [
  "version", "sitio_id", "home_url", "raiz", "zona", "build", "instalar", "dist", "intervalo", "despliegue",
  "espera_publicacion", "selector_contenido", "colecciones", "paginas_fijas", "media", "redirecciones",
  "redirecciones_ajenas", "redirecciones_leidas", "rutas_permitidas", "sitemap", "tope_destructivas_hora", "escrituras",
];

// Rutas que la guardia no deja tocar nunca, diga lo que diga la config (spec §9 paso 6).
export const PROHIBIDAS = Object.freeze([
  /^\.github\//, /(^|\/)package(-lock)?\.json$/, /(^|\/)(pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/,
  /(^|\/)astro\.config\.[a-z]+$/, /(^|\/)tranquiseo\.config\.json$/, /\.(js|mjs|cjs|ts|mts|cts|jsx|tsx|astro|mdx|vue|svelte)$/i,
  /(^|\/)\.git(\/|$)/, /(^|\/)\.(env|npmrc)/,
]);

export function validarConfig(c) {
  cerrado(c, "", CLAVES);
  if (obligatorio(c, "version") !== 1) throw new ErrorDeConfig("version", "tiene que ser 1");
  const homeUrl = urlHttps(obligatorio(c, "home_url"), "home_url");
  let sitioId = null;
  if (c.sitio_id !== undefined && c.sitio_id !== null && c.sitio_id !== "") {
    sitioId = texto(c.sitio_id, "sitio_id", { max: 64 });
    if (!/^[A-Za-z0-9-]{8,64}$/.test(sitioId)) throw new ErrorDeConfig("sitio_id", "formato inválido");
  }
  const raiz = c.raiz === undefined ? "." : rutaRelativa(c.raiz, "raiz");

  const colEnt = obligatorio(c, "colecciones");
  cerrado(colEnt, "colecciones", ["post", "page"]);
  if (!colEnt.post && !colEnt.page) throw new ErrorDeConfig("colecciones", "tiene que tener «post» o «page»");
  const colecciones = {};
  for (const t of ["post", "page"]) if (colEnt[t]) colecciones[t] = coleccion(colEnt[t], `colecciones.${t}`, t);

  const media = obligatorio(c, "media");
  cerrado(media, "media", ["dir", "url"]);
  const mediaDir = rutaRelativa(obligatorio(media, "dir", "media"), "media.dir").replace(/\/+$/, "");
  const mediaUrl = rutaUrl(obligatorio(media, "url", "media"), "media.url").replace(/\/+$/, "");

  const rutasPermitidas = obligatorio(c, "rutas_permitidas");
  if (!Array.isArray(rutasPermitidas) || rutasPermitidas.length === 0) throw new ErrorDeConfig("rutas_permitidas", "tiene que ser una lista no vacía");
  rutasPermitidas.forEach((r, i) => rutaRelativa(r, `rutas_permitidas[${i}]`, { barraFinal: true }));

  let despliegue = { tipo: "push" };
  if (c.despliegue !== undefined) {
    cerrado(c.despliegue, "despliegue", ["tipo", "workflow"]);
    const tipo = obligatorio(c.despliegue, "tipo", "despliegue");
    if (tipo === "push") despliegue = { tipo };
    else if (tipo === "workflow") {
      const wf = texto(obligatorio(c.despliegue, "workflow", "despliegue"), "despliegue.workflow", { max: 100 });
      if (!/^[A-Za-z0-9._-]+\.ya?ml$/.test(wf)) throw new ErrorDeConfig("despliegue.workflow", "tiene que ser un nombre de fichero .yml");
      despliegue = { tipo, workflow: wf };
    } else throw new ErrorDeConfig("despliegue.tipo", "tiene que ser «push» o «workflow»");
  }

  const paginasFijas = c.paginas_fijas ?? [];
  if (!Array.isArray(paginasFijas)) throw new ErrorDeConfig("paginas_fijas", "tiene que ser una lista");
  paginasFijas.forEach((p, i) => rutaUrl(p, `paginas_fijas[${i}]`));

  return Object.freeze({
    version: 1,
    sitioId,
    homeUrl,
    raiz,
    zona: c.zona === undefined ? "UTC" : texto(c.zona, "zona", { max: 64 }),
    build: c.build === undefined ? ["npm", "run", "build"] : argv(c.build, "build"),
    instalar: c.instalar === undefined ? ["npm", "ci"] : argv(c.instalar, "instalar"),
    dist: c.dist === undefined ? "dist" : rutaRelativa(c.dist, "dist"),
    intervalo: c.intervalo === undefined ? 1800 : entero(c.intervalo, "intervalo", 60, 3600),
    despliegue,
    esperaPublicacion: c.espera_publicacion === undefined ? 600 : entero(c.espera_publicacion, "espera_publicacion", 0, 1800),
    selectorContenido: c.selector_contenido === undefined ? "main" : texto(c.selector_contenido, "selector_contenido", { max: 200 }),
    colecciones,
    paginasFijas: [...paginasFijas],
    media: { dir: mediaDir, url: mediaUrl },
    redirecciones: c.redirecciones === undefined ? ".tranquiseo/redirecciones.json" : rutaRelativa(c.redirecciones, "redirecciones"),
    redireccionesAjenas: c.redirecciones_ajenas == null ? null : rutaRelativa(c.redirecciones_ajenas, "redirecciones_ajenas"),
    redireccionesLeidas: c.redirecciones_leidas === undefined ? false : booleano(c.redirecciones_leidas, "redirecciones_leidas"),
    rutasPermitidas: [...rutasPermitidas],
    sitemap: c.sitemap === undefined ? true : booleano(c.sitemap, "sitemap"),
    topeDestructivasHora: c.tope_destructivas_hora === undefined ? 20 : entero(c.tope_destructivas_hora, "tope_destructivas_hora", 1, 200),
    // Entrega controlada: con `false` el conector solo lee; toda escritura sale `tranquiseo_no_disponible`.
    escrituras: c.escrituras === undefined ? true : booleano(c.escrituras, "escrituras"),
  });
}

/** Lee y valida la config del repo. `raizRepo` es la raíz del repo git del cliente. */
export function cargarConfig(raizRepo) {
  const ruta = join(resolve(raizRepo), NOMBRE);
  if (!existsSync(ruta)) throw new ErrorDeConfig(NOMBRE, "no existe en la raíz del repo");
  if (lstatSync(ruta).isSymbolicLink()) throw new ErrorDeConfig(NOMBRE, "no puede ser un enlace simbólico");
  let datos;
  try {
    datos = JSON.parse(readFileSync(ruta, "utf8"));
  } catch (e) {
    throw new ErrorDeConfig(NOMBRE, `no es JSON válido (${e.message})`);
  }
  return validarConfig(datos);
}
