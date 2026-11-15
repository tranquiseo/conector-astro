// El sitio visto como ficheros: colecciones `.md` mapeadas en la config, medios bajo `media.dir`
// y los ids sintéticos de `.tranquiseo/ids.json`. Lo usan todos los verbos.
//
// Rutas: `ruta` (la que guarda ids.json) es relativa a la RAÍZ DEL REPO y con `/`, que es lo que
// ve git. `dir` de colección y `media.dir` son relativas a la raíz del proyecto Astro (`raiz`).

import { readdirSync, readFileSync, lstatSync, existsSync } from "node:fs";
import { join, resolve, relative, sep, posix } from "node:path";
import { cargarConfig } from "./config.js";
import { Almacen } from "./estado/almacen.js";
import { Ids } from "./estado/ids.js";
import { leerMd } from "./contenido/frontmatter.js";
import { fechaDeFrontmatter } from "./util/fechas.js";

export const VERSION_CONECTOR = "astro-0.1.0";
export const ESTADOS_NO_PUBLICOS = Object.freeze(["draft", "pending", "future", "private"]);

const EXT_IMAGEN = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif", svg: "image/svg+xml" };
const MAX_FICHEROS = 20000;
const MAX_PROFUNDIDAD = 8;
const MAX_MD = 4 * 1024 * 1024;

const aPosix = (r) => r.split(sep).join("/");

export class Sitio {
  /**
   * @param {string} raizRepo
   * @param {{config?: object, ahora?: () => number}} [opciones]
   */
  constructor(raizRepo, opciones = {}) {
    this.raizRepo = resolve(raizRepo);
    this.config = opciones.config ?? cargarConfig(this.raizRepo);
    this.raizAstro = resolve(this.raizRepo, this.config.raiz);
    if (this.raizAstro !== this.raizRepo && !this.raizAstro.startsWith(this.raizRepo + sep)) throw new Error("raiz_fuera_del_repo");
    this.almacen = new Almacen(this.raizRepo);
    this.ids = new Ids(this.almacen);
    this.ahora = opciones.ahora ?? (() => Date.now());
    this.#cache = null;
  }

  #cache;

  /** Olvida lo leído (tras escribir). */
  invalidar() {
    this.#cache = null;
  }

  rutaAbsoluta(rutaRepo) {
    const abs = resolve(this.raizRepo, rutaRepo);
    if (!abs.startsWith(this.raizRepo + sep)) throw new Error("ruta_fuera_del_repo");
    return abs;
  }

  rutaRepo(abs) {
    return aPosix(relative(this.raizRepo, abs));
  }

  /** Lee colecciones y medios y da id a lo que no lo tiene. */
  cargar() {
    if (this.#cache) return this.#cache;
    const contenidos = [];
    for (const col of Object.values(this.config.colecciones)) {
      const dirAbs = resolve(this.raizAstro, col.dir);
      if (!dirAbs.startsWith(this.raizRepo + sep) || !existsSync(dirAbs) || lstatSync(dirAbs).isSymbolicLink()) continue;
      for (const nombre of readdirSync(dirAbs).sort()) {
        if (!nombre.endsWith(".md")) continue;
        const abs = join(dirAbs, nombre);
        const st = lstatSync(abs);
        if (!st.isFile() || st.size > MAX_MD) continue;
        contenidos.push(this.#leerEntrada(col, nombre, abs));
      }
    }
    this.ids.sincronizar("contenido", contenidos.map((c) => ({ ruta: c.ruta, coleccion: c.coleccion })));
    const porId = new Map();
    for (const c of contenidos) {
      const reg = this.ids.porRuta(c.ruta, "contenido");
      c.id = reg.id;
      c.estado = this.#estado(c, reg);
      c.url = this.urlDe(c.col, c.slug);
      porId.set(c.id, c);
    }

    const medios = this.#leerMedios();
    this.ids.sincronizar("media", medios.map((m) => ({ ruta: m.ruta })));
    for (const m of medios) {
      const reg = this.ids.porRuta(m.ruta, "media");
      m.id = reg.id;
      m.altPropio = typeof reg.alt === "string" ? reg.alt : null;
    }
    const mediosPorUrl = new Map(medios.map((m) => [m.urlRuta, m]));

    // Usos: quién referencia cada medio y con qué alt (en Astro el alt vive en cada uso).
    for (const c of contenidos) {
      c.usos = this.#usosDe(c);
      for (const u of c.usos) {
        const m = mediosPorUrl.get(u.src);
        if (!m) continue;
        if (!m.usos.includes(c.id)) m.usos.push(c.id);
        if (m.alt === null && typeof u.alt === "string") m.alt = u.alt;
      }
      const campoImagen = c.col.campos.imagen;
      const img = campoImagen ? c.datos[campoImagen] : null;
      const src = img && typeof img === "object" ? this.#rutaDeSrc(img.src) : null;
      c.destacada = src && mediosPorUrl.has(src) ? mediosPorUrl.get(src).id : null;
    }

    // Sin uso, el alt que se le dio al subirla (media.upload / media.updateAlt lo guardan en ids.json).
    for (const m of medios) if (m.alt === null) m.alt = m.altPropio;

    this.#cache = { contenidos, porId, medios, mediosPorUrl };
    return this.#cache;
  }

  /** Guarda ids nuevos si los hubo. Devuelve true si cambió ids.json. */
  guardarIds() {
    const cambiado = this.ids.cambiado;
    this.ids.guardar();
    return cambiado;
  }

  contenido(id) {
    return this.cargar().porId.get(id) ?? null;
  }

  medio(id) {
    return this.cargar().medios.find((m) => m.id === id) ?? null;
  }

  /** `src` de una imagen (relativo o absoluto del propio sitio) → ruta del sitio, o null. */
  rutaDeSrc(src) {
    return this.#rutaDeSrc(src);
  }

  medioPorSrc(src) {
    const r = this.#rutaDeSrc(src);
    return r ? this.cargar().mediosPorUrl.get(r) ?? null : null;
  }

  urlDe(col, slug) {
    return this.config.homeUrl + col.url.replace("{slug}", slug);
  }

  #leerEntrada(col, nombre, abs) {
    const { datos, cuerpo, estandar, motivo, yaml } = leerMd(readFileSync(abs, "utf8"));
    const base = nombre.slice(0, -3);
    const conPrefijo = base.startsWith("_");
    const slug = col.borradores?.modo === "prefijo" && conPrefijo ? base.slice(1) : base;
    return {
      tipo: col.tipo, coleccion: col.nombre, col, ruta: this.rutaRepo(abs), nombre, slug, conPrefijo,
      datos, cuerpo, estandar, motivo, yaml, abs,
    };
  }

  #estado(c, reg) {
    const b = c.col.borradores;
    let oculto = false;
    if (b?.modo === "prefijo") oculto = c.conPrefijo;
    else if (b?.modo === "campo") oculto = c.datos[b.campo] === true;
    if (!oculto) return "publish";
    return ESTADOS_NO_PUBLICOS.includes(reg.estado) ? reg.estado : "draft";
  }

  #leerMedios() {
    const dirAbs = resolve(this.raizAstro, this.config.media.dir);
    const salida = [];
    if (!dirAbs.startsWith(this.raizRepo + sep) || !existsSync(dirAbs) || lstatSync(dirAbs).isSymbolicLink()) return salida;
    const recorrer = (dir, prof) => {
      if (prof > MAX_PROFUNDIDAD || salida.length >= MAX_FICHEROS) return;
      for (const nombre of readdirSync(dir).sort()) {
        if (nombre.startsWith(".")) continue;
        const abs = join(dir, nombre);
        const st = lstatSync(abs);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) recorrer(abs, prof + 1);
        else if (st.isFile()) {
          const ext = nombre.includes(".") ? nombre.split(".").pop().toLowerCase() : "";
          if (!EXT_IMAGEN[ext]) continue;
          const bajoMedia = aPosix(relative(dirAbs, abs));
          salida.push({
            ruta: this.rutaRepo(abs), nombre, mime: EXT_IMAGEN[ext], bytes: st.size,
            urlRuta: posix.join(this.config.media.url, bajoMedia), alt: null, usos: [],
          });
        }
      }
    };
    recorrer(dirAbs, 0);
    return salida;
  }

  // `src` de una imagen → ruta del sitio (`/media/…`), aceptando la URL absoluta del propio sitio.
  #rutaDeSrc(src) {
    if (typeof src !== "string" || src === "") return null;
    let s = src.trim();
    if (s.startsWith(this.config.homeUrl + "/")) s = s.slice(this.config.homeUrl.length);
    if (!s.startsWith("/") || s.startsWith("//")) return null;
    s = s.split(/[?#]/)[0];
    try {
      s = decodeURI(s);
    } catch {
      return null;
    }
    return s;
  }

  #usosDe(c) {
    const usos = [];
    const campoImagen = c.col.campos.imagen;
    const img = campoImagen ? c.datos[campoImagen] : null;
    if (img && typeof img === "object") {
      const src = this.#rutaDeSrc(img.src);
      if (src) usos.push({ src, alt: typeof img.alt === "string" ? img.alt : null, donde: "frontmatter" });
    }
    for (const m of c.cuerpo.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)/g)) {
      const src = this.#rutaDeSrc(m[2]);
      if (src) usos.push({ src, alt: m[1], donde: "cuerpo" });
    }
    for (const m of c.cuerpo.matchAll(/<img\b[^>]*>/gi)) {
      const src = this.#rutaDeSrc(atributo(m[0], "src"));
      if (src) usos.push({ src, alt: atributo(m[0], "alt"), donde: "cuerpo" });
    }
    return usos;
  }

  fechaPublicado(c) {
    const campo = c.col.campos.fecha;
    return campo ? fechaDeFrontmatter(c.datos[campo], this.config.zona) : null;
  }

  fechaModificado(c) {
    const campo = c.col.campos.actualizado;
    return (campo ? fechaDeFrontmatter(c.datos[campo], this.config.zona) : null) ?? this.fechaPublicado(c);
  }
}

export function atributo(etiqueta, nombre) {
  const m = new RegExp(`\\s${nombre}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(etiqueta);
  if (!m) return null;
  return decodificarEntidades(m[1] ?? m[2] ?? m[3]);
}

export function decodificarEntidades(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}
