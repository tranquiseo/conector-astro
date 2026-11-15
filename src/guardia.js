// Guardia de rutas (spec §9 paso 6): se mira el diff REAL del árbol de trabajo, no lo que los
// verbos dicen que han tocado. Cada ruta cambiada tiene que caer dentro de `rutas_permitidas`
// y fuera de la lista fija de prohibidas (`PROHIBIDAS`), diga lo que diga la config.
//
// `rutas_permitidas` son relativas a la raíz del proyecto Astro (`raiz`), como `dir` y `media.dir`;
// la excepción es `.tranquiseo/`, que vive en la raíz del REPO y siempre está permitida (es el
// estado del conector). Con `raiz: "."` las dos cosas coinciden.

import { lstatSync } from "node:fs";
import { posix } from "node:path";
import { git } from "./util/git.js";
import { PROHIBIDAS } from "./config.js";
import { CARPETA } from "./estado/almacen.js";

/**
 * Rutas cambiadas respecto a HEAD (también las nuevas sin seguimiento, y las dos de un renombre).
 * @returns {string[]} rutas relativas al repo, con `/`
 */
export function rutasCambiadas(raizRepo) {
  const salida = git(raizRepo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
  const rutas = [];
  const trozos = salida.split("\0");
  for (let i = 0; i < trozos.length; i++) {
    const t = trozos[i];
    if (t.length < 4) continue;
    rutas.push(t.slice(3));
    // Con renombres activados vendría «R  nueva\0vieja»; con --no-renames no, pero por si acaso:
    if (t[0] === "R" || t[0] === "C") rutas.push(trozos[++i]);
  }
  return [...new Set(rutas)].sort();
}

/** Prefijos permitidos, relativos al repo. */
export function prefijosPermitidos(config) {
  const raiz = config.raiz === "." ? "" : config.raiz.replace(/\/+$/, "") + "/";
  const prefijos = config.rutasPermitidas
    .map((r) => (r.startsWith(CARPETA + "/") ? r : posix.normalize(raiz + r)))
    .map((r) => (r.endsWith("/") ? r : r + "/"));
  return [...new Set([CARPETA + "/", ...prefijos])];
}

/**
 * Comprueba una lista de rutas. Devuelve las que no pasan, con el motivo.
 * @returns {{ruta: string, motivo: string}[]}
 */
export function rutasProhibidas(raizRepo, config, rutas) {
  const prefijos = prefijosPermitidos(config);
  const malas = [];
  for (const ruta of rutas) {
    if (ruta.includes("\\") || ruta.split("/").includes("..") || ruta.startsWith("/")) {
      malas.push({ ruta, motivo: "ruta_rara" });
      continue;
    }
    // `.tranquiseo/` solo admite nuestros ficheros de estado (JSON/JSONL con nombre fijo).
    if (ruta.startsWith(CARPETA + "/")) {
      if (!/^\.tranquiseo\/[a-z0-9-]+\.(json|jsonl)$/.test(ruta)) malas.push({ ruta, motivo: "estado_desconocido" });
      else if (esEnlace(raizRepo, ruta)) malas.push({ ruta, motivo: "enlace_simbolico" });
      continue;
    }
    if (PROHIBIDAS.some((re) => re.test(ruta))) {
      malas.push({ ruta, motivo: "prohibida" });
      continue;
    }
    if (!prefijos.some((p) => ruta.startsWith(p))) {
      malas.push({ ruta, motivo: "fuera_de_rutas_permitidas" });
      continue;
    }
    if (esEnlace(raizRepo, ruta)) malas.push({ ruta, motivo: "enlace_simbolico" });
  }
  return malas;
}

function esEnlace(raizRepo, ruta) {
  try {
    return lstatSync(posix.join(raizRepo, ruta)).isSymbolicLink();
  } catch {
    return false; // borrado
  }
}
