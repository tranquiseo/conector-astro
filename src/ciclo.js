// Una ejecución del conector (spec §9): lo que hace el WP-Cron del plugin en modo saliente, sobre un
// repo git en vez de una base de datos.
//
//   arranque → programados vencidos (lote propio) → consulta firmada → verificar sobre →
//   ejecutar órdenes → guardia de rutas → build → revisión de dist → commit → push →
//   despliegue → espera → resultado firmado → revocar (si toca)
//
// Reglas que no se negocian:
//  - Nada sin compilar llega a la rama: si la guardia, el build, la revisión o el push fallan, se
//    deshace TODO (también `.tranquiseo/`, que viaja en el mismo commit) y las escrituras de ese lote
//    salen con un error transitorio de lote, para que el core las vuelva a mandar.
//  - Una ejecución que solo lee no hace commit... salvo que haya asignado ids nuevos (ver LOG J3):
//    un id entregado y no guardado podría darse a otro fichero en la siguiente ejecución.
//  - Los logs no llevan contenido ni argumentos: verbos, ids y motivos.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { cargarConfig } from "./config.js";
import { Sitio } from "./sitio.js";
import { Motor } from "./verbos/motor.js";
import { Despacho } from "./despacho.js";
import { Ordenes, Registro, Nonces, Publicas } from "./estado/registros.js";
import { Programados, publicarVencidos } from "./programados.js";
import { verificarSobre } from "./cripto/canal.js";
import { enviar, ErrorDeRed, siguienteIntento, URL_BASE } from "./transporte.js";
import { rutasCambiadas, rutasProhibidas } from "./guardia.js";
import { compilar, revisarDist, entornoMinimo, htmlDeUrl, huellaContenido } from "./build.js";
import { git, gitR, huellaGit, configLocalInsegura, rutaGit } from "./util/git.js";
import { readFileSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { rutaDeParcheValida, TOPE_PARCHE } from "./parche-reglas.js";

// Cambios de estado que, solos, no justifican un commit (cada commit es un despliegue).
const VOLATILES = new Set([".tranquiseo/ordenes.jsonl", ".tranquiseo/nonces.json", ".tranquiseo/estado-red.json", ".tranquiseo/registro.jsonl"]);
// Cambios que no necesitan compilar (el sitio no los lee). `redirecciones.json` SÍ lo lee (F6).
const SIN_BUILD = new Set([...VOLATILES, ".tranquiseo/ids.json", ".tranquiseo/programados.json", ".tranquiseo/programados-fallos.json",
  ".tranquiseo/publicas.json", ".tranquiseo/revocado.json"]);
export const AUTOR = ["-c", "user.name=tranquiseo[bot]", "-c", "user.email=bot@tranquiseo.com"];
const MAX_FALLOS_PROGRAMADO = 3;

export class ErrorDeLote extends Error {
  constructor(codigo, motivo, datos = {}) {
    super(motivo);
    this.codigo = codigo;
    this.motivo = motivo;
    this.datos = datos;
  }
}

/** Cabecera de autenticación del push, por variables GIT_CONFIG_* (nunca en argv ni en disco). */
export function entornoPush(token, remoto) {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  // Ligada al host del remoto (segunda pasada Fable, 2): si algo desvía la URL, la cabecera no viaja.
  let clave = "http.extraheader";
  try {
    const u = new URL(remoto);
    if (u.protocol === "https:") clave = `http.${u.origin}/.extraheader`;
  } catch { /* remoto local (pruebas): sin host al que atarla */ }
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: clave, GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` };
}

export function motivoPush(salida) {
  if (/GH006|protected branch|branch protection|required status|pull request/i.test(salida)) return "rama_protegida";
  if (/rejected|non-fast-forward|fetch first|stale info/i.test(salida)) return "avance_remoto";
  return "push_fallido";
}

/**
 * Lanza un workflow de despliegue (`despliegue.tipo: workflow`, spec §9.6).
 * @returns {Promise<boolean>}
 */
export async function dispararDespliegue({ workflow, rama, token, repositorio, api = "https://api.github.com", fetch: f = globalThis.fetch }) {
  // owner/repo; un segmento hecho solo de puntos (`..`) sería salirse de la ruta de la API.
  if (!token || typeof repositorio !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositorio)
    || repositorio.split("/").some((s) => /^\.+$/.test(s))) return false;
  try {
    const r = await f(`${api.replace(/\/+$/, "")}/repos/${repositorio}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
      body: JSON.stringify({ ref: rama }),
    });
    return r.status === 204;
  } catch {
    return false;
  }
}

/**
 * Espera a que la web sirva cada entrada cambiada (spec §9 paso 10): la marca del commit si el
 * layout la pinta, o la huella del texto dentro del selector igual a la de nuestro `dist`.
 * @returns {Promise<Map<number, {url: string, visto: boolean, segundos: number}>>}
 */
export async function esperarPublicacion({ entradas, sha, selector, tope, cada = 15000, fetch: f = globalThis.fetch, reloj = () => Date.now(), dormir = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const inicio = reloj();
  const salida = new Map(entradas.map((e) => [e.id, { url: e.url, visto: false, segundos: 0 }]));
  let pendientes = [...entradas];
  while (pendientes.length > 0) {
    for (const e of [...pendientes]) {
      let html = null;
      try {
        const r = await f(e.url, { redirect: "manual", signal: AbortSignal.timeout(15000), headers: { "Cache-Control": "no-cache" } });
        if (r.status === 200) html = (await r.text()).slice(0, 5_000_000);
        else await r.body?.cancel().catch(() => {});
      } catch {
        html = null;
      }
      const marca = html && sha ? html.includes(`name="tranquiseo-commit" content="${sha}"`) : false;
      // `previa` (fase publicar, sin dist): el texto dentro del selector ha cambiado respecto a lo que se
      // servía antes del push (J10, Fable 11: nunca la página entera, que puede llevar nonces).
      const actual = html && "previa" in e ? huellaContenido(html, selector) : null;
      const cambiada = actual !== null && actual !== e.previa;
      if (html && (marca || cambiada || (e.huella && huellaContenido(html, selector) === e.huella))) {
        salida.set(e.id, { url: e.url, visto: true, segundos: Math.round((reloj() - inicio) / 1000) });
        pendientes = pendientes.filter((p) => p !== e);
      }
    }
    if (pendientes.length === 0 || reloj() - inicio + cada > tope * 1000) break;
    await dormir(cada);
  }
  for (const e of pendientes) salida.set(e.id, { url: e.url, visto: false, segundos: Math.round((reloj() - inicio) / 1000) });
  return salida;
}

/**
 * @param {object} o
 * @param {string} o.raizRepo
 * @param {import('node:crypto').KeyObject|null} o.privada   clave del sitio (del secreto del repo)
 * @param {string} [o.base]           URL base del canal
 * @param {string} [o.rama]           rama por defecto del repo
 * @param {string|null} [o.ref]       GITHUB_REF de la ejecución
 * @param {string|null} [o.token]     GITHUB_TOKEN, SOLO para el push y el disparo del despliegue
 * @param {string|null} [o.repositorio] GITHUB_REPOSITORY (owner/repo)
 * @param {string} [o.remoto]
 * @param {() => number} [o.ahora]    ms
 * @param {typeof fetch} [o.fetch]
 * @param {(url: string) => Promise<Buffer>} [o.descargar]
 * @param {string[]} [o.hostsMedios]
 * @param {object} [o.envBuild]
 * @param {object} [o.espera]         opciones de esperarPublicacion (pruebas)
 * @param {(linea: string) => void} [o.log]
 */
export async function ejecutarCiclo(o) {
  const log = o.log ?? ((l) => process.stdout.write(l + "\n"));
  const reloj = o.ahora ?? (() => Date.now());
  const seg = () => Math.floor(reloj() / 1000);
  const rama = o.rama ?? "main";
  // J10 (Fable 5): la fase por defecto es «aplicar», que nunca compila. Compilar en el mismo proceso
  // que la clave («todo») solo lo piden a propósito los tests del ciclo de un solo job.
  const fase = o.fase ?? "aplicar";
  if (fase !== "aplicar" && fase !== "todo") throw new TypeError("fase_desconocida");
  const raizRepo = o.raizRepo;
  const config = cargarConfig(raizRepo);
  const resumen = { estado: "ok", ordenes: 0, commits: [], entregado: null, avisos: [] };

  // 1. Arranque.
  if (existsSync(join(raizRepo, ".tranquiseo", "revocado.json"))) {
    log("tranquiseo: este sitio está desconectado (revocado). Ejecuta `npx github:tranquiseo/conector-astro baja` para borrar el secreto y desactivar el workflow.");
    return { ...resumen, estado: "revocado" };
  }
  if (!config.sitioId || !o.privada) {
    log("tranquiseo: falta el alta (sitio_id o clave del sitio).");
    return { ...resumen, estado: "sin_alta" };
  }
  if (o.ref && o.ref !== `refs/heads/${rama}`) {
    log(`tranquiseo: no es la rama ${rama}; no se hace nada.`);
    return { ...resumen, estado: "rama_ajena" };
  }
  rutaGit(); // fija la ruta absoluta de git antes de ejecutar nada del cliente
  const inseguras = configLocalInsegura(raizRepo);
  if (inseguras.length > 0) {
    log(`::error::tranquiseo: la configuración local de git trae claves que el conector no admite (${inseguras.join(", ")}); no se hace nada. Usa actions/checkout con persist-credentials: false.`);
    return { ...resumen, estado: "git_config_insegura" };
  }
  if (rutasCambiadas(raizRepo).length > 0) {
    log("tranquiseo: el árbol de trabajo no está limpio; no se toca nada.");
    return { ...resumen, estado: "arbol_sucio" };
  }

  const base = git(raizRepo, ["rev-parse", "HEAD"]).trim();
  let cabeza = base;
  // Línea base de `.git` antes de ejecutar nada del cliente (J8, grave): si un build la cambia,
  // no se vuelve a tocar git con credenciales en toda la ejecución.
  const huellaBase = huellaGit(raizRepo);
  let gitManipulado = false;
  const comprobarGit = () => {
    if (!gitManipulado) {
      let cab = null;
      try {
        cab = git(raizRepo, ["rev-parse", "HEAD"]).trim();
      } catch {
        cab = null;
      }
      gitManipulado = huellaGit(raizRepo) !== huellaBase || cab !== cabeza;
    }
    if (gitManipulado) {
      log("::error::tranquiseo: el build ha modificado el repositorio git (.git); no se sube nada en esta ejecución.");
      throw new ErrorDeLote("tranquiseo_build_fallido", "git_manipulado");
    }
  };

  const deshacer = () => {
    gitR(raizRepo, ["reset", "-q", "--hard", cabeza]);
    gitR(raizRepo, ["clean", "-fdq"]);
  };

  const abrir = () => {
    const sitio = new Sitio(raizRepo, { config, ahora: reloj });
    const almacen = sitio.almacen;
    const e = {
      sitio, almacen,
      ordenes: new Ordenes(almacen), registro: new Registro(almacen), programados: new Programados(almacen),
      nonces: new Nonces(almacen), publicas: new Publicas(almacen),
    };
    e.motor = new Motor(sitio, { registro: e.registro, programados: e.programados, hostsMedios: o.hostsMedios ?? null });
    sitio.cargar();
    return e;
  };

  /**
   * Guardia → build → revisión → commit → push. Si algo falla, deshace y lanza ErrorDeLote.
   * @returns {Promise<{sha: string, rutas: string[], tocadas: number[], compilado: boolean} | null>} null si no había nada que confirmar
   */
  const confirmar = async (e, mensaje, { forzar = false, pausable = false } = {}) => {
    if (gitManipulado) comprobarGit();
    const cambios = rutasCambiadas(raizRepo);
    const relevantes = cambios.filter((r) => !VOLATILES.has(r));
    if (relevantes.length === 0 && !forzar) {
      deshacer();
      return null;
    }
    const malas = rutasProhibidas(raizRepo, config, cambios);
    if (malas.length > 0) {
      deshacer();
      throw new ErrorDeLote("tranquiseo_ruta_prohibida", "ruta_fuera_de_lo_permitido", { rutas: malas.length, motivos: [...new Set(malas.map((m) => m.motivo))] });
    }
    e.sitio.invalidar();
    const porRuta = new Map(e.sitio.cargar().contenidos.map((c) => [c.ruta, c.id]));
    const tocadas = cambios.filter((r) => porRuta.has(r)).map((r) => porRuta.get(r));
    const compilado = cambios.some((r) => !SIN_BUILD.has(r));
    // Fase aplicar (J9, jobs separados): aquí no se compila nunca. Lo que necesita build sale como
    // parche hacia el job sin secretos; el árbol lo deshace quien llama, tras sacar el estado de fallo.
    if (compilado && fase === "aplicar") {
      if (!pausable) {
        deshacer();
        throw new ErrorDeLote("tranquiseo_build_fallido", "build_fuera_de_fase");
      }
      // J10 (Fable 12): un parche que B o C rechazarían se convierte aquí en fallo de lote firmado,
      // en vez de repetirse sin fin.
      if (cambios.some((r) => !rutaDeParcheValida(r))) {
        deshacer();
        throw new ErrorDeLote("tranquiseo_ruta_prohibida", "ruta_no_admitida_en_parche");
      }
      const contenidos = leerCambios(raizRepo, cambios);
      if (contenidos.reduce((n, c) => n + (c.contenido?.length ?? 0) + c.ruta.length + 32, 0) > TOPE_PARCHE / 2) {
        deshacer();
        throw new ErrorDeLote("tranquiseo_build_fallido", "parche_demasiado_grande");
      }
      return { pendiente: true, rutas: cambios, tocadas, compilado: true, mensaje, contenidos };
    }
    if (compilado) {
      const antes = huellaFicheros(raizRepo, cambios);
      const b = await compilar(e.sitio, { env: o.envBuild ?? entornoMinimo() });
      comprobarGit();
      // Lo que el build cambie o meta en el índice fuera de `cambios` no se confirma: el lote falla
      // (segunda pasada Fable, 4). `dist/` y lo ignorado no cuentan (status respeta .gitignore).
      const tras = rutasCambiadas(raizRepo);
      const indice = git(raizRepo, ["diff", "--cached", "--name-only", "-z"]).split("\0").filter(Boolean);
      if (huellaFicheros(raizRepo, cambios) !== antes || tras.join("\0") !== cambios.join("\0") || indice.length > 0) {
        deshacer();
        throw new ErrorDeLote("tranquiseo_build_fallido", "build_modifico_fuentes");
      }
      if (!b.ok) {
        deshacer();
        throw new ErrorDeLote("tranquiseo_build_fallido", b.paso === "instalar" ? "instalar_fallido" : "build_fallido", { log: b.log });
      }
      const revision = revisarDist(e.sitio, tocadas);
      if (!revision.ok) {
        deshacer();
        throw new ErrorDeLote(revision.motivo === "borrador_publicado" ? "tranquiseo_no_disponible" : "tranquiseo_build_fallido", revision.motivo,
          { id: revision.id, detalle: revision.detalle, ...(revision.motivo === "borrador_publicado" ? { capacidad: "borradores", remedio: "La web tiene que filtrar los borradores (prefijo «_» o campo) también en el sitemap." } : {}) });
      }
    }
    comprobarGit();
    let r = gitR(raizRepo, ["add", "-A", "--", ...cambios]);
    if (r.codigo === 0) r = gitR(raizRepo, [...AUTOR, "commit", "-q", "--no-verify", "-m", mensaje]);
    if (r.codigo !== 0) {
      deshacer();
      throw new ErrorDeLote("tranquiseo_push_fallido", "commit_fallido");
    }
    const sha = git(raizRepo, ["rev-parse", "HEAD"]).trim();
    // El commit es nuestro: la cabeza esperada pasa a ser él antes de la última comprobación.
    const previa = cabeza;
    cabeza = sha;
    try {
      comprobarGit();
    } catch (err) {
      cabeza = previa;
      throw err;
    }
    cabeza = previa;
    const p = gitR(raizRepo, ["push", "--porcelain", o.remoto ?? "origin", `HEAD:refs/heads/${rama}`], { extra: entornoPush(o.token, o.remoto ?? "origin") });
    if (p.codigo !== 0) {
      deshacer();
      throw new ErrorDeLote("tranquiseo_push_fallido", motivoPush(p.salida));
    }
    cabeza = sha;
    resumen.commits.push(sha);
    log(`tranquiseo: commit ${sha.slice(0, 12)} (${cambios.length} ficheros${compilado ? ", compilado" : ""}).`);
    return { sha, rutas: cambios, tocadas, compilado };
  };

  // Baja (spec §10): la privada solo vive en GitHub Secrets, así que la firma la Action. Mejor
  // esfuerzo, como `Saliente::despedirse`: el aviso al core puede no llegar, pero el corte local
  // (`revocado.json`) se hace igual; después la CLI borra el secreto y desactiva el workflow.
  if (o.accion === "baja") {
    const canalBaja = { base: o.base ?? URL_BASE, sitioId: config.sitioId, homeUrl: config.homeUrl, privada: o.privada, fetch: o.fetch };
    try {
      await enviar({ ...canalBaja, ruta: "baja", dominio: "consulta", cuerpo: { motivo: "baja" }, ahora: seg() });
      resumen.entregado = true;
    } catch (err) {
      if (!(err instanceof ErrorDeRed)) throw err;
      resumen.entregado = false;
      resumen.avisos.push("baja_no_entregada");
      log(`tranquiseo: el aviso de baja no ha llegado (${err.http ?? err.codigo}); revoca también el sitio desde el panel.`);
    }
    const eb = abrir();
    eb.almacen.escribir("revocado.json", { en: seg() });
    try {
      await confirmar(eb, "Tranquiseo: sitio dado de baja", { forzar: true });
    } catch (err) {
      if (!(err instanceof ErrorDeLote)) throw err;
      resumen.avisos.push(`revocado_no_guardado:${err.motivo}`);
    }
    log("tranquiseo: sitio dado de baja.");
    return { ...resumen, estado: "baja" };
  }

  // 2. Programados vencidos: lote propio, antes de consultar. Si rompen el build, se cuentan los
  //    fallos (en un commit solo de estado, que no compila) y al tercero se quedan en borrador.
  {
    const e = abrir();
    const { publicados, avisos } = publicarVencidos(e.sitio, e.programados);
    resumen.avisos.push(...avisos);
    if (publicados.length > 0 && fase === "aplicar") {
      const pendiente = await programadosEnFases(publicados);
      if (pendiente) return pendiente;
    } else if (publicados.length > 0) {
      e.sitio.guardarIds();
      e.programados.guardar();
      try {
        const lote = await confirmar(e, `Tranquiseo: publicado programado (${publicados.join(", ")})`);
        resumen.publicados = publicados;
        // J10 (Fable 7): el push con GITHUB_TOKEN no lanza `on: push`; el despliegue por workflow se dispara aquí.
        if (lote?.compilado && config.despliegue.tipo === "workflow") {
          const lanzado = await dispararDespliegue({ workflow: config.despliegue.workflow, rama, token: o.token, repositorio: o.repositorio, fetch: o.fetch });
          if (!lanzado) resumen.avisos.push("despliegue_no_lanzado");
        }
      } catch (err) {
        if (!(err instanceof ErrorDeLote)) throw err;
        log(`tranquiseo: no se han podido publicar los programados ${publicados.join(", ")} (${err.motivo}).`);
        const e2 = abrir();
        const fallos = e2.almacen.leer("programados-fallos.json", {});
        for (const id of publicados) {
          fallos[id] = (Number(fallos[id]) || 0) + 1;
          if (fallos[id] >= MAX_FALLOS_PROGRAMADO) {
            e2.programados.quitar(id);
            delete fallos[id];
            resumen.avisos.push(`programado_no_publicable:${id}`);
          }
        }
        e2.almacen.escribir("programados-fallos.json", fallos);
        e2.programados.guardar();
        try {
          await confirmar(e2, "Tranquiseo: programado no publicado (se reintentará)", { forzar: true });
        } catch (err2) {
          if (!(err2 instanceof ErrorDeLote)) throw err2;
          resumen.avisos.push(`estado_no_guardado:${err2.motivo}`);
        }
      }
    }
  }

  // Segunda pasada Fable (5): con `.git` manipulado por un build no se consulta ni se firma nada más.
  if (gitManipulado) return { ...resumen, estado: "git_manipulado" };

  // 3. Consulta.
  const e = abrir();
  // Ids tal como quedan tras la carga (antes de ninguna orden): son los que pueden salir en las
  // lecturas. Si el lote falla y se deshace, se vuelven a guardar (J8, M3).
  const idsTrasCarga = JSON.parse(JSON.stringify(e.sitio.ids.datos));
  const despacho = new Despacho({ sitio: e.sitio, motor: e.motor, ordenes: e.ordenes, publicas: e.publicas, transporte: () => resumenRed(estadoRed) });
  let estadoRed = e.almacen.leer("estado-red.json", {});
  const ahora = seg();
  if (Number(estadoRed.proximo_no_antes) > ahora) {
    log("tranquiseo: en retroceso tras fallos de red; esta vez no se consulta.");
    resumen.estado = "en_retroceso";
    await confirmarSoloEstado();
    return resumen;
  }
  const canal = { base: o.base ?? URL_BASE, sitioId: config.sitioId, homeUrl: config.homeUrl, privada: o.privada, fetch: o.fetch };
  const latencia = {
    desde_ultimo_contacto: estadoRed.ultimo_contacto ? ahora - estadoRed.ultimo_contacto : null,
    desde_ultimo_intento: estadoRed.ultimo_intento ? ahora - estadoRed.ultimo_intento : null,
    intervalo: config.intervalo, retraso: null, wp_cron_desactivado: false,
    fallos_seguidos: Number(estadoRed.fallos_seguidos) || 0, plataforma: "astro",
  };
  estadoRed = { ...estadoRed, ultimo_intento: ahora };
  let respuesta = null;
  try {
    respuesta = await enviar({ ...canal, ruta: "consulta", dominio: "consulta", cuerpo: { max: 5, latencia, estado: despacho.estado() }, ahora });
  } catch (err) {
    if (!(err instanceof ErrorDeRed)) throw err;
    estadoRed = siguienteIntento(estadoRed, config.intervalo, ahora, err.http ? `http_${err.http}` : err.codigo);
    log(`tranquiseo: la consulta ha fallado (${err.http ?? err.codigo}).`);
    resumen.estado = "fallo_de_red";
    await confirmarSoloEstado();
    return resumen;
  }

  let sobre = null;
  if (respuesta) {
    const v = verificarSobre({
      json: respuesta.sobre, firma: respuesta.firma, dominio: "orden", sitioId: config.sitioId, homeUrl: config.homeUrl,
      publicas: e.publicas.lista, nonces: e.nonces, ahora: seg(),
    });
    if (!v.ok) {
      // Hacia fuera nada; en el log, el motivo (nunca el sobre).
      log(`tranquiseo: sobre de órdenes rechazado (${v.motivo}).`);
      estadoRed = siguienteIntento(estadoRed, config.intervalo, seg(), v.motivo);
      resumen.estado = "sobre_rechazado";
      await confirmarSoloEstado();
      return resumen;
    }
    sobre = v.sobre;
  }
  estadoRed = { ...estadoRed, ultimo_contacto: seg(), fallos_seguidos: 0, proximo_no_antes: 0, ultimo_error: "" };
  if (!sobre) {
    await confirmarSoloEstado();
    return { ...resumen, estado: resumen.commits.length ? "ok" : "sin_ordenes" };
  }

  // 4-5. Ejecutar.
  await despacho.prepararDescargas(sobre.cuerpo?.ordenes, o.descargar);
  const atendido = despacho.atender(sobre.cuerpo);
  resumen.ordenes = atendido.salidas.length;
  for (const s of atendido.salidas) log(`tranquiseo: orden ${s.salida.id} ${s.salida.verbo} → ${s.salida.ok ? "ok" : s.salida.error.codigo}${s.salida.repetida ? " (repetida)" : ""}`);
  e.sitio.guardarIds();
  e.programados.guardar();
  e.nonces.guardar();
  e.ordenes.podar(seg());
  e.registro.podar(seg());

  // 6-9. Guardia, build, commit, push.
  const escritas = atendido.salidas.filter((s) => s.escritura && s.ejecutada);
  const verbos = [...new Set(escritas.map((s) => s.salida.verbo))];
  let lote = null;
  try {
    if (rutasCambiadas(raizRepo).some((r) => !VOLATILES.has(r))) e.almacen.escribir("estado-red.json", estadoRed);
    lote = await confirmar(e, escritas.length > 0 ? `Tranquiseo: ${escritas.length} cambio${escritas.length === 1 ? "" : "s"} (${verbos.join(", ")})` : "Tranquiseo: estado", { pausable: true });
    if (lote?.pendiente) {
      // Fase aplicar: el resultado lo firma el job publicar, tras el build. Se prepara también lo
      // que habría que guardar si el build falla (ids de las lecturas y rotación, J8 M2/M3).
      deshacer();
      const rotacion = atendido.cuerpo.control?.publicas_operacion === true;
      e.almacen.escribir("ids.json", idsTrasCarga);
      if (rotacion) e.publicas.reemplazar(e.publicas.lista);
      const siFalla = leerCambios(raizRepo, rutasCambiadas(raizRepo).filter((r) => !VOLATILES.has(r)));
      deshacer();
      const parche = {
        tipo: "ordenes", base: cabeza, mensaje: lote.mensaje, tocadas: lote.tocadas, cambios: lote.contenidos,
        siFalla, mensajeSiFalla: "Tranquiseo: estado (lote no aplicado)",
        cuerpo: atendido.cuerpo, escritas: escritas.map((s) => atendido.cuerpo.resultados.indexOf(s.salida)),
        rotacion, revocar: atendido.revocar === true,
      };
      return { ...resumen, estado: "pendiente_build", parche };
    }
  } catch (err) {
    if (!(err instanceof ErrorDeLote)) throw err;
    log(`tranquiseo: el lote no se ha aplicado (${err.motivo}); las escrituras vuelven al core.`);
    resumen.avisos.push(`lote_fallido:${err.motivo}`);
    // Spec §9.9: falla el lote, no la orden. Error transitorio de lote para las escrituras que
    // se habían aplicado (y se han deshecho); las lecturas y los fallos propios de cada orden, igual.
    for (const s of escritas) {
      const i = atendido.cuerpo.resultados.indexOf(s.salida);
      atendido.cuerpo.resultados[i] = {
        id: s.salida.id, verbo: s.salida.verbo, ok: false,
        error: { codigo: err.codigo, mensaje: mensajeDeLote(err), datos: { motivo: err.motivo, lote: true, ...err.datos } },
      };
    }
    // J8 (M2/M3): el deshacer se ha llevado también lo que no era del lote: los ids que ya han
    // salido en las lecturas y la rotación de claves de operación. Se guardan en un commit solo de
    // estado (sin build) ANTES de entregar el resultado; si no se puede, la rotación no se acusa.
    const rotacion = atendido.cuerpo.control?.publicas_operacion === true;
    let estadoGuardado = false;
    // Tras un build que tocó fuentes (indicio de build hostil) tampoco: sería otro push con token
    // justo detrás de él (segunda pasada Fable, 6). Los ids se recuperan en la siguiente ejecución.
    if (!gitManipulado && err.motivo !== "build_modifico_fuentes") {
      try {
        e.almacen.escribir("ids.json", idsTrasCarga);
        if (rotacion) e.publicas.reemplazar(e.publicas.lista);
        await confirmar(abrir(), "Tranquiseo: estado (lote no aplicado)");
        estadoGuardado = true;
      } catch (err2) {
        if (!(err2 instanceof ErrorDeLote)) throw err2;
        resumen.avisos.push(`estado_no_guardado:${err2.motivo}`);
      }
    }
    if (rotacion && !estadoGuardado) atendido.cuerpo.control.publicas_operacion = false;
  }

  // Sin resultado firmado: el core reentregará las órdenes en una ejecución limpia.
  if (gitManipulado) return { ...resumen, estado: "git_manipulado" };

  // 9b-10. Despliegue y espera.
  if (lote && lote.compilado) {
    if (config.despliegue.tipo === "workflow") {
      const lanzado = await dispararDespliegue({ workflow: config.despliegue.workflow, rama, token: o.token, repositorio: o.repositorio, fetch: o.fetch });
      if (!lanzado) avisar(atendido, escritas, "despliegue_no_lanzado");
    }
    if (config.esperaPublicacion > 0 && lote.tocadas.length > 0) {
      e.sitio.invalidar();
      const entradas = lote.tocadas.map((id) => e.sitio.contenido(id)).filter((c) => c && c.estado === "publish").map((c) => {
        const f = htmlDeUrl(e.sitio, c.url);
        return { id: c.id, url: c.url, huella: f ? huellaContenido(readFileSync(f, "utf8"), config.selectorContenido) : null };
      });
      const vistos = await esperarPublicacion({ entradas, sha: lote.sha, selector: config.selectorContenido, tope: config.esperaPublicacion, fetch: o.fetch, ...(o.espera ?? {}) });
      for (const s of escritas) {
        const r = s.salida.resultado;
        if (!r || typeof r !== "object" || !vistos.has(r.id)) continue;
        r.publicado = vistos.get(r.id);
        if (!r.publicado.visto) r.avisos = [...(Array.isArray(r.avisos) ? r.avisos : []), "despliegue_no_confirmado"];
      }
    }
  }

  // 11. Resultado.
  if (atendido.cuerpo.resultados.length > 0 || Object.keys(atendido.cuerpo.control).length > 0) {
    try {
      await enviar({ ...canal, ruta: "resultado", dominio: "resultado", cuerpo: atendido.cuerpo, ahora: seg() });
      resumen.entregado = true;
    } catch (err) {
      if (!(err instanceof ErrorDeRed)) throw err;
      // El core reentrega a los 30 min y la idempotencia devuelve lo mismo (`repetida`).
      resumen.entregado = false;
      log(`tranquiseo: no se ha podido entregar el resultado (${err.http ?? err.codigo}).`);
    }
  }

  // 12. Revocar: DESPUÉS de firmar y entregar.
  if (atendido.revocar) {
    const e3 = abrir();
    e3.almacen.escribir("revocado.json", { en: seg() });
    try {
      await confirmar(e3, "Tranquiseo: sitio desconectado", { forzar: true });
    } catch (err) {
      if (!(err instanceof ErrorDeLote)) throw err;
      resumen.avisos.push(`revocado_no_guardado:${err.motivo}`);
    }
    resumen.estado = "revocado";
    log("tranquiseo: el sitio se ha desconectado. Ejecuta `npx github:tranquiseo/conector-astro baja` para borrar el secreto y desactivar el workflow.");
  }
  return resumen;

  /**
   * Programados vencidos con jobs separados (J10, Fable 6). El intento se cuenta AQUÍ, en un commit solo
   * de estado subido antes de nada: si B o C no llegan a terminar (rama protegida, parche rechazado, job
   * cancelado), el contador avanza igual y al cuarto intento el programado se queda en borrador y se
   * vuelve a consultar. Si ni eso se puede subir, no se intenta: se consulta como siempre.
   * @returns {Promise<object|null>} el resumen con el parche, o null para seguir con la consulta
   */
  async function programadosEnFases(publicados) {
    deshacer();
    const e2 = abrir();
    const fallos = e2.almacen.leer("programados-fallos.json", {});
    const intentar = [];
    for (const id of publicados) {
      const n = Number(fallos[id]) || 0;
      if (n >= MAX_FALLOS_PROGRAMADO) {
        e2.programados.quitar(id);
        delete fallos[id];
        resumen.avisos.push(`programado_no_publicable:${id}`);
      } else {
        fallos[id] = n + 1;
        intentar.push(id);
      }
    }
    e2.almacen.escribir("programados-fallos.json", fallos);
    e2.programados.guardar();
    try {
      await confirmar(e2, intentar.length > 0 ? `Tranquiseo: intento de publicar programado (${intentar.join(", ")})` : "Tranquiseo: programado no publicado", { forzar: true });
    } catch (err) {
      if (!(err instanceof ErrorDeLote)) throw err;
      resumen.avisos.push(`estado_no_guardado:${err.motivo}`);
      log(`tranquiseo: no se ha podido guardar el intento de publicar programados (${err.motivo}); se consulta igualmente.`);
      return null;
    }
    if (intentar.length === 0) return null;
    const e3 = abrir();
    const r = publicarVencidos(e3.sitio, e3.programados);
    if (r.publicados.length === 0) {
      deshacer();
      return null;
    }
    e3.sitio.guardarIds();
    e3.programados.guardar();
    const f3 = e3.almacen.leer("programados-fallos.json", {});
    for (const id of r.publicados) delete f3[id];
    e3.almacen.escribir("programados-fallos.json", f3);
    try {
      const lote = await confirmar(e3, `Tranquiseo: publicado programado (${r.publicados.join(", ")})`, { pausable: true });
      if (lote?.pendiente) {
        deshacer();
        // Lote propio: esta ejecución no consulta; las órdenes, en la siguiente. Si el build falla no hay
        // nada más que guardar (el intento ya está contado).
        const parche = { tipo: "programados", base: cabeza, mensaje: lote.mensaje, tocadas: lote.tocadas, cambios: lote.contenidos,
          siFalla: [], mensajeSiFalla: "Tranquiseo: programado no publicado (se reintentará)", publicados: r.publicados, avisosSiFalla: [] };
        return { ...resumen, estado: "pendiente_build", parche };
      }
      resumen.publicados = r.publicados;
    } catch (err) {
      if (!(err instanceof ErrorDeLote)) throw err;
      log(`tranquiseo: no se han podido publicar los programados ${r.publicados.join(", ")} (${err.motivo}).`);
    }
    return null;
  }

  // Sin órdenes: solo hay commit si se asignaron ids (o estado que no puede perderse).
  async function confirmarSoloEstado() {
    e.sitio.guardarIds();
    try {
      if (rutasCambiadas(raizRepo).some((r) => !VOLATILES.has(r))) {
        e.almacen.escribir("estado-red.json", estadoRed);
        await confirmar(e, "Tranquiseo: estado");
      } else deshacer();
    } catch (err) {
      if (!(err instanceof ErrorDeLote)) throw err;
      resumen.avisos.push(`estado_no_guardado:${err.motivo}`);
    }
  }
}

/**
 * Contenido de las rutas cambiadas, para el parche de la fase aplicar: base64 o null si se borró.
 * @returns {{ruta: string, contenido: string|null}[]}
 */
export function leerCambios(raizRepo, rutas) {
  return rutas.map((ruta) => {
    const st = lstatSync(join(raizRepo, ruta), { throwIfNoEntry: false });
    if (!st) return { ruta, contenido: null };
    if (!st.isFile()) throw new ErrorDeLote("tranquiseo_ruta_prohibida", "tipo_de_fichero_no_admitido");
    return { ruta, contenido: readFileSync(join(raizRepo, ruta)).toString("base64") };
  });
}

/** Huella del contenido de unas rutas del repo (para ver si el build las ha cambiado). */
function huellaFicheros(raizRepo, rutas) {
  const h = createHash("sha256");
  for (const r of rutas) {
    const abs = join(raizRepo, r);
    const st = lstatSync(abs, { throwIfNoEntry: false });
    h.update(`${r}\0`);
    if (!st) h.update("no\0");
    else if (st.isFile()) h.update(readFileSync(abs));
    else h.update(`tipo:${st.mode}\0`);
  }
  return h.digest("hex");
}

function resumenRed(estadoRed) {
  const salida = {};
  for (const k of ["ultimo_contacto", "ultimo_intento", "fallos_seguidos", "proximo_no_antes", "ultimo_error"]) {
    if (["string", "number", "boolean"].includes(typeof estadoRed[k])) salida[k] = estadoRed[k];
  }
  salida.pendientes = 0;
  return salida;
}

export function avisar(atendido, escritas, aviso) {
  for (const s of escritas) {
    const r = s.salida.resultado;
    if (r && typeof r === "object") r.avisos = [...(Array.isArray(r.avisos) ? r.avisos : []), aviso];
  }
}

export function mensajeDeLote(err) {
  switch (err.codigo) {
    case "tranquiseo_build_fallido":
      return "La web no compila con estos cambios: no se ha publicado nada y se reintentará.";
    case "tranquiseo_ruta_prohibida":
      return "Los cambios tocaban ficheros fuera de lo permitido: no se ha publicado nada.";
    case "tranquiseo_push_fallido":
      return err.motivo === "rama_protegida" ? "La rama principal exige revisión: el conector no puede publicar." : "No se ha podido subir el cambio: se reintentará.";
    default:
      return "El cambio no se ha publicado y se reintentará.";
  }
}
