// Verbos de escritura de contenido (J4): `content.create`, `content.update`, `seo.update`.
// Esquemas copiados de `Verbos/Escritura.php`; la traducción a ficheros, de la spec §3.
// Regla de la casa: nada a medias. Todo se valida (esquema, capacidad, reglas de la colección)
// ANTES de tocar el disco, y lo que la web no puede guardar se dice (`tranquiseo_no_disponible`).

import { join, dirname } from "node:path";
import { unlinkSync } from "node:fs";
import { ErrorVerbo } from "../errores.js";
import { sanitizeTitle } from "../util/texto.js";
import { formatoUtc } from "../util/fechas.js";
import { textoPlano, cuerpoComoHtml, incrustadosPerdidos } from "../contenido/html.js";
import { validarReglas, aplicarDerivados, componerMd, diaLocal, crearFichero, reescribirFichero, moverFichero, existe } from "../contenido/escribir.js";
import { contenidoExistente, seoDe, rutaDeUrl, campoTaxonomia, terminoId } from "./lectura.js";
import { dimensiones } from "../util/imagen.js";
import { readFileSync } from "node:fs";
import { leerMd } from "../contenido/frontmatter.js";
import { rutasEnHistoria, ficheroEnCommit, idDeCommit } from "../util/git.js";
import { redirecciones as capRedirecciones, REMEDIOS_REDIRECCIONES } from "../capacidades.js";
import { comprobarRedireccion, crearRegla } from "./redirecciones.js";

export const ROBOTS = Object.freeze(["index", "noindex", "follow", "nofollow", "noarchive", "nosnippet", "noimageindex"]);
const ESTADOS = ["draft", "pending", "publish", "future", "private"];

const camposDeContenido = () => ({
  titulo: { tipo: "texto", largo: 300 },
  contenido: { tipo: "html" },
  extracto: { tipo: "html", largo: 5000 },
  estado: { tipo: "opcion", valores: ESTADOS },
  fecha: { tipo: "fecha" },
  categorias: { tipo: "lista_de_enteros", maximo_elementos: 50 },
  etiquetas: { tipo: "lista_de_enteros", maximo_elementos: 50 },
  destacada: { tipo: "entero", minimo: 0 },
  schema: { tipo: "schema" },
});

const camposSeo = () => ({
  titulo: { tipo: "texto", largo: 300 },
  descripcion: { tipo: "texto", largo: 500 },
  canonical: { tipo: "url" },
  robots: { tipo: "lista_de_opciones", valores: ROBOTS },
  palabra_clave: { tipo: "texto", largo: 200 },
});

// Campo SEO del contrato → campo lógico de la config.
const SEO_A_CAMPO = { titulo: "seo_titulo", descripcion: "seo_descripcion", canonical: "canonical", robots: "robots", palabra_clave: "palabra_clave" };

export function catalogo() {
  const id = { id: { tipo: "entero", minimo: 1, obligatorio: true } };
  return {
    "content.create": {
      tipo: "escritura",
      esquema: {
        tipo: { tipo: "opcion", valores: ["post", "page"], defecto: "post" },
        slug: { tipo: "texto", largo: 200 },
        padre: { tipo: "entero", minimo: 0 },
        ...camposDeContenido(),
        titulo: { tipo: "texto", largo: 300, obligatorio: true },
        estado: { tipo: "opcion", valores: ESTADOS, defecto: "draft" },
      },
      ejecutar: contentCreate,
    },
    "content.update": { tipo: "escritura", esquema: { ...id, ...camposDeContenido() }, ejecutar: contentUpdate },
    "seo.update": { tipo: "escritura", esquema: { ...id, ...camposSeo() }, necesita: "seo", ejecutar: seoUpdate },
    "content.updateSlug": {
      tipo: "escritura",
      esquema: {
        ...id,
        slug: { tipo: "texto", largo: 200, obligatorio: true },
        // Solo puede ir a false en contenido que nunca se ha publicado.
        redireccion: { tipo: "booleano", defecto: true },
      },
      ejecutar: contentUpdateSlug,
    },
    "revisions.restore": {
      tipo: "escritura",
      esquema: { ...id, revision_id: { tipo: "entero", minimo: 1, obligatorio: true } },
      ejecutar: revisionsRestore,
    },
  };
}

// ---------- ayudas ----------

function noDisponible(capacidad, motivo, mensaje, remedio) {
  return new ErrorVerbo("tranquiseo_no_disponible", mensaje, { capacidad, motivo, remedio });
}

function coleccionPara(sitio, tipo) {
  const col = sitio.config.colecciones[tipo];
  if (!col) {
    throw noDisponible(`content.${tipo}`, "coleccion_no_configurada", `Esta web no tiene una colección para «${tipo}».`,
      `Mapear una colección «${tipo}» en tranquiseo.config.json.`);
  }
  return col;
}

function comprobarEstado(col, estado) {
  if (estado !== "publish" && !col.borradores) {
    throw noDisponible("borradores", "sin_mecanismo_de_borradores", "Esta colección no tiene borradores: todo lo que se escribe se publica.",
      "Declarar en tranquiseo.config.json cómo filtra la web los borradores («borradores»: prefijo «_» o un campo).");
  }
}

function campoObligatorio(col, logico, capacidad) {
  const campo = col.campos[logico];
  if (!campo) {
    throw noDisponible(capacidad, "campo_no_existe_en_la_web", `Esta web no tiene el campo «${logico}».`,
      `Añadir el campo al esquema de la colección «${col.nombre}» y al layout, y mapearlo en tranquiseo.config.json (campos.${logico}).`);
  }
  return campo;
}

/** Slug explícito: se rechaza lo peligroso ANTES de normalizar (spec §7.5). */
export function slugExplicito(valor) {
  if (/[/\\.%\0-\x1f\x7f]/.test(valor) || valor.startsWith("_")) {
    throw new ErrorVerbo("tranquiseo_argumento_invalido", "El argumento slug no vale: solo letras, números y guiones.");
  }
  const s = sanitizeTitle(valor);
  if (s === "") throw new ErrorVerbo("tranquiseo_argumento_invalido", "El argumento slug no vale: queda vacío.");
  return s;
}

function rutaOcupada(sitio, col, slug, excepto = null) {
  const dir = join(sitio.raizAstro, col.dir);
  if (existe(join(dir, `${slug}.md`)) || existe(join(dir, `_${slug}.md`)) || existe(join(dir, `${slug}.mdx`))) return true;
  const ruta = rutaDeUrl(sitio, sitio.urlDe(col, slug));
  if (sitio.config.paginasFijas.some((p) => p.replace(/^\/+|\/+$/g, "") === ruta)) return true;
  return sitio.cargar().contenidos.some((c) => c.id !== excepto && rutaDeUrl(sitio, c.url) === ruta);
}

/** Como `wp_unique_post_slug`: `-2`, `-3`… */
function slugLibre(sitio, col, slug) {
  if (!rutaOcupada(sitio, col, slug)) return slug;
  for (let i = 2; i < 1000; i++) {
    const candidato = `${slug.slice(0, 195)}-${i}`;
    if (!rutaOcupada(sitio, col, candidato)) return candidato;
  }
  throw new ErrorVerbo("tranquiseo_slug_ocupado", "No hay un slug libre para ese título.");
}

function nombreFichero(col, slug, estado) {
  return col.borradores?.modo === "prefijo" && estado !== "publish" ? `_${slug}.md` : `${slug}.md`;
}

function marcarBorrador(col, datos, estado) {
  if (col.borradores?.modo !== "campo") return;
  if (estado === "publish") delete datos[col.borradores.campo];
  else datos[col.borradores.campo] = true;
}

function hoyUtc(sitio) {
  return formatoUtc(new Date(sitio.ahora()));
}

/** Ids de términos → nombres. Lo que no existe se avisa y se ignora (como el plugin). */
function nombresDeTerminos(sitio, col, arg, ids, avisos) {
  const taxonomia = arg === "etiquetas" ? "post_tag" : "category";
  const campo = col.campos[campoTaxonomia(taxonomia)];
  if (col.tipo === "page" || !campo) {
    avisos.push(col.tipo === "page" ? `Las páginas no llevan ${arg}.` : `Esta web no tiene ${arg}; se han ignorado.`);
    return null;
  }
  const nombres = [];
  for (const id of ids) {
    const e = sitio.ids.obtener(id);
    if (e && e.tipo === "termino" && e.taxonomia === taxonomia && typeof e.nombre === "string") nombres.push(e.nombre);
    else avisos.push(`El término ${id} de ${taxonomia} no existe y se ha ignorado.`);
  }
  return { campo, nombres: [...new Set(nombres)] };
}

/** Imagen destacada: objeto `{src, alt, ancho, alto}` del frontmatter (dimensiones leídas de los bytes). */
function imagenDestacada(sitio, col, idMedio, avisos) {
  const campo = campoObligatorio(col, "imagen", "contenido.destacada");
  if (idMedio === 0) return { campo, valor: undefined };
  const m = sitio.medio(idMedio);
  if (!m) {
    avisos.push("La imagen destacada no existe o no es una imagen; no se ha puesto.");
    return null;
  }
  const d = m.mime === "image/svg+xml" ? null : dimensiones(readFileSync(sitio.rutaAbsoluta(m.ruta)));
  if (!d) throw new ErrorVerbo("tranquiseo_argumento_invalido", "No se pueden leer las dimensiones de la imagen destacada.", { campo: `${campo}.ancho` });
  return { campo, valor: { src: m.urlRuta, alt: m.alt ?? "", ancho: d.ancho, alto: d.alto } };
}

function estadoDe(sitio, id) {
  const c = sitio.contenido(id);
  return {
    id: c.id, tipo: c.tipo, titulo: String(c.datos[c.col.campos.titulo] ?? ""), slug: c.slug, estado: c.estado,
    url: c.url, modificado: sitio.fechaModificado(c), revision: null,
  };
}

function editable(sitio, id) {
  const c = contenidoExistente(sitio, id);
  if (!c.estandar) {
    throw noDisponible("contenido", c.motivo ?? "frontmatter_no_estandar", "Este fichero tiene un frontmatter que no sabemos reescribir sin riesgo.",
      "Quitar del frontmatter los tags YAML (!!), anclas (&) y alias (*).");
  }
  return c;
}

function anotar(motor, datos) {
  motor.registro.anotar({ orden: motor.orden, ...datos }, Math.floor(motor.sitio.ahora() / 1000));
}

// ---------- verbos ----------

function contentCreate(sitio, args, motor) {
  const col = coleccionPara(sitio, args.tipo);
  if (!col.crear) {
    throw noDisponible("content.create", "crear_desactivado", `En esta web no se crean contenidos de tipo «${args.tipo}».`,
      "Sus páginas llevan campos de maquetación que no rellena el core: se crean a mano.");
  }
  if (args.padre) throw new ErrorVerbo("tranquiseo_argumento_invalido", "El argumento padre no vale: esta web no tiene jerarquía de páginas.");
  comprobarEstado(col, args.estado);
  if (args.estado === "future") {
    if (!args.fecha) throw new ErrorVerbo("tranquiseo_argumento_invalido", "Para programar hace falta la fecha.");
    if (args.fecha <= hoyUtc(sitio)) throw new ErrorVerbo("tranquiseo_argumento_invalido", "La fecha de un programado tiene que ser futura.");
  }
  const slug = slugLibre(sitio, col, args.slug !== undefined && args.slug !== "" ? slugExplicito(args.slug) : sanitizeTitle(args.titulo) || "entrada");

  const datos = {};
  const avisos = [];
  const campos = col.campos;
  const fechaUtc = args.fecha ?? hoyUtc(sitio);
  const dia = diaLocal(fechaUtc, sitio.config.zona);
  const extracto = args.extracto !== undefined ? textoPlano(args.extracto) : "";

  datos[campos.titulo] = args.titulo;
  if (args.extracto !== undefined && extracto !== "") datos[campoObligatorio(col, "extracto", "contenido.extracto")] = extracto;
  if (campos.fecha) datos[campos.fecha] = dia;
  else if (args.fecha !== undefined && args.estado !== "future") campoObligatorio(col, "fecha", "contenido.fecha");
  if (campos.actualizado) datos[campos.actualizado] = dia;
  for (const arg of ["categorias", "etiquetas"]) {
    if (args[arg] === undefined) continue;
    const t = nombresDeTerminos(sitio, col, arg, args[arg], avisos);
    if (t && t.nombres.length > 0) datos[t.campo] = t.nombres;
  }
  if (args.destacada) {
    const img = imagenDestacada(sitio, col, args.destacada, avisos);
    if (img && img.valor) datos[img.campo] = img.valor;
  }
  if (args.schema !== undefined && args.schema !== "") datos[campoObligatorio(col, "schema", "seo.schema")] = args.schema;
  marcarBorrador(col, datos, args.estado);
  aplicarDerivados(col, datos, { titulo: args.titulo, extracto, fecha: dia });
  validarReglas(col, datos);

  const texto = componerMd(null, datos, args.contenido ?? "");
  const abs = join(sitio.raizAstro, col.dir, nombreFichero(col, slug, args.estado));
  const ruta = sitio.rutaRepo(abs);
  anotar(motor, { verbo: "content.create", id: null, ruta, anterior: null, nuevo: { tipo: args.tipo, estado: args.estado, slug } });
  crearFichero(sitio, abs, texto);
  const id = sitio.ids.asignar({ tipo: "contenido", ruta, coleccion: col.nombre, ...(args.estado === "publish" ? {} : { estado: args.estado }) });
  if (args.estado === "future") motor.programados.fijar(id, args.fecha);
  sitio.invalidar();
  return { ...estadoDe(sitio, id), avisos };
}

function contentUpdate(sitio, args, motor) {
  const c = editable(sitio, args.id);
  const col = c.col;
  const campos = col.campos;
  const datos = structuredClone(c.datos);
  let cuerpo = c.cuerpo;
  const anterior = {};
  const avisos = [];
  const zona = sitio.config.zona;

  // Primero, todo lo que puede decir «no»: capacidades y estado.
  if (args.extracto !== undefined) campoObligatorio(col, "extracto", "contenido.extracto");
  if (args.fecha !== undefined) campoObligatorio(col, "fecha", "contenido.fecha");
  if (args.schema !== undefined) campoObligatorio(col, "schema", "seo.schema");
  const estado = args.estado ?? c.estado;
  if (args.estado !== undefined) {
    comprobarEstado(col, args.estado);
    if (args.estado === "future") {
      const f = args.fecha ?? motor.programados.fecha(c.id);
      if (!f) throw new ErrorVerbo("tranquiseo_argumento_invalido", "Para programar hace falta la fecha.");
      if (f <= hoyUtc(sitio)) throw new ErrorVerbo("tranquiseo_argumento_invalido", "La fecha de un programado tiene que ser futura.");
    }
  }

  let cambiaTexto = false;
  if (args.titulo !== undefined) {
    anterior.titulo = String(c.datos[campos.titulo] ?? "");
    datos[campos.titulo] = args.titulo;
    cambiaTexto = true;
  }
  if (args.contenido !== undefined) {
    const perdidos = incrustadosPerdidos(c.cuerpo, args.contenido);
    if (perdidos.length > 0) {
      throw new ErrorVerbo("tranquiseo_no_disponible", "Esta entrada tiene vídeos o elementos incrustados que el conector no puede volver a escribir: no se toca su contenido.", {
        capacidad: "contenido_con_incrustados", motivo: "incrustados_no_reescribibles", remedio: "Cambia el texto a mano en el fichero, o pide solo cambios de título, extracto o SEO.", etiquetas: perdidos,
      });
    }
    anterior.contenido = cuerpoComoHtml(c.cuerpo);
    cuerpo = args.contenido;
    cambiaTexto = true;
  }
  if (args.extracto !== undefined) {
    anterior.extracto = String(c.datos[campos.extracto] ?? "");
    const plano = textoPlano(args.extracto);
    if (plano === "") delete datos[campos.extracto];
    else datos[campos.extracto] = plano;
    cambiaTexto = true;
  }
  if (args.fecha !== undefined) {
    anterior.fecha = sitio.fechaPublicado(c);
    datos[campos.fecha] = diaLocal(args.fecha, zona);
  }
  if (args.estado !== undefined) {
    anterior.estado = c.estado;
    marcarBorrador(col, datos, estado);
  }
  if (args.schema !== undefined) {
    anterior.schema = typeof c.datos[campos.schema] === "string" ? c.datos[campos.schema] : "";
    if (args.schema === "") delete datos[campos.schema];
    else datos[campos.schema] = args.schema;
  }
  for (const arg of ["categorias", "etiquetas"]) {
    if (args[arg] === undefined) continue;
    const t = nombresDeTerminos(sitio, col, arg, args[arg], avisos);
    if (!t) continue;
    const previos = Array.isArray(c.datos[t.campo]) ? c.datos[t.campo].filter((x) => typeof x === "string") : [];
    anterior[arg] = previos.map((n) => terminoId(sitio, arg === "etiquetas" ? "post_tag" : "category", n));
    if (t.nombres.length === 0) delete datos[t.campo];
    else datos[t.campo] = t.nombres;
  }
  if (args.destacada !== undefined) {
    const img = imagenDestacada(sitio, col, args.destacada, avisos);
    if (img) {
      anterior.destacada = c.destacada ?? 0;
      if (img.valor === undefined) delete datos[img.campo];
      else datos[img.campo] = img.valor;
    }
  }

  if (Object.keys(anterior).length === 0) return { ...estadoDe(sitio, c.id), anterior, avisos };

  if (cambiaTexto && campos.actualizado) datos[campos.actualizado] = diaLocal(hoyUtc(sitio), zona);
  aplicarDerivados(col, datos, { titulo: String(datos[campos.titulo] ?? ""), extracto: String(datos[campos.extracto] ?? ""), fecha: datos[campos.fecha] });
  validarReglas(col, datos);
  const texto = componerMd(c.yaml, datos, cuerpo);

  const destino = join(dirname(c.abs), nombreFichero(col, c.slug, estado));
  const ruta = sitio.rutaRepo(destino);
  // El cuerpo anterior ya está en git: en el registro solo va el frontmatter (repos públicos, spec §12).
  const { contenido: _cuerpo, ...anteriorRegistro } = anterior;
  anotar(motor, { verbo: "content.update", id: c.id, ruta, anterior: { ...anteriorRegistro, frontmatter: c.datos }, nuevo: { frontmatter: datos, estado } });
  if (destino !== c.abs) {
    crearFichero(sitio, destino, texto);
    unlinkSync(c.abs);
  } else {
    reescribirFichero(sitio, c.abs, texto);
  }
  sitio.ids.actualizar(c.id, { ruta, estado: estado === "publish" ? undefined : estado });
  if (estado === "future") motor.programados.fijar(c.id, args.fecha ?? motor.programados.fecha(c.id));
  else motor.programados.quitar(c.id);
  sitio.invalidar();
  return { ...estadoDe(sitio, c.id), anterior, avisos };
}

function seoUpdate(sitio, args, motor) {
  const c = editable(sitio, args.id);
  const { id: _id, ...cambios } = args;
  if (Object.keys(cambios).length === 0) throw new ErrorVerbo("tranquiseo_sin_cambio", "No se ha mandado ningún campo SEO.");
  // Un campo que la web no tiene: no se escribe nada, ni lo demás (spec §3).
  const destino = {};
  for (const k of Object.keys(cambios)) destino[k] = campoObligatorio(c.col, SEO_A_CAMPO[k], `seo.${k}`);

  const antes = seoDe(c);
  const datos = structuredClone(c.datos);
  for (const [k, v] of Object.entries(cambios)) {
    if (v === "" || (Array.isArray(v) && v.length === 0)) delete datos[destino[k]];
    else datos[destino[k]] = v;
  }
  validarReglas(c.col, datos);
  const texto = componerMd(c.yaml, datos, c.cuerpo);
  const elegir = (o) => Object.fromEntries(Object.keys(cambios).map((k) => [k, o[k]]));
  anotar(motor, { verbo: "seo.update", id: c.id, ruta: c.ruta, anterior: elegir(antes), nuevo: cambios });
  reescribirFichero(sitio, c.abs, texto);
  sitio.invalidar();
  return { id: c.id, plugin: "astro-frontmatter", anterior: elegir(antes), nuevo: elegir(seoDe(sitio.contenido(c.id))) };
}

function contentUpdateSlug(sitio, args, motor) {
  const c = editable(sitio, args.id);
  const col = c.col;
  const slugNuevo = slugExplicito(args.slug);
  if (slugNuevo === c.slug) throw new ErrorVerbo("tranquiseo_sin_cambio", "El contenido ya tiene ese slug.");
  // Ocupado se mira como si fuera a publicarse (cualquiera de las dos variantes del fichero).
  if (rutaOcupada(sitio, col, slugNuevo, c.id)) throw new ErrorVerbo("tranquiseo_slug_ocupado", "Ya hay otro contenido con ese slug.");

  const publicado = c.estado === "publish";
  const conRedirect = publicado ? true : args.redireccion;
  const urlAnterior = c.url;
  const origen = rutaDeUrl(sitio, urlAnterior);
  const urlNueva = sitio.urlDe(col, slugNuevo);
  if (conRedirect) {
    const cap = capRedirecciones(sitio);
    if (!cap.escribible) {
      // Nunca se mueve una URL publicada sin su redirección.
      throw noDisponible("redirecciones", cap.motivo, "Este sitio no puede gestionar redirecciones ahora mismo.",
        REMEDIOS_REDIRECCIONES[cap.motivo] ?? "Escríbenos y lo miramos.");
    }
    if (origen === "") throw new ErrorVerbo("tranquiseo_redireccion_invalida", "Este contenido es la portada: no se le cambia la URL.");
    const problema = comprobarRedireccion(sitio, origen, urlNueva, { excepto: c.id });
    if (problema) throw problema;
  }

  const destino = join(dirname(c.abs), nombreFichero(col, slugNuevo, c.estado));
  const ruta = sitio.rutaRepo(destino);
  anotar(motor, { verbo: "content.updateSlug", id: c.id, ruta, anterior: { slug: c.slug, ruta: c.ruta }, nuevo: { slug: slugNuevo, ruta } });
  moverFichero(sitio, c.abs, destino);
  sitio.ids.actualizar(c.id, { ruta });
  let redireccionId = null;
  if (conRedirect) {
    try {
      redireccionId = crearRegla(sitio, origen, urlNueva, 301);
    } catch (e) {
      moverFichero(sitio, destino, c.abs);
      sitio.ids.actualizar(c.id, { ruta: c.ruta });
      sitio.invalidar();
      throw new ErrorVerbo("tranquiseo_redireccion_fallida", "No se ha podido crear la redirección: el slug se ha dejado como estaba.", { detalle: e?.constructor?.name ?? "Error" });
    }
    anotar(motor, { verbo: "content.updateSlug", id: redireccionId, ruta: sitio.config.redirecciones, anterior: null, nuevo: { origen, destino: urlNueva, proveedor: "nuestro" } });
  }
  sitio.invalidar();
  return { id: c.id, slug_anterior: c.slug, slug: slugNuevo, url_anterior: urlAnterior, url: urlNueva, redireccion_id: redireccionId, confirmado: false };
}

const MAX_RESTAURAR = 4 * 1024 * 1024;

function revisionsRestore(sitio, args, motor) {
  const c = contenidoExistente(sitio, args.id);
  const candidatos = [...rutasEnHistoria(sitio.raizRepo, c.ruta).entries()].filter(([sha]) => idDeCommit(sha) === args.revision_id);
  if (candidatos.length === 0) throw new ErrorVerbo("tranquiseo_no_encontrado", "Esa revisión no es de este contenido.");
  if (candidatos.length > 1) throw new ErrorVerbo("tranquiseo_argumento_invalido", "Ese identificador de revisión casa con más de un commit.");
  const [sha, rutaEntonces] = candidatos[0];
  const texto = ficheroEnCommit(sitio.raizRepo, sha, rutaEntonces);
  if (texto === null) throw new ErrorVerbo("tranquiseo_no_encontrado", "Esa revisión no tiene este fichero.");
  if (Buffer.byteLength(texto, "utf8") > MAX_RESTAURAR) throw new ErrorVerbo("tranquiseo_argumento_invalido", "Esa revisión es demasiado grande para restaurarla.");
  const vuelta = leerMd(texto);
  if (!vuelta.estandar) {
    throw noDisponible("contenido", vuelta.motivo ?? "frontmatter_no_estandar", "Esa revisión tiene un frontmatter que no sabemos reescribir sin riesgo.",
      "Restaurarla a mano desde git.");
  }
  // Lo restaurado pasa por las mismas reglas que cualquier escritura.
  validarReglas(c.col, vuelta.datos);
  const anteriorTexto = readFileSync(c.abs, "utf8");
  if (anteriorTexto === texto) throw new ErrorVerbo("tranquiseo_sin_cambio", "El contenido ya está como en esa revisión.");
  // En el registro, solo el frontmatter (el cuerpo anterior ya está en git: spec §12).
  anotar(motor, { verbo: "revisions.restore", id: c.id, ruta: c.ruta, anterior: { frontmatter: c.datos }, nuevo: { revision_id: args.revision_id, commit: sha } });
  reescribirFichero(sitio, c.abs, texto);
  sitio.invalidar();
  return { ...estadoDe(sitio, c.id), revision_id: args.revision_id, cubre_post_meta: true, anterior: { titulo: String(c.datos[c.col.campos.titulo] ?? ""), contenido: cuerpoComoHtml(c.cuerpo), frontmatter: c.datos } };
}
