// `media.upload` y `media.updateAlt` (spec §3). Esquemas copiados de `Verbos/Escritura.php`.
//
// La descarga por URL es asíncrona y el motor no: el despacho la hace ANTES de ejecutar la orden
// (`descargarMedio`, con las comprobaciones del plugin: https, solo nuestros hosts, sin usuario
// ni puerto, IP pública, sin seguir redirecciones, tope de bytes) y deja los bytes en
// `motor.descargas`. Si no están, la orden sale `tranquiseo_descarga_fallida` (transitoria).

import { mkdirSync, existsSync, lstatSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
import { ErrorVerbo } from "../errores.js";
import { tipoPorBytes, dimensiones, mimeDe } from "../util/imagen.js";
import { sanitizeTitle } from "../util/texto.js";
import { crearFichero, existe, validarReglas, componerMd, reescribirFichero } from "../contenido/escribir.js";
import { contenidoExistente, imagen } from "./lectura.js";
import { atributo } from "../sitio.js";

export const TAMANO_MAXIMO_IMAGEN = 10485760; // Escritura::TAMANO_MAXIMO_IMAGEN
export const HOSTS_DE_MEDIOS = Object.freeze(["tranquiseo.com", "medios.tranquiseo.com"]);

export function catalogo() {
  return {
    "media.upload": {
      tipo: "escritura",
      esquema: {
        url: { tipo: "url" },
        contenido: { tipo: "base64", largo: 1600000 },
        nombre: { tipo: "texto", largo: 200 },
        titulo: { tipo: "texto", largo: 300 },
        alt: { tipo: "texto", largo: 300 },
        adjuntar_a: { tipo: "entero", minimo: 0, defecto: 0 },
      },
      ejecutar: mediaUpload,
    },
    "media.updateAlt": {
      tipo: "escritura",
      esquema: {
        id: { tipo: "entero", minimo: 1, obligatorio: true },
        alt: { tipo: "texto", largo: 300, obligatorio: true },
        purgar_url: { tipo: "url" },
      },
      ejecutar: mediaUpdateAlt,
    },
  };
}

// ---------- descarga (la hace el despacho antes de ejecutar) ----------

/** Comprobaciones de `media_upload` sobre la URL, sin red. Devuelve el host o lanza. */
export function validarUrlMedio(url, hosts = HOSTS_DE_MEDIOS) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new ErrorVerbo("tranquiseo_origen_no_permitido", "Solo se descargan imágenes por https.");
  }
  if (u.protocol !== "https:" || !u.hostname) throw new ErrorVerbo("tranquiseo_origen_no_permitido", "Solo se descargan imágenes por https.");
  const host = u.hostname.toLowerCase();
  if (!hosts.includes(host)) throw new ErrorVerbo("tranquiseo_origen_no_permitido", "Solo se descargan imágenes de nuestro almacén.", { host });
  if (u.username || u.password || u.port) throw new ErrorVerbo("tranquiseo_origen_no_permitido", "La URL lleva credenciales o puerto.");
  return host;
}

/** IP pública (no privada, no local, no reservada). */
export function ipPublica(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224);
  }
  if (isIP(ip) === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1" || s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb") || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("ff")) return false;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    return m ? ipPublica(m[1]) : true;
  }
  return false;
}

/**
 * `lookup` que siempre contesta la IP ya comprobada. Node 22+ (autoSelectFamily) lo llama con
 * `{all: true}` y espera una lista; con una IP suelta la conexión falla (J8, M4).
 */
export function lookupFijado(ip) {
  const family = isIP(ip);
  return (_host, opciones, cb) => {
    if (typeof opciones === "function") return opciones(null, ip, family);
    if (opciones && opciones.all) return cb(null, [{ address: ip, family }]);
    return cb(null, ip, family);
  };
}

/**
 * Descarga real: IP comprobada y FIJADA en la conexión (sin segundo DNS: rebinding), sin seguir
 * redirecciones, con tope de bytes y de tiempo.
 * @returns {Promise<Buffer>}
 */
export async function descargarMedio(url, { hosts = HOSTS_DE_MEDIOS, maximo = TAMANO_MAXIMO_IMAGEN, tope = 30000 } = {}) {
  const host = validarUrlMedio(url, hosts);
  let ip;
  try {
    ip = (await lookup(host)).address;
  } catch {
    throw new ErrorVerbo("tranquiseo_descarga_fallida", "No se ha podido resolver el host de la imagen.");
  }
  if (!ipPublica(ip)) throw new ErrorVerbo("tranquiseo_origen_no_permitido", "El host no resuelve a una IP pública.");
  return await new Promise((ok, ko) => {
    const peticion = request(url, {
      method: "GET", timeout: tope, headers: { Accept: "image/*" },
      lookup: lookupFijado(ip),
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return ko(new ErrorVerbo("tranquiseo_descarga_fallida", `La descarga ha respondido ${res.statusCode}.`, { http: res.statusCode }));
      }
      const trozos = [];
      let total = 0;
      res.on("data", (t) => {
        total += t.length;
        if (total > maximo) {
          peticion.destroy();
          ko(new ErrorVerbo("tranquiseo_imagen_demasiado_grande", `La imagen pasa del máximo de ${maximo} bytes.`));
        } else trozos.push(t);
      });
      res.on("end", () => ok(Buffer.concat(trozos)));
      res.on("error", () => ko(new ErrorVerbo("tranquiseo_descarga_fallida", "La descarga se ha cortado.")));
    });
    peticion.on("timeout", () => peticion.destroy(new Error("tiempo")));
    peticion.on("error", () => ko(new ErrorVerbo("tranquiseo_descarga_fallida", "No se ha podido descargar la imagen.")));
    peticion.end();
  });
}

// ---------- verbos ----------

function anotar(motor, datos) {
  motor.registro.anotar({ orden: motor.orden, ...datos }, Math.floor(motor.sitio.ahora() / 1000));
}

/** Carpeta del medio: la de su entrada, o `<colección de posts>/subidas` (dentro de `media.dir`). */
function carpetaDe(sitio, adjuntarA) {
  const base = resolve(sitio.raizAstro, sitio.config.media.dir);
  let partes;
  if (adjuntarA > 0) {
    const c = contenidoExistente(sitio, adjuntarA);
    partes = [c.coleccion, c.slug];
  } else {
    const col = sitio.config.colecciones.post ?? Object.values(sitio.config.colecciones)[0];
    partes = [col.nombre, "subidas"];
  }
  partes = partes.map((p) => sanitizeTitle(p) || "x");
  const dir = join(base, ...partes);
  if (!dir.startsWith(base + sep)) throw new ErrorVerbo("tranquiseo_ruta_prohibida", "Ruta de medio fuera de su carpeta.");
  // Ninguna carpeta del camino puede ser un enlace simbólico.
  let actual = sitio.raizRepo;
  for (const trozo of dir.slice(sitio.raizRepo.length + 1).split(sep)) {
    actual = join(actual, trozo);
    if (existe(actual) && lstatSync(actual).isSymbolicLink()) throw new ErrorVerbo("tranquiseo_ruta_prohibida", "La carpeta de destino es un enlace simbólico.");
  }
  return dir;
}

function nombreBase(args) {
  let n = args.nombre ?? "";
  if (n === "" && args.url) {
    try {
      n = decodeURIComponent(new URL(args.url).pathname.split("/").pop() ?? "");
    } catch {
      n = "";
    }
  }
  n = n.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  return (sanitizeTitle(n).slice(0, 100).replace(/-+$/, "") || "imagen");
}

function mediaUpload(sitio, args, motor) {
  const tieneUrl = typeof args.url === "string" && args.url !== "";
  const tieneBytes = typeof args.contenido === "string" && args.contenido !== "";
  if (tieneUrl === tieneBytes) {
    throw new ErrorVerbo("tranquiseo_argumento_no_permitido", "Hay que mandar la imagen de una de las dos formas: `url` de nuestro almacén o `contenido` en base64.");
  }
  let bytes;
  let origen;
  if (tieneBytes) {
    bytes = Buffer.from(args.contenido, "base64");
    if (bytes.length === 0) throw new ErrorVerbo("tranquiseo_no_es_imagen", "El contenido no se ha podido descodificar.");
    if (bytes.length > TAMANO_MAXIMO_IMAGEN) throw new ErrorVerbo("tranquiseo_demasiado_grande", `La imagen pasa del máximo de ${TAMANO_MAXIMO_IMAGEN} bytes.`);
    origen = "bytes";
  } else {
    validarUrlMedio(args.url, motor.hostsMedios ?? HOSTS_DE_MEDIOS);
    const previo = motor.descargas?.get(args.url);
    if (previo instanceof ErrorVerbo) throw previo;
    if (!Buffer.isBuffer(previo)) throw new ErrorVerbo("tranquiseo_descarga_fallida", "No se ha podido descargar la imagen.");
    bytes = previo;
    origen = args.url;
  }
  const tipo = tipoPorBytes(bytes);
  if (!tipo || !dimensiones(bytes)) throw new ErrorVerbo("tranquiseo_no_es_imagen", "Lo recibido no es una imagen.");

  const dir = carpetaDe(sitio, args.adjuntar_a ?? 0);
  const base = nombreBase(args);
  let nombre = `${base}.${tipo}`;
  for (let i = 2; existe(join(dir, nombre)); i++) {
    if (i > 999) throw new ErrorVerbo("tranquiseo_argumento_invalido", "No hay un nombre libre para esa imagen.");
    nombre = `${base}-${i}.${tipo}`;
  }
  const abs = join(dir, nombre);
  const ruta = sitio.rutaRepo(abs);
  anotar(motor, { verbo: "media.upload", id: null, ruta, anterior: null, nuevo: { origen: origen === "bytes" ? "bytes" : "url", bytes: bytes.length } });
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  crearFichero(sitio, abs, bytes);
  const alt = typeof args.alt === "string" ? args.alt : "";
  const id = sitio.ids.asignar({ tipo: "media", ruta, ...(alt !== "" ? { alt } : {}) });
  sitio.invalidar();
  const m = sitio.medio(id);
  return { id, url: imagen(sitio, m).url, mime: mimeDe(tipo), alt };
}

const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escMd = (s) => String(s).replace(/[\\[\]]/g, (c) => "\\" + c);

/** Cambia el alt de todos los usos de `rutaMedio` en el cuerpo. Devuelve [cuerpoNuevo, cambiado]. */
function altEnCuerpo(sitio, cuerpo, rutaMedio, alt) {
  let cambiado = false;
  let salida = cuerpo.replace(/!\[([^\]]*)\]\(\s*(<?)([^)\s>]+)(>?)([^)]*)\)/g, (todo, _alt, a, src, b, resto) => {
    if (sitio.rutaDeSrc(src) !== rutaMedio) return todo;
    cambiado = true;
    return `![${escMd(alt)}](${a}${src}${b}${resto})`;
  });
  salida = salida.replace(/<img\b[^>]*>/gi, (etiqueta) => {
    if (sitio.rutaDeSrc(atributo(etiqueta, "src")) !== rutaMedio) return etiqueta;
    cambiado = true;
    const conAlt = /\salt\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i;
    if (conAlt.test(etiqueta)) return etiqueta.replace(conAlt, ` alt="${escHtml(alt)}"`);
    return etiqueta.replace(/^<img\b/i, `<img alt="${escHtml(alt)}"`);
  });
  return [salida, cambiado];
}

function mediaUpdateAlt(sitio, args, motor) {
  const m = sitio.medio(args.id);
  if (!m) throw new ErrorVerbo("tranquiseo_no_encontrado", "No existe esa imagen.");
  const anterior = m.alt ?? "";

  // purgar_url: inválida ya la paró el esquema. Ajena o con «..» → aviso (como `url_purgable`).
  let avisoPurga = null;
  if (typeof args.purgar_url === "string" && args.purgar_url !== "") {
    try {
      const u = new URL(args.purgar_url);
      if (u.username || u.password) avisoPurga = "purgar_url no es una URL http o https absoluta.";
      else if (u.pathname.split("/").some((s) => decodeURIComponent(s) === "..")) avisoPurga = "purgar_url lleva segmentos «..» en la ruta.";
      else if (u.hostname.toLowerCase() !== new URL(sitio.config.homeUrl).hostname.toLowerCase()) avisoPurga = "purgar_url no es de este sitio.";
    } catch {
      avisoPurga = "purgar_url no es una URL http o https absoluta.";
    }
  }

  // Primero se prepara todo; si un fichero no se puede reescribir, no se escribe ninguno.
  const cambios = [];
  for (const id of m.usos) {
    const c = contenidoExistente(sitio, id);
    if (!c.estandar) {
      throw new ErrorVerbo("tranquiseo_no_disponible", "Una entrada que usa esta imagen tiene un frontmatter que no sabemos reescribir.",
        { capacidad: "contenido", motivo: c.motivo ?? "frontmatter_no_estandar", remedio: "Quitar del frontmatter los tags YAML (!!), anclas (&) y alias (*).", id });
    }
    const datos = structuredClone(c.datos);
    const campo = c.col.campos.imagen;
    if (campo && datos[campo] && typeof datos[campo] === "object" && sitio.rutaDeSrc(datos[campo].src) === m.urlRuta) datos[campo].alt = args.alt;
    const [cuerpo] = altEnCuerpo(sitio, c.cuerpo, m.urlRuta, args.alt);
    validarReglas(c.col, datos);
    cambios.push({ c, texto: componerMd(c.yaml, datos, cuerpo) });
  }
  anotar(motor, { verbo: "media.updateAlt", id: m.id, ruta: m.ruta, anterior: { alt: anterior }, nuevo: { alt: args.alt, usos: m.usos } });
  for (const { c, texto } of cambios) reescribirFichero(sitio, c.abs, texto);
  sitio.ids.actualizar(m.id, { alt: args.alt });
  sitio.invalidar();

  const respuesta = { id: m.id, alt: args.alt, anterior, usos: cambios.map(({ c }) => c.id) };
  if (typeof args.purgar_url === "string" && args.purgar_url !== "") {
    respuesta.cache = { plugin: "ninguno", purgada: false, alcance: "ninguno", borde_desconocida: true, constructor: null };
    respuesta.avisos = avisoPurga
      ? [`No se ha purgado la caché: ${avisoPurga}`]
      : ["Esta web no tiene caché que purgar: el cambio sale con el próximo despliegue."];
  }
  return respuesta;
}
