// Punto de entrada de la GitHub Action (`action.yml` → aquí → `ejecutarCiclo`).
//
// Lo primero que se hace es sacar los secretos del entorno del proceso: la clave del sitio y el
// token pasan a variables locales y se borran de `process.env`, para que ningún proceso hijo
// (git, el build del cliente, un `postinstall`) los herede por descuido. El build ya corre con un
// entorno mínimo explícito (`entornoMinimo`), y git con el suyo (`util/git.js`); esto es la
// segunda capa.
//
// Los logs no llevan contenido, argumentos ni secretos: estados, verbos, ids y motivos.

import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ejecutarCiclo } from "./ciclo.js";
import { escribirParche, leerParche, faseCompilar, fasePublicar } from "./fases.js";
import { privadaDesdeB64 } from "./cripto/claves.js";
import { URL_BASE, validarBase } from "./transporte.js";
import { ErrorDeConfig } from "./config.js";
import { filtrarLog } from "./build.js";

export const ACCIONES = Object.freeze(["ciclo", "baja"]);
// Jobs separados (J9): aplicar (clave, sin código del cliente) → compilar (sin secretos) → publicar
// (clave, sin código del cliente). No hay modo «todo en un job»: el build nunca ve la clave.
export const FASES = Object.freeze(["aplicar", "compilar", "publicar"]);
const SECRETOS = ["TRANQUISEO_CLAVE_SITIO", "TRANQUISEO_GITHUB_TOKEN", "INPUT_CLAVE", "INPUT_TOKEN"];

// Estados que no son un fallo del conector pero que el cliente debería ver en la pestaña Actions.
const AVISOS = {
  sin_alta: "Falta el alta: no hay sitio_id en tranquiseo.config.json o no está el secreto TRANQUISEO_CLAVE_SITIO.",
  fallo_de_red: "No se ha podido hablar con Tranquiseo; se reintentará en el siguiente turno.",
  sobre_rechazado: "Tranquiseo ha respondido con algo que no se ha podido verificar; no se ha ejecutado nada.",
  arbol_sucio: "El checkout trae cambios sin confirmar; el conector no toca nada.",
  rama_ajena: "El workflow se ha lanzado sobre una rama que no es la principal; no se hace nada.",
  git_manipulado: "El build de la web ha modificado la carpeta .git: no se ha subido ni firmado nada. Revisa las dependencias de la web.",
  git_config_insegura: "La configuración de git del checkout trae credenciales o includes: usa actions/checkout con persist-credentials: false.",
  parche_invalido: "El parche entre los jobs no es el que preparó el job aplicar: no se ha subido ni firmado nada.",
  revocado: "Este sitio está desconectado de Tranquiseo. Ejecuta `npx github:tranquiseo/conector-astro baja` para borrar el secreto y desactivar el workflow.",
};

/** `https://github.com/<owner>/<repo>.git` a partir de GITHUB_REPOSITORY (y GITHUB_SERVER_URL), o null. */
export function remotoExplicito(env) {
  const repo = env.GITHUB_REPOSITORY;
  if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split("/").some((s) => /^\.+$/.test(s))) return null;
  const servidor = env.GITHUB_SERVER_URL || "https://github.com";
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(servidor)) return null;
  return `${servidor}/${repo}.git`;
}

/** Saca los secretos del entorno (y los borra) antes de hacer nada más. */
export function sacarSecretos(env) {
  const clave = env.TRANQUISEO_CLAVE_SITIO ?? env.INPUT_CLAVE ?? "";
  const token = env.TRANQUISEO_GITHUB_TOKEN ?? env.INPUT_TOKEN ?? "";
  for (const k of SECRETOS) delete env[k];
  return { clave: String(clave).trim(), token: String(token).trim() };
}

/** Carpeta del parche entre jobs (fuera del checkout). */
export function dirParche(env) {
  return env.TRANQUISEO_DIR_PARCHE || join(env.RUNNER_TEMP || tmpdir(), "tranquiseo-parche");
}

/** Outputs del paso (`$GITHUB_OUTPUT`). Solo valores hechos a mano: hex, dígitos, true/false. */
function salidas(env, pares, log) {
  for (const [k, v] of Object.entries(pares)) {
    if (!/^[a-z]+$/.test(k) || !/^[A-Za-z0-9_-]{0,128}$/.test(String(v))) throw new Error("output_invalido");
  }
  const texto = Object.entries(pares).map(([k, v]) => `${k}=${v}\n`).join("");
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, texto);
  else log(`tranquiseo: outputs ${texto.trim().replace(/\n/g, ", ")}`);
}

/**
 * @param {object} [p]
 * @param {Record<string, string|undefined>} [p.env]  por defecto `process.env` (se modifica: se le borran los secretos)
 * @param {(l: string) => void} [p.log]
 * @param {typeof ejecutarCiclo} [p.ciclo]
 * @param {typeof fetch} [p.fetch]
 * @returns {Promise<number>} código de salida
 */
export async function principal({ env = process.env, log = (l) => process.stdout.write(l + "\n"), ciclo = ejecutarCiclo, compilarFase = faseCompilar, publicarFase = fasePublicar, fetch } = {}) {
  const { clave, token } = sacarSecretos(env);
  try {
    const mayor = Number(process.versions.node.split(".")[0]);
    if (mayor < 22) {
      log(`::error::El conector necesita Node 22 o superior (hay ${process.versions.node}). Usa actions/setup-node con node-version: 22.`);
      return 1;
    }
    const fase = (env.TRANQUISEO_FASE || "aplicar").trim();
    if (!FASES.includes(fase)) {
      log(`::error::Fase desconocida: tiene que ser ${FASES.join(", ")}.`);
      return 1;
    }
    const raizRepo = resolve(env.GITHUB_WORKSPACE || process.cwd());
    if (fase === "compilar") {
      // El job que ejecuta el código de la web no puede recibir secretos: si llegan, es un workflow mal hecho.
      if (clave || token) {
        log("::error::La fase compilar no puede recibir la clave del sitio ni el token. Usa el workflow reutilizable del conector tal cual.");
        return 1;
      }
      const r = await compilarFase({ raizRepo, dirParche: dirParche(env), hash: (env.TRANQUISEO_HASH_PARCHE || "").trim(), log });
      return r.estado === "ok" ? 0 : 1;
    }
    const accion = (env.TRANQUISEO_ACCION || "ciclo").trim();
    if (!ACCIONES.includes(accion)) {
      log(`::error::Acción desconocida: tiene que ser ${ACCIONES.join(" o ")}.`);
      return 1;
    }
    let base;
    try {
      base = validarBase(env.TRANQUISEO_URL_BASE || URL_BASE);
    } catch {
      log("::error::La URL del servicio tiene que ser https.");
      return 1;
    }
    let privada = null;
    if (clave) {
      try {
        privada = privadaDesdeB64(clave);
      } catch {
        log("::error::El secreto TRANQUISEO_CLAVE_SITIO no es una clave válida. Vuelve a dar de alta el sitio.");
        return 1;
      }
    }
    const rama = (env.TRANQUISEO_RAMA || "main").trim();
    if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(rama) || rama.includes("..")) {
      log("::error::El nombre de la rama no es válido.");
      return 1;
    }
    const comunes = {
      raizRepo, privada, base, rama,
      ref: env.GITHUB_REF || null,
      token: token || null,
      repositorio: env.GITHUB_REPOSITORY || null,
      // Push a una URL explícita, no a lo que diga `remote.origin.url` (J8, grave).
      ...(remotoExplicito(env) ? { remoto: remotoExplicito(env) } : {}),
      log,
      ...(fetch ? { fetch } : {}),
    };
    if (fase === "publicar") {
      const r = await publicarFase({
        ...comunes, dirParche: dirParche(env), hash: (env.TRANQUISEO_HASH_PARCHE || "").trim(), build: (env.TRANQUISEO_RESULTADO_BUILD || "").trim(),
        ...(/^\d{1,5}$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ? { intento: env.GITHUB_RUN_ATTEMPT } : {}),
      });
      if (AVISOS[r.estado]) log(`::warning::${AVISOS[r.estado]}`);
      for (const a of r.avisos ?? []) log(`::warning::tranquiseo: ${a}`);
      log(`tranquiseo: ${r.estado}; órdenes ${r.ordenes}; commits ${r.commits.length}${r.entregado === false ? "; resultado no entregado" : ""}.`);
      return r.estado === "parche_invalido" ? 1 : 0;
    }
    const r = await ciclo({ ...comunes, accion, fase: "aplicar" });
    if (r.estado === "pendiente_build" && r.parche) {
      const id = /^\d{1,20}$/.test(env.GITHUB_RUN_ID ?? "") ? env.GITHUB_RUN_ID : "local";
      const intento = /^\d{1,5}$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ? env.GITHUB_RUN_ATTEMPT : "1";
      // El intento viaja DENTRO del parche (cubierto por el hash): C solo publica en ese mismo intento.
      const { hash } = escribirParche(dirParche(env), { ...r.parche, intento });
      leerParche(dirParche(env), hash); // lo que B y C van a exigir; si no pasa, que falle aquí (no debería)
      salidas(env, { compilar: "true", hash, base: r.parche.base, artefacto: `tranquiseo-parche-${id}-${intento}` }, log);
      log(`tranquiseo: ${r.parche.cambios.length} ficheros listos para compilar (sin secretos) y publicar.`);
      return 0;
    }
    salidas(env, { compilar: "false" }, log);
    if (accion === "baja" && r.estado !== "baja" && r.estado !== "revocado") {
      // La CLI espera a esta ejecución para borrar el secreto: si la baja no se ha hecho, que falle.
      log(`::error::La baja no se ha podido hacer (${r.estado}).`);
      return 1;
    }
    if (AVISOS[r.estado]) log(`::warning::${AVISOS[r.estado]}`);
    for (const a of r.avisos ?? []) log(`::warning::tranquiseo: ${a}`);
    log(`tranquiseo: ${r.estado}; órdenes ${r.ordenes}; commits ${r.commits.length}${r.entregado === false ? "; resultado no entregado" : ""}.`);
    return 0;
  } catch (err) {
    if (err instanceof ErrorDeConfig) {
      log(`::error::${err.message}`);
      return 1;
    }
    log(`::error::Error inesperado del conector: ${filtrarLog(err?.message ?? String(err)).slice(0, 500)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  principal().then((codigo) => {
    process.exitCode = codigo;
  });
}
