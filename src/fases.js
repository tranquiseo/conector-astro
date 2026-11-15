// Jobs separados (J9, decisión 25): el build del cliente nunca comparte máquina con la clave del sitio.
//
//   A «aplicar»  (clave + token, SIN código del cliente): consulta, verifica, aplica las órdenes y, si
//                hace falta compilar, deja un PARCHE (`parche.json`) y publica su sha256 como output.
//   B «compilar» (sin secretos): checkout del SHA base, aplica el parche, `npm ci` y build del cliente.
//                De B solo cuenta si el job acaba bien o mal; nada de lo que produzca lo lee C.
//   C «publicar» (clave + token, SIN código del cliente): checkout limpio del SHA base, comprueba el
//                parche contra el hash de A, lo vuelve a pasar por la guardia, commit, push, despliegue,
//                espera y resultado firmado. Si B falló, firma el fallo del lote y guarda el estado.
//
// Este módulo es la parte de B y C, más el formato del parche. A es `ejecutarCiclo` con `fase: "aplicar"`.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, lstatSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cargarConfig, PROHIBIDAS } from "./config.js";
import { Sitio } from "./sitio.js";
import { rutasCambiadas, rutasProhibidas } from "./guardia.js";
import { compilar, revisarDist, entornoMinimo, huellaContenido } from "./build.js";
import { git, gitR, configLocalInsegura, rutaGit } from "./util/git.js";
import { enviar, ErrorDeRed, URL_BASE } from "./transporte.js";
import { Almacen } from "./estado/almacen.js";
import { rutaDeParcheValida, TOPE_PARCHE } from "./parche-reglas.js";
import {
  ErrorDeLote, AUTOR, entornoPush, motivoPush, dispararDespliegue, esperarPublicacion, mensajeDeLote, avisar,
} from "./ciclo.js";

export const NOMBRE_PARCHE = "parche.json";
export const VERSION_PARCHE = 1;
const TIPOS = new Set(["ordenes", "programados"]);

export class ErrorDeParche extends Error {
  constructor(motivo) {
    super(motivo);
    this.motivo = motivo;
  }
}

/**
 * Escribe el parche de la fase aplicar en `dir` y devuelve su sha256 (el output de A).
 * @returns {{hash: string, ruta: string}}
 */
export function escribirParche(dir, parche) {
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from(JSON.stringify({ version: VERSION_PARCHE, ...parche }), "utf8");
  const ruta = join(dir, NOMBRE_PARCHE);
  writeFileSync(ruta, bytes, { mode: 0o600 });
  return { hash: createHash("sha256").update(bytes).digest("hex"), ruta };
}

export { rutaDeParcheValida };

function validarLista(lista, nombre) {
  if (!Array.isArray(lista) || lista.length > 5000) throw new ErrorDeParche(`${nombre}_invalido`);
  const vistas = new Set();
  for (const c of lista) {
    if (!c || typeof c !== "object" || Object.keys(c).some((k) => k !== "ruta" && k !== "contenido")) throw new ErrorDeParche(`${nombre}_invalido`);
    if (!rutaDeParcheValida(c.ruta) || vistas.has(c.ruta)) throw new ErrorDeParche("ruta_invalida");
    vistas.add(c.ruta);
    if (c.contenido !== null && (typeof c.contenido !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(c.contenido))) throw new ErrorDeParche(`${nombre}_invalido`);
  }
}

/**
 * Lee el parche y lo comprueba contra el hash que publicó A (nunca contra nada de B).
 * @returns {object}
 */
export function leerParche(dir, hashEsperado) {
  if (typeof hashEsperado !== "string" || !/^[0-9a-f]{64}$/.test(hashEsperado)) throw new ErrorDeParche("hash_ausente");
  const ruta = join(dir, NOMBRE_PARCHE);
  const st = lstatSync(ruta, { throwIfNoEntry: false });
  if (!st || !st.isFile()) throw new ErrorDeParche("parche_ausente");
  if (st.size > TOPE_PARCHE) throw new ErrorDeParche("parche_demasiado_grande");
  const bytes = readFileSync(ruta);
  if (createHash("sha256").update(bytes).digest("hex") !== hashEsperado) throw new ErrorDeParche("hash_distinto");
  let p;
  try {
    p = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ErrorDeParche("parche_ilegible");
  }
  if (!p || p.version !== VERSION_PARCHE || !TIPOS.has(p.tipo)) throw new ErrorDeParche("parche_desconocido");
  if (typeof p.base !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(p.base)) throw new ErrorDeParche("base_invalida");
  if (typeof p.mensaje !== "string" || typeof p.mensajeSiFalla !== "string") throw new ErrorDeParche("mensaje_invalido");
  validarLista(p.cambios, "cambios");
  validarLista(p.siFalla, "si_falla");
  if (p.cambios.length === 0) throw new ErrorDeParche("parche_vacio");
  if (!Array.isArray(p.tocadas) || !p.tocadas.every((i) => Number.isInteger(i) && i > 0)) throw new ErrorDeParche("tocadas_invalidas");
  if (p.tipo === "ordenes") {
    if (!p.cuerpo || !Array.isArray(p.cuerpo.resultados) || typeof p.cuerpo.control !== "object" || p.cuerpo.control === null) throw new ErrorDeParche("cuerpo_invalido");
    if (!Array.isArray(p.escritas) || !p.escritas.every((i) => Number.isInteger(i) && i >= 0 && i < p.cuerpo.resultados.length)) throw new ErrorDeParche("escritas_invalidas");
  } else if (!Array.isArray(p.publicados) || !Array.isArray(p.avisosSiFalla)) throw new ErrorDeParche("programados_invalidos");
  if (p.intento !== undefined && (typeof p.intento !== "string" || !/^\d{1,5}$/.test(p.intento))) throw new ErrorDeParche("intento_invalido");
  return p;
}

/** La guardia de rutas sobre la lista del parche, ANTES de escribir nada en disco. */
function guardiaPrevia(raizRepo, config, lista) {
  const rutas = lista.map((c) => c.ruta);
  if (rutasProhibidas(raizRepo, config, rutas).length > 0) throw new ErrorDeParche("ruta_prohibida");
  if (rutas.some((r) => PROHIBIDAS.some((re) => re.test(r)))) throw new ErrorDeParche("ruta_prohibida");
}

/**
 * Escribe la lista sobre el árbol sin seguir enlaces: ningún directorio intermedio puede ser un enlace
 * simbólico (un repo con `src/content/blog -> /home/runner/.ssh` no saca la escritura fuera).
 */
export function aplicarLista(raizRepo, lista) {
  for (const c of lista) {
    const seg = c.ruta.split("/");
    let actual = raizRepo;
    for (const s of seg.slice(0, -1)) {
      actual = join(actual, s);
      const st = lstatSync(actual, { throwIfNoEntry: false });
      if (!st) mkdirSync(actual);
      else if (!st.isDirectory() || st.isSymbolicLink()) throw new ErrorDeParche("ruta_con_enlace");
    }
    const destino = join(raizRepo, c.ruta);
    const st = lstatSync(destino, { throwIfNoEntry: false });
    if (st && !st.isFile()) throw new ErrorDeParche("destino_no_es_fichero");
    if (c.contenido === null) {
      if (st) unlinkSync(destino);
    } else {
      writeFileSync(destino, Buffer.from(c.contenido, "base64"));
    }
  }
}

/**
 * Aplica una lista del parche y comprueba que el árbol cambia EXACTAMENTE en esas rutas y que la
 * guardia las da por buenas. Deshace y lanza ErrorDeParche si no.
 */
function aplicarYComprobar(raizRepo, config, lista, deshacer, { exacto = true } = {}) {
  guardiaPrevia(raizRepo, config, lista);
  try {
    aplicarLista(raizRepo, lista);
    const esperadas = lista.map((c) => c.ruta).sort();
    const reales = rutasCambiadas(raizRepo);
    // `exacto: false` (estado sobre una cabeza nueva): lo que ya estaba igual no aparece como cambio.
    const cuadra = exacto ? reales.join("\0") === esperadas.join("\0") : reales.every((r) => esperadas.includes(r));
    if (!cuadra) throw new ErrorDeParche("parche_incoherente");
    if (rutasProhibidas(raizRepo, config, reales).length > 0) throw new ErrorDeParche("ruta_prohibida");
    return reales;
  } catch (err) {
    deshacer();
    throw err;
  }
}

/** Comprobaciones comunes de B y C sobre el checkout: git fijado, config local sana, HEAD = base, árbol limpio. */
function prepararCheckout(raizRepo, parche) {
  rutaGit();
  if (configLocalInsegura(raizRepo).length > 0) throw new ErrorDeParche("git_config_insegura");
  let cabeza = null;
  try {
    cabeza = git(raizRepo, ["rev-parse", "HEAD"]).trim();
  } catch { /* sin repo */ }
  if (cabeza !== parche.base) throw new ErrorDeParche("base_distinta");
  if (rutasCambiadas(raizRepo).length > 0) throw new ErrorDeParche("arbol_sucio");
  return () => {
    gitR(raizRepo, ["reset", "-q", "--hard", parche.base]);
    gitR(raizRepo, ["clean", "-fdq"]);
  };
}

/**
 * Job B. Sin secretos: aplica el parche, instala y compila la web, y revisa `dist`.
 * @returns {Promise<{estado: string, motivo?: string, log?: string}>} estado "ok" o un fallo
 */
export async function faseCompilar({ raizRepo, dirParche, hash, log = (l) => process.stdout.write(l + "\n"), envBuild }) {
  const config = cargarConfig(raizRepo);
  let parche;
  try {
    parche = leerParche(dirParche, hash);
    const deshacer = prepararCheckout(raizRepo, parche);
    aplicarYComprobar(raizRepo, config, parche.cambios, deshacer);
  } catch (err) {
    if (!(err instanceof ErrorDeParche)) throw err;
    log(`::error::tranquiseo: el parche no se puede aplicar (${err.motivo}).`);
    return { estado: "parche_invalido", motivo: err.motivo };
  }
  const sitio = new Sitio(raizRepo, { config });
  const b = await compilar(sitio, { env: envBuild ?? entornoMinimo() });
  if (!b.ok) {
    log(`::error::tranquiseo: la web no compila con estos cambios (${b.paso}). ${b.log}`);
    return { estado: "build_fallido", motivo: b.paso === "instalar" ? "instalar_fallido" : "build_fallido", log: b.log };
  }
  sitio.invalidar();
  const revision = revisarDist(sitio, parche.tocadas);
  if (!revision.ok) {
    log(`::error::tranquiseo: la revisión del HTML generado ha fallado (${revision.motivo}, entrada ${revision.id}).`);
    return { estado: "build_fallido", motivo: revision.motivo };
  }
  log("tranquiseo: compilado.");
  return { estado: "ok" };
}

/**
 * Commit (sin build: aquí nunca se ejecuta nada del cliente) y push a la rama principal. Solo de las
 * rutas comprobadas (J10, Fable 3): si a estas alturas el árbol ha cambiado en otra cosa, no se sube.
 */
function confirmarYSubir({ raizRepo, rama, mensaje, token, remoto, rutas }) {
  if (rutasCambiadas(raizRepo).join("\0") !== [...rutas].sort().join("\0") || rutas.length === 0) throw new ErrorDeLote("tranquiseo_push_fallido", "arbol_inesperado");
  let r = gitR(raizRepo, ["add", "-A", "--", ...rutas]);
  if (r.codigo === 0) r = gitR(raizRepo, [...AUTOR, "commit", "-q", "--no-verify", "-m", mensaje]);
  if (r.codigo !== 0) throw new ErrorDeLote("tranquiseo_push_fallido", "commit_fallido");
  const sha = git(raizRepo, ["rev-parse", "HEAD"]).trim();
  const p = gitR(raizRepo, ["push", "--porcelain", remoto, `HEAD:refs/heads/${rama}`], { extra: entornoPush(token, remoto) });
  if (p.codigo !== 0) throw new ErrorDeLote("tranquiseo_push_fallido", motivoPush(p.salida));
  return sha;
}

/**
 * Job C. Con la clave y el token, sin ejecutar nada del cliente.
 * @param {object} o
 * @param {string} o.raizRepo
 * @param {string} o.dirParche
 * @param {string} o.hash             sha256 del parche, del output de A
 * @param {string} o.build            resultado del job B (`needs.compilar.result`): solo "success" publica
 * @param {import('node:crypto').KeyObject|null} o.privada
 */
export async function fasePublicar(o) {
  const log = o.log ?? ((l) => process.stdout.write(l + "\n"));
  const reloj = o.ahora ?? (() => Date.now());
  const seg = () => Math.floor(reloj() / 1000);
  const rama = o.rama ?? "main";
  const remoto = o.remoto ?? "origin";
  const raizRepo = o.raizRepo;
  const config = cargarConfig(raizRepo);
  const resumen = { estado: "ok", ordenes: 0, commits: [], entregado: null, avisos: [] };
  if (!config.sitioId || !o.privada) return { ...resumen, estado: "sin_alta" };
  if (o.ref && o.ref !== `refs/heads/${rama}`) return { ...resumen, estado: "rama_ajena" };
  if (existsSync(join(raizRepo, ".tranquiseo", "revocado.json"))) return { ...resumen, estado: "revocado" };

  let parche, deshacer;
  try {
    parche = leerParche(o.dirParche, o.hash);
    // J10 (Fable 10): un «Re-run» de este job (o de los fallidos) sería otro intento con el parche viejo
    // de A: daría al core un resultado contradictorio con el ya entregado. Solo el mismo intento publica.
    if (o.intento !== undefined && parche.intento !== undefined && o.intento !== parche.intento) throw new ErrorDeParche("intento_distinto");
    deshacer = prepararCheckout(raizRepo, parche);
  } catch (err) {
    if (!(err instanceof ErrorDeParche)) throw err;
    // Nada se sube ni se firma: el core reentrega las órdenes en una ejecución limpia.
    log(`::error::tranquiseo: el parche no es el que preparó el job aplicar (${err.motivo}); no se sube ni se firma nada.`);
    return { ...resumen, estado: "parche_invalido", motivo: err.motivo };
  }
  const canal = { base: o.base ?? URL_BASE, sitioId: config.sitioId, homeUrl: config.homeUrl, privada: o.privada, fetch: o.fetch };
  const esOrdenes = parche.tipo === "ordenes";
  if (esOrdenes) resumen.ordenes = parche.cuerpo.resultados.length;

  // 1. Publicar el parche (si B compiló) o anotar el fallo del lote.
  let errLote = null;
  let sha = null;
  let entradas = [];
  if (o.build === "success") {
    // Qué contenidos existían en la base (antes de aplicar): para ellos, no responder antes del push no es «nuevo».
    const existia = new Set();
    try {
      for (const c of new Sitio(raizRepo, { config }).cargar().contenidos) existia.add(c.id);
    } catch { /* sin contenidos legibles en la base */ }
    try {
      aplicarYComprobar(raizRepo, config, parche.cambios, deshacer);
    } catch (err) {
      if (!(err instanceof ErrorDeParche)) throw err;
      log(`::error::tranquiseo: el parche no pasa la guardia en el job publicar (${err.motivo}); no se sube ni se firma nada.`);
      return { ...resumen, estado: "parche_invalido", motivo: err.motivo };
    }
    // Lo que sirve la web ANTES del push: la espera compara contra esto (C no usa el `dist` de B).
    if (esOrdenes && config.esperaPublicacion > 0 && parche.tocadas.length > 0) {
      entradas = await previasDeEspera(raizRepo, config, parche, existia, o.fetch);
    }
    try {
      sha = confirmarYSubir({ raizRepo, rama, mensaje: parche.mensaje, token: o.token, remoto, rutas: parche.cambios.map((c) => c.ruta) });
      resumen.commits.push(sha);
      log(`tranquiseo: commit ${sha.slice(0, 12)} (${parche.cambios.length} ficheros, compilado en el job sin secretos).`);
    } catch (err) {
      if (!(err instanceof ErrorDeLote)) throw err;
      deshacer();
      errLote = err;
    }
  } else {
    errLote = new ErrorDeLote("tranquiseo_build_fallido", "build_fallido");
    log(`tranquiseo: el job compilar ha acabado en «${String(o.build).slice(0, 20)}»; no se publica el lote.`);
  }

  if (errLote) {
    log(`tranquiseo: el lote no se ha aplicado (${errLote.motivo}).`);
    resumen.avisos.push(`lote_fallido:${errLote.motivo}`);
    if (!esOrdenes) resumen.avisos.push(...parche.avisosSiFalla);
    let estadoGuardado = parche.siFalla.length === 0;
    if (parche.siFalla.length > 0) {
      // J10 (Fable 9): si `main` se ha movido, el estado (solo `.tranquiseo/`) se guarda sobre la cabeza nueva.
      let cabezaNueva = null;
      if (errLote.motivo === "avance_remoto") {
        const f = gitR(raizRepo, ["fetch", "-q", "--no-tags", remoto, `refs/heads/${rama}`], { extra: entornoPush(o.token, remoto) });
        if (f.codigo === 0 && parche.siFalla.every((c) => c.ruta.startsWith(".tranquiseo/"))) {
          cabezaNueva = git(raizRepo, ["rev-parse", "FETCH_HEAD"]).trim();
          gitR(raizRepo, ["reset", "-q", "--hard", cabezaNueva]);
          gitR(raizRepo, ["clean", "-fdq"]);
        }
      }
      const volver = cabezaNueva ? () => {
        gitR(raizRepo, ["reset", "-q", "--hard", cabezaNueva]);
        gitR(raizRepo, ["clean", "-fdq"]);
      } : deshacer;
      try {
        const rutas = aplicarYComprobar(raizRepo, config, parche.siFalla, volver, { exacto: !cabezaNueva });
        if (rutas.length > 0) {
          const s2 = confirmarYSubir({ raizRepo, rama, mensaje: parche.mensajeSiFalla, token: o.token, remoto, rutas });
          resumen.commits.push(s2);
        }
        estadoGuardado = true;
      } catch (err) {
        if (!(err instanceof ErrorDeLote) && !(err instanceof ErrorDeParche)) throw err;
        volver();
        resumen.avisos.push(`estado_no_guardado:${err.motivo}`);
      }
    }
    if (esOrdenes) {
      for (const i of parche.escritas) {
        const s = parche.cuerpo.resultados[i];
        parche.cuerpo.resultados[i] = {
          id: s.id, verbo: s.verbo, ok: false,
          error: { codigo: errLote.codigo, mensaje: mensajeDeLote(errLote), datos: { motivo: errLote.motivo, lote: true } },
        };
      }
      if (parche.rotacion && !estadoGuardado) parche.cuerpo.control.publicas_operacion = false;
    }
  }

  if (!esOrdenes) {
    if (!errLote) {
      resumen.publicados = parche.publicados;
      // J10 (Fable 7): también el programado publicado lanza el despliegue por workflow.
      if (config.despliegue.tipo === "workflow") {
        const lanzado = await dispararDespliegue({ workflow: config.despliegue.workflow, rama, token: o.token, repositorio: o.repositorio, fetch: o.fetch });
        if (!lanzado) resumen.avisos.push("despliegue_no_lanzado");
      }
    }
    return resumen;
  }

  // 2. Despliegue y espera (solo si el lote ha subido).
  const escritas = parche.escritas.map((i) => ({ salida: parche.cuerpo.resultados[i] }));
  if (sha) {
    if (config.despliegue.tipo === "workflow") {
      const lanzado = await dispararDespliegue({ workflow: config.despliegue.workflow, rama, token: o.token, repositorio: o.repositorio, fetch: o.fetch });
      if (!lanzado) avisar(null, escritas, "despliegue_no_lanzado");
    }
    if (entradas.length > 0) {
      const vistos = await esperarPublicacion({ entradas, sha, selector: config.selectorContenido, tope: config.esperaPublicacion, fetch: o.fetch, ...(o.espera ?? {}) });
      for (const s of escritas) {
        const r = s.salida.resultado;
        if (!r || typeof r !== "object" || !vistos.has(r.id)) continue;
        r.publicado = vistos.get(r.id);
        if (!r.publicado.visto) r.avisos = [...(Array.isArray(r.avisos) ? r.avisos : []), "despliegue_no_confirmado"];
      }
    }
  }

  // 3. Resultado firmado.
  try {
    await enviar({ ...canal, ruta: "resultado", dominio: "resultado", cuerpo: parche.cuerpo, ahora: seg() });
    resumen.entregado = true;
  } catch (err) {
    if (!(err instanceof ErrorDeRed)) throw err;
    resumen.entregado = false;
    log(`tranquiseo: no se ha podido entregar el resultado (${err.http ?? err.codigo}).`);
  }

  // 4. Revocar, DESPUÉS de firmar y entregar.
  if (parche.revocar) {
    try {
      new Almacen(raizRepo).escribir("revocado.json", { en: seg() });
      const s3 = confirmarYSubir({ raizRepo, rama, mensaje: "Tranquiseo: sitio desconectado", token: o.token, remoto, rutas: [".tranquiseo/revocado.json"] });
      resumen.commits.push(s3);
    } catch (err) {
      if (!(err instanceof ErrorDeLote)) throw err;
      deshacer();
      resumen.avisos.push(`revocado_no_guardado:${err.motivo}`);
    }
    resumen.estado = "revocado";
  }
  return resumen;
}

/**
 * Entradas para la espera, con la huella de lo que se servía antes del push (J10, Fable 11): el texto
 * dentro del selector (no la página entera, que puede llevar nonces), tomada dos veces. Si las dos tomas
 * difieren, o si una entrada que ya existía no responde, ese criterio no se usa (solo la marca del commit).
 * Se llama con el parche ya aplicado (URLs nuevas incluidas); `existia` se saca de la base, antes.
 */
async function previasDeEspera(raizRepo, config, parche, existia, f) {
  const sitio = new Sitio(raizRepo, { config });
  const entradas = parche.tocadas.map((id) => sitio.contenido(id)).filter((c) => c && c.estado === "publish").map((c) => ({ id: c.id, url: c.url }));
  for (const e of entradas) {
    const a = await huellaServida(e.url, config.selectorContenido, f);
    const b = await huellaServida(e.url, config.selectorContenido, f);
    if (a.estable && b.estable && a.huella === b.huella && (a.huella !== null || !existia.has(e.id))) e.previa = a.huella;
  }
  return entradas;
}

/** Huella del contenido que sirve una URL ahora mismo (null si no responde 200 o no hay selector). */
async function huellaServida(url, selector, f = globalThis.fetch) {
  try {
    const r = await f(url, { redirect: "manual", signal: AbortSignal.timeout(15000), headers: { "Cache-Control": "no-cache" } });
    if (r.status !== 200) {
      await r.body?.cancel().catch(() => {});
      return { estable: r.status === 404 || r.status === 410, huella: null };
    }
    return { estable: true, huella: huellaContenido((await r.text()).slice(0, 5_000_000), selector) };
  } catch {
    return { estable: false, huella: null };
  }
}
