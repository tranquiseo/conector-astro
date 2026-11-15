// `redirects.create` y `redirects.delete` (spec §3 y §8), y lo que usa `content.updateSlug`.
// Proveedor `nuestro`: `.tranquiseo/redirecciones.json` (o la ruta de la config). Mismas
// comprobaciones que `Adaptadores/Redirecciones.php::comprobar`: portada, mismo origen y destino,
// origen ocupado, bucle y cadena (un salto basta: aplanar sería tocar reglas ajenas), y
// `destino_valido` (solo esta misma web).

import { readFileSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ErrorVerbo } from "../errores.js";
import { leerRedirecciones, rutaDeUrl, urlDeRuta } from "./lectura.js";
import { reescribirFichero, crearFichero, existe } from "../contenido/escribir.js";
import { jsonEstable } from "../estado/almacen.js";

/** Como `Despacho::mismo_host`: sin distinguir `www.` ni mayúsculas. */
export function mismoHost(a, b) {
  const q = (h) => {
    const s = String(h ?? "").toLowerCase().replace(/^\.+|\.+$/g, "");
    return s.startsWith("www.") ? s.slice(4) : s;
  };
  return q(a) !== "" && q(a) === q(b);
}

export function hostDe(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** `Redirecciones::destino_valido`: http(s) y del mismo host que la web. */
export function destinoValido(sitio, destino) {
  let u;
  try {
    u = new URL(destino);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(u.protocol) || !u.hostname) return false;
  return mismoHost(u.hostname, hostDe(sitio.config.homeUrl));
}

/** Reglas del cliente que exporta su build (spec §8). Lista `{origen, destino}`; lo ilegible no existe. */
function reglasAjenas(sitio) {
  const r = sitio.config.redireccionesAjenas;
  if (!r) return null;
  const abs = sitio.rutaAbsoluta(r);
  if (!existsSync(abs) || lstatSync(abs).isSymbolicLink()) return [];
  try {
    const datos = JSON.parse(readFileSync(abs, "utf8"));
    const lista = Array.isArray(datos) ? datos : Array.isArray(datos?.reglas) ? datos.reglas : [];
    return lista.filter((x) => x && typeof x.origen === "string" && typeof x.destino === "string").slice(0, 20000);
  } catch {
    return [];
  }
}

const sinBarras = (s) => String(s).replace(/^\/+|\/+$/g, "");

/** Todas las reglas que hay que tener en cuenta: las nuestras (con id) y las ajenas (sin id). */
function todasLasReglas(sitio) {
  const nuestras = leerRedirecciones(sitio).reglas.map((r) => ({ ...r, nuestra: true }));
  const ajenas = (reglasAjenas(sitio) ?? []).map((r) => ({ id: null, origen: r.origen, destino: r.destino, codigo: r.codigo ?? 301, nuestra: false }));
  return [...nuestras, ...ajenas];
}

function reglaPara(sitio, ruta) {
  if (ruta === "") return null;
  return todasLasReglas(sitio).find((r) => sinBarras(rutaDeUrl(sitio, r.origen) ?? r.origen) === ruta) ?? null;
}

function reglaPublica(r) {
  return { id: r.id, origen: "/" + sinBarras(r.origen) + "/", destino: r.destino, tipo: r.codigo ?? 301, nuestra: r.nuestra };
}

/**
 * `Redirecciones::comprobar`. Además, en Astro, un origen con contenido publicado está ocupado
 * (una regla nuestra nunca puede tapar una página viva: la web la serviría igual).
 * @param {string} origen ruta sin barras
 * @param {string} destino URL absoluta
 * @param {{excepto?: number}} [opciones] contenido que se va a mover (su URL antigua deja de estar ocupada)
 */
export function comprobarRedireccion(sitio, origen, destino, { excepto = null } = {}) {
  const rutaDestino = rutaDeUrl(sitio, destino);
  if (origen === "") return new ErrorVerbo("tranquiseo_redireccion_invalida", "No se redirige la portada.");
  if (rutaDestino !== null && rutaDestino === origen) return new ErrorVerbo("tranquiseo_redireccion_invalida", "Origen y destino son la misma URL.");

  const existente = reglaPara(sitio, origen);
  if (existente) {
    return new ErrorVerbo("tranquiseo_origen_ocupado", "Ya existe una redirección para esa URL y no se toca lo que no es nuestro.", { regla: reglaPublica(existente) });
  }
  const viva = sitio.cargar().contenidos.find((c) => c.id !== excepto && c.estado === "publish" && rutaDeUrl(sitio, c.url) === origen);
  if (viva || sitio.config.paginasFijas.some((p) => sinBarras(p) === origen)) {
    return new ErrorVerbo("tranquiseo_origen_ocupado", "En esa URL hay una página publicada: una redirección no la taparía.", { regla: null, contenido: viva?.id ?? null });
  }
  if (rutaDestino === null) return null;
  const siguiente = reglaPara(sitio, rutaDestino);
  if (!siguiente) return null;
  if (origen === sinBarras(rutaDeUrl(sitio, siguiente.destino) ?? siguiente.destino)) {
    return new ErrorVerbo("tranquiseo_bucle", "Esa redirección cerraría un bucle.", { regla: reglaPublica(siguiente) });
  }
  return new ErrorVerbo("tranquiseo_cadena", "El destino ya redirige a otro sitio: crear esta regla haría una cadena.", { regla: reglaPublica(siguiente) });
}

/** Escribe el fichero de reglas (claves ordenadas, salto final), sin seguir enlaces. */
function guardarReglas(sitio, datos) {
  const abs = sitio.rutaAbsoluta(sitio.config.redirecciones);
  const texto = jsonEstable(datos);
  if (existe(abs)) reescribirFichero(sitio, abs, texto);
  else {
    // La carpeta (`.tranquiseo/` en la config normal) puede no existir aún. comprobarDestino mira
    // después, con realpath, que quedó dentro del repo y no es un enlace.
    if (!existsSync(dirname(abs))) mkdirSync(dirname(abs), { recursive: true });
    crearFichero(sitio, abs, texto);
  }
}

/** Crea la regla. Devuelve su id. Lo llama también `content.updateSlug`. */
export function crearRegla(sitio, origen, destino, codigo) {
  const datos = leerRedirecciones(sitio);
  const usados = datos.reglas.map((r) => (Number.isSafeInteger(r.id) ? r.id : 0));
  const id = Math.max(datos.siguiente, 1, ...usados.map((n) => n + 1));
  datos.reglas.push({ id, origen: "/" + origen + "/", destino, codigo, creada: Math.floor(sitio.ahora() / 1000) });
  guardarReglas(sitio, { siguiente: id + 1, reglas: datos.reglas });
  return id;
}

export function catalogo() {
  return {
    "redirects.create": {
      tipo: "escritura",
      esquema: {
        origen: { tipo: "ruta", obligatorio: true },
        destino: { tipo: "url", obligatorio: true },
        codigo: { tipo: "entero", minimo: 301, maximo: 302, defecto: 301 },
      },
      necesita: "redirecciones",
      ejecutar: redirectsCreate,
    },
    "redirects.delete": {
      tipo: "escritura",
      esquema: { id: { tipo: "entero", minimo: 1, obligatorio: true } },
      necesita: "redirecciones",
      ejecutar: redirectsDelete,
    },
  };
}

function anotar(motor, datos) {
  motor.registro.anotar({ orden: motor.orden, ...datos }, Math.floor(motor.sitio.ahora() / 1000));
}

function respuesta(id, origen, destino, codigo) {
  return { id, origen: "/" + origen + "/", destino, codigo, proveedor: "nuestro", confirmado: false };
}

function redirectsCreate(sitio, args, motor) {
  if (!destinoValido(sitio, args.destino)) {
    throw new ErrorVerbo("tranquiseo_destino_externo", "Solo se crean redirecciones hacia páginas de esta misma web (http o https).");
  }
  const origen = sinBarras(rutaDeUrl(sitio, args.origen) ?? "");
  const problema = comprobarRedireccion(sitio, origen, args.destino);
  if (problema) {
    // Reenvío de la misma orden: si la regla que ocupa el origen es nuestra y dice lo mismo, es éxito.
    const r = problema.datos?.regla;
    if (problema.codigo === "tranquiseo_origen_ocupado" && r?.nuestra && r.id
      && sinBarras(rutaDeUrl(sitio, r.destino) ?? r.destino) === sinBarras(rutaDeUrl(sitio, args.destino) ?? args.destino) && r.tipo === args.codigo) {
      return respuesta(r.id, origen, args.destino, args.codigo);
    }
    if (problema.datos?.regla) problema.datos.regla = { ...problema.datos.regla, nuestra: undefined };
    throw problema;
  }
  const avisos = sitio.config.redireccionesAjenas ? [] : ["reglas_del_cliente_no_visibles"];
  anotar(motor, { verbo: "redirects.create", id: null, ruta: sitio.config.redirecciones, anterior: null, nuevo: { origen, destino: args.destino, codigo: args.codigo } });
  const id = crearRegla(sitio, origen, args.destino, args.codigo);
  return { ...respuesta(id, origen, args.destino, args.codigo), avisos };
}

function redirectsDelete(sitio, args, motor) {
  const datos = leerRedirecciones(sitio);
  const i = datos.reglas.findIndex((r) => r.id === args.id);
  if (i < 0) throw new ErrorVerbo("tranquiseo_no_encontrado", "No existe esa redirección.");
  const regla = datos.reglas[i];
  const anterior = { id: regla.id, origen: [{ patron: String(regla.origen), comparacion: "exact" }], destino: regla.destino, tipo: regla.codigo, gestionada_por: "tranquiseo" };
  anotar(motor, { verbo: "redirects.delete", id: regla.id, ruta: sitio.config.redirecciones, anterior: regla, nuevo: null });
  datos.reglas.splice(i, 1);
  guardarReglas(sitio, { siguiente: Math.max(datos.siguiente, regla.id + 1), reglas: datos.reglas });
  return { id: regla.id, anterior };
}

export { urlDeRuta };
