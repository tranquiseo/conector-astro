// Build obligatorio (spec §9 paso 7) y revisión del HTML generado (§7.1 y §7.4).
//
// El build corre con un entorno MÍNIMO y explícito: sin la clave del sitio, sin GITHUB_TOKEN y sin
// nada de ACTIONS_*. Así un `postinstall` de una dependencia no puede leer el secreto ni empujar.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parseDocument } from "htmlparser2";
import { selectAll } from "css-select";
import { textContent } from "domutils";
import { createHash } from "node:crypto";
import { rutaDeUrl } from "./verbos/lectura.js";

export const TOPE_BUILD_MS = 15 * 60 * 1000;
const MAX_LOG = 2048;
const VARIABLES = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT"];

/** Entorno del build: lo justo. Nunca la clave del sitio ni tokens. */
export function entornoMinimo(origen = process.env) {
  const e = { CI: "true", NODE_ENV: "production", ASTRO_TELEMETRY_DISABLED: "1" };
  for (const k of VARIABLES) if (typeof origen[k] === "string") e[k] = origen[k];
  return e;
}

/** Como `estado.actualizacion.mensaje` del plugin: rutas → [ruta], URLs → [url], nada que parezca credencial. */
export function filtrarLog(texto) {
  const limpio = String(texto)
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/(?:\/[\w.@+-]+){2,}\/?/g, "[ruta]")
    .replace(/[A-Za-z]:\\[^\s]+/g, "[ruta]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[credencial]")
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}/g, "[credencial]")
    .replace(/(token|clave|password|secret|key)\s*[=:]\s*\S+/gi, "$1=[credencial]")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, "");
  const bytes = Buffer.from(limpio, "utf8");
  return bytes.length <= MAX_LOG ? limpio : bytes.subarray(bytes.length - MAX_LOG).toString("utf8").replace(/^[^\n]*\n/, "");
}

/** Ejecuta un argv con tope de tiempo. Nunca shell. */
export function ejecutar(argv, { cwd, env, tope = TOPE_BUILD_MS } = {}) {
  return new Promise((ok) => {
    let salida = "";
    // Grupo de procesos propio (segunda pasada Fable, 2): al acabar se mata el grupo entero, para que
    // un nieto en segundo plano no siga escribiendo en `.git` mientras el conector empuja. Un
    // `setsid` lo esquiva: el cierre de verdad son los jobs separados (decisión 25).
    const hijo = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const matarGrupo = () => {
      try {
        if (hijo.pid) process.kill(-hijo.pid, "SIGKILL");
      } catch { /* ya no existe */ }
    };
    const guardar = (t) => {
      salida += t.toString("utf8");
      if (salida.length > 200000) salida = salida.slice(-100000);
    };
    hijo.stdout.on("data", guardar);
    hijo.stderr.on("data", guardar);
    const reloj = setTimeout(() => {
      salida += "\n[tiempo agotado]";
      matarGrupo();
    }, tope);
    hijo.on("error", (e) => {
      clearTimeout(reloj);
      ok({ codigo: -1, salida: salida + `\n${e.code ?? "error"}` });
    });
    hijo.on("close", (codigo) => {
      clearTimeout(reloj);
      matarGrupo();
      ok({ codigo: codigo ?? -1, salida });
    });
  });
}

/**
 * `instalar` (si no hay node_modules) y `build`, en la raíz del proyecto Astro.
 * @returns {Promise<{ok: boolean, log: string, paso?: string}>}
 */
export async function compilar(sitio, { env = entornoMinimo(), tope = TOPE_BUILD_MS } = {}) {
  const cwd = sitio.raizAstro;
  if (!existsSync(join(cwd, "node_modules"))) {
    const r = await ejecutar(sitio.config.instalar, { cwd, env, tope });
    if (r.codigo !== 0) return { ok: false, paso: "instalar", log: filtrarLog(r.salida) };
  }
  const r = await ejecutar(sitio.config.build, { cwd, env, tope });
  if (r.codigo !== 0) return { ok: false, paso: "build", log: filtrarLog(r.salida) };
  return { ok: true, log: "" };
}

/** Fichero HTML de una URL del sitio dentro de `dist` (`/blog/x/` → `dist/blog/x/index.html`). */
export function htmlDeUrl(sitio, url) {
  const dist = resolve(sitio.raizAstro, sitio.config.dist);
  const ruta = rutaDeUrl(sitio, url);
  if (ruta === null) return null;
  const candidatos = ruta === "" ? [join(dist, "index.html")] : [join(dist, ruta, "index.html"), join(dist, ruta + ".html")];
  for (const c of candidatos) if (c.startsWith(dist + sep) && existsSync(c) && lstatSync(c).isFile()) return c;
  return null;
}

const ESQUEMA_PELIGROSO = /^\s*(javascript|data|vbscript):/i;

/** Problemas de seguridad dentro del selector de contenido de un HTML (spec §7.1, comprobación posterior). */
export function problemasHtml(html, selector) {
  const doc = parseDocument(html);
  let zonas;
  try {
    zonas = selectAll(selector, doc);
  } catch {
    return ["selector_invalido"];
  }
  if (zonas.length === 0) return ["selector_sin_contenido"];
  const problemas = new Set();
  const recorrer = (n) => {
    if (n.type === "script") {
      const tipo = String(n.attribs?.type ?? "").toLowerCase();
      if (tipo !== "application/ld+json") problemas.add("script");
    }
    if (n.attribs) {
      for (const [k, v] of Object.entries(n.attribs)) {
        if (/^on/i.test(k)) problemas.add("atributo_on");
        if (["href", "src", "action", "formaction", "xlink:href", "srcset"].includes(k.toLowerCase()) && ESQUEMA_PELIGROSO.test(String(v).replace(/[\u0000- ]/g, ""))) {
          problemas.add("url_peligrosa");
        }
      }
    }
    // iframes/embeds no se miran aquí: nuestro saneado no los deja escribir, y un vídeo que el
    // cliente puso a mano en su .md bloquearía para siempre cualquier cambio de esa entrada.
    for (const h of n.children ?? []) recorrer(h);
  };
  for (const z of zonas) recorrer(z);
  return [...problemas];
}

/** Huella del texto visible dentro del selector: lo que la espera compara con la web servida. */
export function huellaContenido(html, selector) {
  const doc = parseDocument(html);
  let zonas;
  try {
    zonas = selectAll(selector, doc);
  } catch {
    return null;
  }
  if (zonas.length === 0) return null;
  const texto = zonas.map((z) => textContent(z)).join(" ").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(texto).digest("hex");
}

function* ficherosDe(dir, prof = 0) {
  if (prof > 12 || !existsSync(dir)) return;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) yield* ficherosDe(p, prof + 1);
    else if (/\.(xml|txt)$/.test(n)) yield p;
  }
}

/**
 * Revisión tras el build:
 *  - cada entrada publicada tocada: su HTML existe y no lleva nada inseguro dentro del selector;
 *  - ninguna entrada no publicada (borrador, programado…) existe en dist ni sale en un sitemap.
 * @param {number[]} tocadas ids de contenido escritos en esta ejecución
 * @returns {{ok: true} | {ok: false, motivo: string, id: number, detalle: string[]}}
 */
export function revisarDist(sitio, tocadas) {
  const { contenidos } = sitio.cargar();
  const selector = sitio.config.selectorContenido;
  for (const c of contenidos) {
    if (!tocadas.includes(c.id) || c.estado !== "publish") continue;
    const f = htmlDeUrl(sitio, c.url);
    if (!f) return { ok: false, motivo: "entrada_no_generada", id: c.id, detalle: [] };
    const p = problemasHtml(readFileSync(f, "utf8"), selector);
    if (p.length > 0) return { ok: false, motivo: "html_inseguro_tras_build", id: c.id, detalle: p };
  }
  const dist = resolve(sitio.raizAstro, sitio.config.dist);
  const mapas = [...ficherosDe(dist)].map((f) => readFileSync(f, "utf8"));
  for (const c of contenidos) {
    if (c.estado === "publish") continue;
    if (htmlDeUrl(sitio, c.url)) return { ok: false, motivo: "borrador_publicado", id: c.id, detalle: ["html"] };
    const ruta = rutaDeUrl(sitio, c.url);
    if (ruta && mapas.some((m) => m.includes(`/${ruta}/<`) || m.includes(`/${ruta}<`))) return { ok: false, motivo: "borrador_publicado", id: c.id, detalle: ["sitemap"] };
  }
  return { ok: true };
}
