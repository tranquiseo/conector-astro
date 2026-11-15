// `site.capabilities` en Astro (spec §6): mismas claves que `Capacidades/Escaneo.php` donde
// tienen sentido, más `plataforma`, `verbos`, `no_disponibles` y `selector_contenido`.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { VERSION_CONECTOR } from "./sitio.js";

export const NO_DISPONIBLES = Object.freeze({
  "term.update": {
    motivo: "sin_sitio_para_descripciones",
    remedio: "En una web Astro la descripción de una etiqueta no tiene sitio estándar: habría que declarar en tranquiseo.config.json un fichero de datos de términos (versión futura del conector).",
  },
});

export const REMEDIOS_REDIRECCIONES = Object.freeze({
  sitio_no_lee_nuestras_redirecciones: "Hacer que la web lea .tranquiseo/redirecciones.json al compilar y marcar «redirecciones_leidas»: true en tranquiseo.config.json.",
});

export const ENTREGA_CONTROLADA = Object.freeze({
  motivo: "entrega_controlada",
  remedio: "Esta web está en entrega controlada: no se escribe nada sin el visto bueno de su responsable. Para permitir los cambios, quitar «escrituras»: false de tranquiseo.config.json.",
});

export function versionAstro(sitio) {
  for (const ruta of [join(sitio.raizAstro, "node_modules", "astro", "package.json"), join(sitio.raizRepo, "node_modules", "astro", "package.json")]) {
    if (!existsSync(ruta)) continue;
    try {
      const v = JSON.parse(readFileSync(ruta, "utf8")).version;
      if (typeof v === "string" && /^[0-9][0-9A-Za-z.+-]{0,40}$/.test(v)) return v;
    } catch {
      // sigue con la siguiente
    }
  }
  return null;
}

export function redirecciones(sitio) {
  const c = sitio.config;
  const escribible = Boolean(c.redirecciones) && c.redireccionesLeidas === true;
  return { proveedor: "nuestro", escribible, motivo: escribible ? null : "sitio_no_lee_nuestras_redirecciones", confirmado: false };
}

/**
 * @param {import('./sitio.js').Sitio} sitio
 * @param {string[]} verbos verbos del catálogo
 */
export function capacidades(sitio, verbos, escrituras = []) {
  const c = sitio.config;
  const bloqueados = c.escrituras === false ? escrituras : [];
  const noDisponibles = {
    ...structuredClone(NO_DISPONIBLES),
    ...Object.fromEntries(bloqueados.map((v) => [v, { ...ENTREGA_CONTROLADA }])),
  };
  const mapeado = (k) => Object.values(c.colecciones).some((col) => col.campos[k] !== null);
  return {
    plataforma: "astro",
    astro: { version: versionAstro(sitio), salida: "static", home_url: c.homeUrl, urls_limpias: true },
    seo: {
      plugin: "astro-frontmatter", version: null, premium: null, modulos: c.sitemap ? ["sitemap"] : [],
      asistente_terminado: true, meta_en_post_meta: true,
      campos: {
        titulo: mapeado("seo_titulo"), descripcion: mapeado("seo_descripcion"), canonical: mapeado("canonical"),
        robots: mapeado("robots"), palabra_clave: mapeado("palabra_clave"), schema: mapeado("schema"),
      },
    },
    redirecciones: redirecciones(sitio),
    cache: { plugin: "ninguno", purga_disponible: false, borde_desconocida: true },
    constructores: { secuestran_contenido: [], compatibles: [] },
    revisiones: { activas: true, limite: null, cubren_post_meta: true },
    borradores: Object.fromEntries(Object.entries(c.colecciones).map(([t, col]) => [t, col.borradores ? col.borradores.modo : null])),
    crear: Object.fromEntries(Object.entries(c.colecciones).map(([t, col]) => [t, col.crear])),
    programados: { precision_s: c.intervalo },
    verbos: verbos.filter((v) => !Object.hasOwn(noDisponibles, v)),
    no_disponibles: noDisponibles,
    entrega_controlada: c.escrituras === false,
    selector_contenido: c.selectorContenido,
    intervalo: c.intervalo,
    permalinks: Object.fromEntries(Object.entries(c.colecciones).map(([t, col]) => [t, col.url])),
    escaneado_en: Math.floor(sitio.ahora() / 1000),
    plugin: VERSION_CONECTOR,
  };
}
