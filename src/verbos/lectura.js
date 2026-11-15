// Los 13 verbos de lectura (catálogo copiado de `Verbos/Lectura.php`). Ninguno escribe nada
// del sitio; lo único que puede cambiar es `.tranquiseo/ids.json` (ids para ficheros nuevos),
// y eso lo persiste el ciclo.

import { readFileSync, existsSync, lstatSync } from "node:fs";
import { ErrorVerbo } from "../errores.js";
import { capacidades, redirecciones as capRedirecciones, versionAstro } from "../capacidades.js";
import { VERSION_CONECTOR } from "../sitio.js";
import { contarPalabras, normalizarBusqueda, sanitizeTitle, quitarEtiquetas } from "../util/texto.js";
import { formatoUtc } from "../util/fechas.js";
import { historial, idDeCommit } from "../util/git.js";
import { decodificarEntidades } from "../sitio.js";
import { cuerpoComoHtml } from "../contenido/html.js";

export const POR_PAGINA = 20;

const paginacion = {
  pagina: { tipo: "entero", minimo: 1, maximo: 5000, defecto: 1 },
  por_pagina: { tipo: "entero", minimo: 1, maximo: 100, defecto: POR_PAGINA },
};
const unId = { id: { tipo: "entero", minimo: 1, obligatorio: true } };

export function catalogo() {
  return {
    "site.info": { tipo: "lectura", esquema: {}, ejecutar: siteInfo },
    "site.capabilities": { tipo: "lectura", esquema: { refrescar: { tipo: "booleano", defecto: false } }, ejecutar: siteCapabilities },
    "content.list": {
      tipo: "lectura",
      esquema: {
        ...paginacion,
        tipo: { tipo: "opcion", valores: ["post", "page", "todos"], defecto: "todos" },
        estado: { tipo: "opcion", valores: ["publish", "draft", "pending", "future", "private", "todos"], defecto: "publish" },
      },
      ejecutar: contentList,
    },
    "content.get": { tipo: "lectura", esquema: unId, ejecutar: contentGet },
    "content.resolveUrl": { tipo: "lectura", esquema: { url: { tipo: "url", obligatorio: true } }, ejecutar: contentResolveUrl },
    "content.search": { tipo: "lectura", esquema: { ...paginacion, texto: { tipo: "texto", largo: 200, obligatorio: true } }, ejecutar: contentSearch },
    "seo.get": { tipo: "lectura", esquema: unId, ejecutar: seoGet },
    "media.list": { tipo: "lectura", esquema: paginacion, ejecutar: mediaList },
    "media.get": { tipo: "lectura", esquema: unId, ejecutar: mediaGet },
    "taxonomy.list": {
      tipo: "lectura",
      esquema: { taxonomia: { tipo: "opcion", valores: ["category", "post_tag"], defecto: "category" } },
      ejecutar: taxonomyList,
    },
    "revisions.list": { tipo: "lectura", esquema: unId, ejecutar: revisionsList },
    "sitemap.get": { tipo: "lectura", esquema: {}, ejecutar: sitemapGet },
    "redirects.list": {
      tipo: "lectura",
      esquema: { por_pagina: { tipo: "entero", minimo: 1, maximo: 200, defecto: 50 } },
      necesita: "redirecciones",
      ejecutar: redirectsList,
    },
  };
}

// ---------- utilidades compartidas con la escritura ----------

export function paginar(lista, pagina, porPagina) {
  const total = lista.length;
  return {
    total,
    paginas: Math.ceil(total / porPagina),
    elementos: lista.slice((pagina - 1) * porPagina, pagina * porPagina),
  };
}

export function contenidoExistente(sitio, id) {
  const c = sitio.contenido(id);
  if (!c) throw new ErrorVerbo("tranquiseo_no_encontrado", "No existe ese contenido.");
  return c;
}

/** Ruta de una URL del sitio sin barras en los extremos (`Redirecciones::ruta`), o null si es de otro host. */
export function rutaDeUrl(sitio, url) {
  let valor = String(url).trim();
  if (/^https?:\/\//i.test(valor)) {
    let dada;
    try {
      dada = new URL(valor);
    } catch {
      return null;
    }
    if (dada.hostname.toLowerCase() !== new URL(sitio.config.homeUrl).hostname.toLowerCase()) return null;
    valor = dada.pathname || "/";
    try {
      valor = decodeURI(valor);
    } catch {
      // se queda codificada
    }
  }
  return valor.split("?")[0].split("#")[0].replace(/^\/+|\/+$/g, "");
}

export function urlDeRuta(sitio, ruta) {
  return sitio.config.homeUrl + "/" + (ruta === "" ? "" : ruta + "/");
}

function texto(v) {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

export function resumen(sitio, c) {
  return {
    id: c.id,
    tipo: c.tipo,
    titulo: texto(c.datos[c.col.campos.titulo]),
    slug: c.slug,
    estado: c.estado,
    url: c.url,
    publicado: sitio.fechaPublicado(c),
    modificado: sitio.fechaModificado(c),
    palabras: contarPalabras(c.cuerpo),
  };
}

function extracto(c) {
  const campo = c.col.campos.extracto;
  return campo ? texto(c.datos[campo]) : "";
}

function listaDeTextos(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x.trim() !== "");
  if (typeof v === "string" && v.trim() !== "") return [v];
  return [];
}

/** Ids sintéticos de términos (etiquetas/categorías por nombre). Estables: `clave` = taxonomía:slug. */
export function terminoId(sitio, taxonomia, nombre) {
  const clave = `${taxonomia}:${sanitizeTitle(nombre) || nombre}`;
  const e = sitio.ids.porClave("termino", clave);
  return e ? e.id : sitio.ids.asignar({ tipo: "termino", clave, taxonomia, nombre });
}

export function campoTaxonomia(taxonomia) {
  return taxonomia === "post_tag" ? "etiquetas" : "categorias";
}

function terminosDe(sitio, c, taxonomia) {
  const campo = c.col.campos[campoTaxonomia(taxonomia)];
  if (!campo) return [];
  return listaDeTextos(c.datos[campo]).map((nombre) => ({ id: terminoId(sitio, taxonomia, nombre), nombre, slug: sanitizeTitle(nombre) }));
}

function robotsDe(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return [];
}

/** SEO de una entrada (`Adaptadores/Seo::leer`). Un campo que la web no tiene sale `null`. */
export function seoDe(c) {
  const campos = c.col.campos;
  const lee = (k) => (campos[k] ? texto(c.datos[campos[k]]) : null);
  const salida = {
    plugin: "astro-frontmatter",
    titulo: lee("seo_titulo"),
    descripcion: lee("seo_descripcion"),
    canonical: lee("canonical"),
    robots: campos.robots ? robotsDe(c.datos[campos.robots]) : null,
    palabra_clave: lee("palabra_clave"),
    hereda_de_plantilla: false,
    legible: c.estandar,
  };
  salida.hereda_de_plantilla = !salida.titulo && !salida.descripcion;
  return salida;
}

// ---------- los verbos ----------

function siteInfo(sitio) {
  const { contenidos } = sitio.cargar();
  const cuenta = (t) => contenidos.filter((c) => c.tipo === t && c.estado === "publish").length;
  const c = sitio.config;
  return {
    plataforma: "astro",
    astro: versionAstro(sitio),
    node: process.version,
    nombre: null,
    descripcion: null,
    home_url: c.homeUrl,
    site_url: c.homeUrl,
    permalinks: Object.fromEntries(Object.entries(c.colecciones).map(([t, col]) => [t, col.url])),
    idioma: null,
    zona: c.zona,
    inicio: null,
    cuentas: { post: cuenta("post"), page: cuenta("page") },
    conector: VERSION_CONECTOR,
  };
}

function siteCapabilities(sitio, _args, motor) {
  // `refrescar` se acepta y no cambia nada: no hay caché de capacidades que invalidar.
  return capacidades(sitio, motor.verbos(), motor.escrituras());
}

function porModificado(sitio) {
  return (a, b) => {
    const ma = sitio.fechaModificado(a) ?? "";
    const mb = sitio.fechaModificado(b) ?? "";
    return ma < mb ? 1 : ma > mb ? -1 : b.id - a.id;
  };
}

function contentList(sitio, args) {
  const estados = args.estado === "todos" ? ["publish", "draft", "pending", "future", "private"] : [args.estado];
  const lista = sitio.cargar().contenidos
    .filter((c) => (args.tipo === "todos" || c.tipo === args.tipo) && estados.includes(c.estado))
    .sort(porModificado(sitio));
  const p = paginar(lista, args.pagina, args.por_pagina);
  return { total: p.total, paginas: p.paginas, pagina: args.pagina, elementos: p.elementos.map((c) => resumen(sitio, c)) };
}

function contentGet(sitio, args) {
  const c = contenidoExistente(sitio, args.id);
  return {
    ...resumen(sitio, c),
    // El cuerpo en HTML (como `post_content`): el core trabaja en HTML. Markdown → HTML sin
    // layout ni plugins del sitio; `contenido_fuente` es el fichero tal cual.
    contenido: cuerpoComoHtml(c.cuerpo),
    contenido_fuente: c.cuerpo,
    extracto: extracto(c),
    autor: 0,
    padre: 0,
    plantilla: "",
    categorias: terminosDe(sitio, c, "category"),
    etiquetas: terminosDe(sitio, c, "post_tag"),
    destacada: c.destacada,
    constructor: null,
    editable: c.estandar,
    motivo: c.estandar ? null : c.motivo,
    seo: seoDe(c),
    coleccion: c.coleccion,
    frontmatter: c.estandar ? structuredClone(c.datos) : null,
  };
}

function contentResolveUrl(sitio, args) {
  const ruta = rutaDeUrl(sitio, args.url);
  if (ruta === null) throw new ErrorVerbo("tranquiseo_url_ajena", "Esa URL no pertenece a este sitio.");
  const salida = {
    url: urlDeRuta(sitio, ruta), id: null, tipo: null, es_termino: false, term_id: null, taxonomia: null,
    redirigida_a: null, editable: null, motivo: null,
  };

  // 1. Contenido: el patrón de URL de cada colección, confirmado con la URL de la entrada.
  const c = sitio.cargar().contenidos.find((x) => rutaDeUrl(sitio, x.url) === ruta);
  if (c) {
    return { ...salida, id: c.id, tipo: c.tipo, url: c.url, editable: c.estandar, motivo: c.estandar ? null : c.motivo };
  }

  // 2. Una página que pinta el código (`index.astro`, `nosotros.astro`…): existe, pero no se edita.
  if (sitio.config.paginasFijas.some((p) => p.replace(/^\/+|\/+$/g, "") === ruta)) {
    return { ...salida, editable: false, motivo: "lo_pinta_el_codigo" };
  }

  // 3. Una regla de redirección nuestra con ese origen.
  const regla = leerRedirecciones(sitio).reglas.find((r) => String(r.origen).replace(/^\/+|\/+$/g, "") === ruta);
  if (regla && regla.destino) return { ...salida, redirigida_a: regla.destino, motivo: "redirigida" };

  return { ...salida, motivo: "no_encontrada" };
}

function contentSearch(sitio, args) {
  const aguja = normalizarBusqueda(args.texto);
  const palabras = aguja.split(" ").filter(Boolean);
  if (palabras.length === 0) return { total: 0, paginas: 0, elementos: [] };
  const casa = (s) => {
    const h = normalizarBusqueda(s);
    return palabras.every((p) => h.includes(p));
  };
  const titulo = (c) => texto(c.datos[c.col.campos.titulo]);
  const lista = sitio.cargar().contenidos
    .filter((c) => c.estado === "publish")
    .map((c) => ({ c, enTitulo: casa(titulo(c)) }))
    .filter(({ c, enTitulo }) => enTitulo || casa([titulo(c), quitarEtiquetas(extracto(c)), decodificarEntidades(quitarEtiquetas(c.cuerpo))].join(" ")))
    .sort((a, b) => (a.enTitulo === b.enTitulo ? porModificado(sitio)(a.c, b.c) : a.enTitulo ? -1 : 1))
    .map(({ c }) => c);
  const p = paginar(lista, args.pagina, args.por_pagina);
  return { total: p.total, paginas: p.paginas, elementos: p.elementos.map((c) => resumen(sitio, c)) };
}

function seoGet(sitio, args) {
  return seoDe(contenidoExistente(sitio, args.id));
}

export function imagen(sitio, m) {
  return {
    id: m.id,
    url: sitio.config.homeUrl + encodeURI(m.urlRuta),
    titulo: m.nombre.replace(/\.[^.]+$/, ""),
    alt: m.alt ?? "",
    sin_alt: (m.alt ?? "").trim() === "",
    mime: m.mime,
    usada_en: m.usos[0] ?? 0,
    usos: [...m.usos],
  };
}

function mediaList(sitio, args) {
  const lista = [...sitio.cargar().medios].sort((a, b) => b.id - a.id);
  const p = paginar(lista, args.pagina, args.por_pagina);
  return { total: p.total, paginas: p.paginas, elementos: p.elementos.map((m) => imagen(sitio, m)) };
}

function mediaGet(sitio, args) {
  const m = sitio.medio(args.id);
  if (!m) throw new ErrorVerbo("tranquiseo_no_encontrado", "No existe esa imagen.");
  return imagen(sitio, m);
}

function taxonomyList(sitio, args) {
  const campoLogico = campoTaxonomia(args.taxonomia);
  const cuentas = new Map();
  for (const c of sitio.cargar().contenidos) {
    const campo = c.col.campos[campoLogico];
    if (!campo || c.tipo !== "post") continue;
    for (const nombre of listaDeTextos(c.datos[campo])) {
      const slug = sanitizeTitle(nombre) || nombre;
      const previo = cuentas.get(slug) ?? { nombre, cuenta: 0 };
      if (c.estado === "publish") previo.cuenta += 1;
      cuentas.set(slug, previo);
    }
  }
  // Sin campo en la config, lista vacía (como el plugin ante una taxonomía sin términos).
  const elementos = [...cuentas.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([slug, { nombre, cuenta }]) => ({ id: terminoId(sitio, args.taxonomia, nombre), nombre, slug, padre: 0, cuenta }));
  return { taxonomia: args.taxonomia, elementos };
}

function revisionsList(sitio, args) {
  const c = contenidoExistente(sitio, args.id);
  const elementos = historial(sitio.raizRepo, c.ruta).map(({ sha, fecha }) => ({
    id: idDeCommit(sha),
    fecha: formatoUtc(new Date(fecha)),
    autor: 0,
  }));
  // A diferencia de WordPress, el frontmatter (todo el SEO) va en el mismo fichero: restaurar
  // una revisión SÍ deshace un cambio de SEO.
  return { elementos, cubren_post_meta: true };
}

function sitemapGet(sitio) {
  const h = sitio.config.homeUrl;
  return { candidatas: [`${h}/sitemap-index.xml`, `${h}/sitemap.xml`], seo: "astro", modulo: sitio.config.sitemap };
}

/** `.tranquiseo/redirecciones.json` (o la ruta de la config). Nunca sigue enlaces simbólicos. */
export function leerRedirecciones(sitio) {
  const vacio = { siguiente: 1, reglas: [] };
  if (!sitio.config.redirecciones) return vacio;
  const abs = sitio.rutaAbsoluta(sitio.config.redirecciones);
  if (!existsSync(abs)) return vacio;
  if (lstatSync(abs).isSymbolicLink()) throw new Error("estado_es_enlace_simbolico");
  let datos;
  try {
    datos = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    throw new Error("estado_ilegible:redirecciones.json");
  }
  if (!datos || !Array.isArray(datos.reglas)) throw new Error("estado_ilegible:redirecciones.json");
  return { siguiente: Number.isSafeInteger(datos.siguiente) ? datos.siguiente : 1, reglas: datos.reglas };
}

function redirectsList(sitio, args) {
  const { reglas } = leerRedirecciones(sitio);
  const ordenadas = [...reglas].sort((a, b) => b.id - a.id);
  return {
    proveedor: capRedirecciones(sitio).proveedor,
    total: ordenadas.length,
    elementos: ordenadas.slice(0, args.por_pagina).map((r) => ({
      id: r.id,
      origen: [{ patron: String(r.origen), comparacion: "exact" }],
      destino: r.destino,
      tipo: r.codigo,
      gestionada_por: "tranquiseo",
    })),
  };
}
