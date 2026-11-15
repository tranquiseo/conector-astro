// `npx github:tranquiseo/conector-astro alta <CODIGO>`: el canje del plugin (`Alta/Canje.php`) hecho
// desde la máquina del cliente, dentro del repo de su web (spec §10, CONTRATO-ALTA.md).
//
// Orden, y por qué:
//  1. Código con la forma esperada, antes de gastar red (y para no mandar por error otra cosa).
//  2. `gh` con sesión y repo de GitHub.
//  3. Par Ed25519 nuevo, en memoria.
//  4. La privada se guarda PRIMERO como secreto del repo (`gh secret set`, por stdin). Si no se
//     puede, no se canjea el código: así nunca queda un sitio dado de alta con una clave que
//     nadie tiene. Si después el canje falla, el secreto se borra.
//  5. `POST /conector/alta` con la prueba de posesión atada a `codigo_sha256`.
//  6. Respuesta validada con esquema cerrado (es entrada de red, aunque venga de nosotros).
//  7. `sitio_id` a la config y públicas de operación a `.tranquiseo/publicas.json`.
//
// La privada NUNCA se imprime ni se escribe en disco.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cargarConfig, NOMBRE } from "../config.js";
import { Sitio, VERSION_CONECTOR } from "../sitio.js";
import { Motor } from "../verbos/motor.js";
import { capacidades, versionAstro } from "../capacidades.js";
import { generarPar, firmar, semillaB64, publicaDesdeB64 } from "../cripto/claves.js";
import { bytesFirmados } from "../cripto/sobre.js";
import { URL_BASE, validarBase } from "../transporte.js";
import { filtrarLog } from "../build.js";
import { crearGh, repoDeGh } from "./gh.js";

export const PATRON_CODIGO = /^[A-Za-z0-9]{6}-[A-Za-z0-9]{6}-[A-Za-z0-9]{6}-[A-Za-z0-9]{6}$/;
export const SECRETO = "TRANQUISEO_CLAVE_SITIO";
export const WORKFLOW = "tranquiseo.yml";
const EJEMPLO_WORKFLOW = fileURLToPath(new URL("../../ejemplos/workflow.yml", import.meta.url));

const RECHAZADO = "Ese código no vale: o ya se ha usado, o ha caducado, o no es de esta web. Genera uno nuevo en tu panel y vuelve a probar.";
const RESPUESTA_INVALIDA = "Hemos recibido una respuesta que no entendemos y no hemos conectado nada. No es culpa tuya: escríbenos y lo miramos.";

export function hashDelCodigo(codigo) {
  return createHash("sha256").update(String(codigo).trim().toUpperCase(), "utf8").digest("hex");
}

/** Fecha como `date('c')` de PHP: `2026-09-02T18:20:47+00:00`. */
function fechaC(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/** La prueba de posesión: mismo objeto y mismo orden de claves que `Canje::prueba_de_posesion`. */
export function pruebaDePosesion({ publica, privada, homeUrl, codigo, ahora, nonce = randomBytes(16).toString("hex") }) {
  const sobre = JSON.stringify({
    v: 1, dominio: "alta", home_url: homeUrl, clave_publica: publica,
    codigo_sha256: hashDelCodigo(codigo), emitido_en: ahora, nonce,
  });
  return { sobre, firma: firmar(bytesFirmados(sobre, "alta"), privada) };
}

/** Esquema cerrado de la respuesta, como `Canje::validar_respuesta`. */
export function validarRespuesta(cuerpo) {
  if (!cuerpo || typeof cuerpo !== "object" || Array.isArray(cuerpo)) return null;
  const sitioId = typeof cuerpo.sitio_id === "string" ? cuerpo.sitio_id : "";
  if (!/^[A-Za-z0-9-]{8,64}$/.test(sitioId)) return null;
  let lista = [];
  if (Array.isArray(cuerpo.publicas_operacion)) lista = cuerpo.publicas_operacion;
  else if (cuerpo.publica_operacion !== undefined) lista = [cuerpo.publica_operacion];
  const validas = [...new Set(lista.filter((p) => typeof p === "string" && publicaDesdeB64(p)))].slice(0, 4);
  if (validas.length === 0) return null;
  return { sitioId, publicas: validas };
}

function escribirAtomico(ruta, texto) {
  if (existsSync(ruta) && lstatSync(ruta).isSymbolicLink()) throw new Error("enlace_simbolico");
  const tmp = `${ruta}.tq-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, texto, { flag: "wx" });
  renameSync(tmp, ruta);
}

/** `sitio_id` en la config, justo detrás de `version`, sin tocar lo demás. */
function fijarSitioId(raizRepo, sitioId) {
  const ruta = join(raizRepo, NOMBRE);
  const actual = JSON.parse(readFileSync(ruta, "utf8"));
  const nuevo = {};
  for (const [k, v] of Object.entries(actual)) {
    if (k === "sitio_id") continue;
    nuevo[k] = v;
    if (k === "version") nuevo.sitio_id = sitioId;
  }
  if (!("sitio_id" in nuevo)) nuevo.sitio_id = sitioId;
  escribirAtomico(ruta, JSON.stringify(nuevo, null, 2) + "\n");
}

/**
 * @param {object} p
 * @param {string} p.codigo
 * @param {string} [p.raizRepo]
 * @param {string} [p.base]
 * @param {string} [p.gh]           binario de gh
 * @param {typeof fetch} [p.fetch]
 * @param {() => number} [p.ahora]  ms
 * @param {(l: string) => void} [p.log]
 * @returns {Promise<number>} código de salida
 */
export async function alta({ codigo, raizRepo = process.cwd(), base = URL_BASE, gh: binGh = "gh", fetch: f = globalThis.fetch, ahora = () => Date.now(), log = (l) => process.stdout.write(l + "\n") }) {
  raizRepo = resolve(raizRepo);
  codigo = String(codigo ?? "").trim();
  if (!PATRON_CODIGO.test(codigo)) {
    log("Ese código no tiene la forma que esperamos. Cópialo otra vez desde tu panel, entero.");
    return 2;
  }
  try {
    base = validarBase(base);
  } catch {
    log("La URL del servicio tiene que ser https.");
    return 2;
  }

  let config;
  try {
    config = cargarConfig(raizRepo);
  } catch (e) {
    log(`No se puede leer la configuración: ${e.message}`);
    return 2;
  }
  const revocado = join(raizRepo, ".tranquiseo", "revocado.json");
  if (config.sitioId && !existsSync(revocado)) {
    // Re-alta o rotación: el desafío HTTP de `sitio.conectar` no lo puede contestar una web estática.
    log("Esta web ya está conectada. Para volver a empezar, da de baja primero: `npx github:tranquiseo/conector-astro baja`.");
    return 2;
  }

  const gh = crearGh(binGh, raizRepo);
  const repo = repoDeGh(gh);
  if (!repo.ok) {
    log(repo.mensaje);
    return 2;
  }
  const usuario = gh(["api", "user", "--jq", ".login"]);
  const login = usuario.salida.trim();
  if (usuario.codigo !== 0 || !/^[A-Za-z0-9-]{1,39}$/.test(login)) {
    log("No se ha podido saber con qué usuario de GitHub has iniciado sesión (`gh api user`).");
    return 2;
  }
  if (repo.publico) {
    log("Aviso: el repo es público. Lo que el conector guarda en .tranquiseo/ y los registros de Actions también lo serán (sin contenido ni secretos). Y GitHub desactiva los workflows programados de un repo público tras 60 días sin actividad.");
  }

  // Lo que viaja en el alta, además de la pública.
  const sitio = new Sitio(raizRepo, { config, ahora });
  const caps = capacidades(sitio, new Motor(sitio).verbos());
  const entorno = { plataforma: "astro", astro: versionAstro(sitio), node: process.versions.node, plugin: VERSION_CONECTOR };

  // El par: en memoria. La semilla en texto solo existe para pasarla por stdin a gh.
  const par = generarPar();
  const segundos = Math.floor(ahora() / 1000);
  const prueba = pruebaDePosesion({ publica: par.publica, privada: par.privada, homeUrl: config.homeUrl, codigo, ahora: segundos });

  const guardado = gh(["secret", "set", SECRETO, "--repo", repo.repo], { entrada: semillaB64(par.privada) });
  if (guardado.codigo !== 0) {
    log(`No se ha podido guardar la clave como secreto del repo (hace falta permiso de administración en ${repo.repo}). No se ha conectado nada.`);
    const detalle = filtrarLog(guardado.error).trim().split("\n")[0];
    if (detalle) log(`  gh: ${detalle.slice(0, 300)}`);
    return 1;
  }
  const deshacerSecreto = () => gh(["secret", "delete", SECRETO, "--repo", repo.repo]);

  const peticion = {
    codigo,
    clave_publica: par.publica,
    prueba,
    home_url: config.homeUrl,
    site_url: config.homeUrl,
    entorno,
    capacidades: caps,
    autorizado_por: { usuario_login: login, fecha: fechaC(ahora()) },
  };

  let respuesta;
  try {
    respuesta = await f(`${base}/alta`, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(20000),
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": `Tranquiseo-Conector/${VERSION_CONECTOR}; ${config.homeUrl}` },
      body: JSON.stringify(peticion),
    });
  } catch {
    deshacerSecreto();
    log("No hemos podido hablar con Tranquiseo. Inténtalo otra vez en un minuto; si sigue igual, escríbenos.");
    return 1;
  }
  let cuerpo = null;
  if (respuesta.status === 200) {
    try {
      cuerpo = JSON.parse((await respuesta.text()).slice(0, 65536));
    } catch {
      cuerpo = null;
    }
  } else {
    await respuesta.body?.cancel().catch(() => {});
  }
  if (respuesta.status !== 200 || !cuerpo || typeof cuerpo !== "object") {
    deshacerSecreto();
    log(RECHAZADO);
    return 1;
  }
  const valida = validarRespuesta(cuerpo);
  if (!valida) {
    deshacerSecreto();
    log(RESPUESTA_INVALIDA);
    return 1;
  }

  // Estado del repo: sitio_id y públicas de operación. Reconectar borra `revocado.json`.
  const dirEstado = join(raizRepo, ".tranquiseo");
  if (existsSync(dirEstado) && lstatSync(dirEstado).isSymbolicLink()) {
    log(".tranquiseo no puede ser un enlace simbólico.");
    return 1;
  }
  mkdirSync(dirEstado, { recursive: true });
  escribirAtomico(join(dirEstado, "publicas.json"), JSON.stringify({ operacion: valida.publicas }) + "\n");
  if (existsSync(revocado)) rmSync(revocado, { force: true });
  fijarSitioId(raizRepo, valida.sitioId);

  log(`Conectado. Sitio ${valida.sitioId}; la clave está guardada como secreto ${SECRETO} de ${repo.repo}.`);
  const rutaWf = join(raizRepo, ".github", "workflows", WORKFLOW);
  const anadir = [NOMBRE, ".tranquiseo"];
  if (!existsSync(rutaWf)) {
    // Lo pone la CLI, en la máquina del cliente y a petición suya; el conector (la Action) nunca
    // toca `.github/`.
    mkdirSync(join(raizRepo, ".github", "workflows"), { recursive: true });
    writeFileSync(rutaWf, readFileSync(EJEMPLO_WORKFLOW, "utf8"), { flag: "wx" });
    anadir.push(`.github/workflows/${WORKFLOW}`);
    log(`He añadido el workflow en .github/workflows/${WORKFLOW} (cada 30 minutos; revísalo antes de subirlo).`);
  }
  log("Ahora confirma y sube el alta:");
  log(`  git add ${anadir.join(" ")} && git commit -m "Tranquiseo: alta" && git push`);
  return 0;
}
