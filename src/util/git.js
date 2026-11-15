// Lo mínimo de git que necesitan los verbos de lectura. argv siempre, nunca una línea de shell.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

// El build del cliente corre en el mismo job (J8, hallazgo grave): todo git va sin configuración
// global ni de sistema, sin hooks y sin fsmonitor, para que nada que el build escriba fuera de
// `.git/config` se ejecute o redirija el push. Lo que sí escriba en `.git/` lo detecta `huellaGit`.
const ENDURECIDO = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

// Segunda pasada Fable (J8, 1): `git` por PATH lo podía sustituir el build (un `git` falso en el bin
// del toolcache de Node). La ruta absoluta se fija en la PRIMERA llamada, que el ciclo hace antes de
// ejecutar nada del cliente, y los hijos de git llevan un PATH propio, no el heredado.
let binGit = null;
let pathGit = null;
function resolverGit() {
  if (binGit) return binGit;
  for (const dir of String(process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const c = join(dir, "git");
    try {
      accessSync(c, constants.X_OK);
      if (!statSync(c).isFile()) continue;
      binGit = realpathSync(c);
      pathGit = [dirname(binGit), "/usr/bin", "/bin"].join(delimiter);
      return binGit;
    } catch { /* siguiente */ }
  }
  throw new Error("git_no_encontrado");
}
/** Ruta absoluta del git que se usa (fijada en la primera llamada). */
export const rutaGit = () => resolverGit();

const ENTORNO = () => ({
  PATH: (resolverGit(), pathGit), HOME: process.env.HOME, LANG: "C", GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
});

/**
 * Claves de la config LOCAL que el conector no admite al arrancar (segunda pasada, 3): un `include`
 * trae ficheros que la huella no ve, y un `extraheader` previo es una credencial persistida.
 * @returns {string[]} claves problemáticas
 */
export function configLocalInsegura(raizRepo) {
  let salida = "";
  try {
    salida = git(raizRepo, ["config", "--local", "--name-only", "--list"]);
  } catch {
    return [];
  }
  return salida.split("\n").map((l) => l.trim().toLowerCase()).filter((k) => /^include\.|^includeif\.|extraheader$|^credential\.|^url\..*\.(insteadof|pushinsteadof)$|^http\.proxy$|^core\.(sshcommand|gitproxy)$/.test(k));
}

export function git(cwd, args, { tope = 15000, entrada } = {}) {
  return execFileSync(resolverGit(), [...ENDURECIDO, ...args], {
    cwd, encoding: "utf8", timeout: tope, input: entrada, maxBuffer: 32 * 1024 * 1024,
    env: ENTORNO(),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Huella de lo que, dentro de `.git`, puede ejecutar código o desviar un push: `config` (alias,
 * filtros, `insteadOf`, `sshCommand`, `include`), `hooks/`, `info/`, `HEAD` y que `.git` sea un
 * directorio de verdad (no un fichero `gitdir:` ni un enlace). Se toma antes de cualquier código
 * del cliente y se compara antes de cada `add`/`commit`/`push`.
 * @returns {string}
 */
export function huellaGit(raizRepo) {
  const h = createHash("sha256");
  const dirGit = join(raizRepo, ".git");
  const st = lstatSync(dirGit, { throwIfNoEntry: false });
  h.update(`git:${st ? (st.isDirectory() ? "dir" : st.isSymbolicLink() ? "enlace" : "fichero") : "no"}\0`);
  if (!st || !st.isDirectory()) return h.digest("hex");
  const meter = (rel, prof = 0) => {
    const abs = join(dirGit, rel);
    const s = lstatSync(abs, { throwIfNoEntry: false });
    if (!s) { h.update(`${rel}:no\0`); return; }
    if (s.isSymbolicLink()) { h.update(`${rel}:enlace:${readlinkSync(abs)}\0`); return; }
    if (s.isDirectory()) {
      h.update(`${rel}:dir\0`);
      if (prof > 4) return;
      for (const n of readdirSync(abs).sort()) meter(join(rel, n), prof + 1);
      return;
    }
    h.update(`${rel}:${s.mode}:`);
    h.update(readFileSync(abs));
    h.update("\0");
  };
  for (const rel of ["config", "HEAD", "commondir", "hooks", "info"]) meter(rel);
  return h.digest("hex");
}

/**
 * Como `git`, pero sin lanzar: devuelve el código y la salida. `extra` añade variables de entorno
 * (p. ej. la cabecera del token SOLO para el push, vía GIT_CONFIG_*: nunca en argv).
 * @returns {{codigo: number, salida: string}}
 */
export function gitR(cwd, args, { tope = 120000, extra = {} } = {}) {
  const r = spawnSync(resolverGit(), [...ENDURECIDO, ...args], {
    cwd, encoding: "utf8", timeout: tope, maxBuffer: 32 * 1024 * 1024,
    env: { ...ENTORNO(), GIT_LITERAL_PATHSPECS: "1", ...extra },
  });
  return { codigo: r.status ?? -1, salida: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Commits que tocaron un fichero (siguiendo renombres), del más nuevo al más viejo. */
export function historial(cwd, rutaRepo, max = 200) {
  let salida;
  try {
    salida = git(cwd, ["log", "--follow", `--max-count=${max}`, "--format=%H%x09%cI", "--", rutaRepo]);
  } catch {
    return [];
  }
  return salida.split("\n").filter(Boolean).map((l) => {
    const [sha, fecha] = l.split("\t");
    return { sha, fecha };
  });
}

/**
 * Ruta que tenía el fichero en cada commit de su historia (siguiendo renombres).
 * @returns {Map<string, string>} sha → ruta en ese commit
 */
export function rutasEnHistoria(cwd, rutaRepo, max = 200) {
  const mapa = new Map();
  let salida;
  try {
    salida = git(cwd, ["log", "--follow", `--max-count=${max}`, "--format=%x00%H", "--name-only", "-z", "--", rutaRepo]);
  } catch {
    return mapa;
  }
  // Con -z: "\0<sha>\0\n<ruta>\0" por commit (en un renombre, la ruta nueva).
  let sha = null;
  for (const trozo of salida.split("\0")) {
    if (/^[0-9a-f]{40}$/.test(trozo)) sha = trozo;
    else if (sha && trozo.trim() !== "" && !mapa.has(sha)) mapa.set(sha, trozo.replace(/^\n+/, ""));
  }
  return mapa;
}

/** Contenido de un fichero en un commit, o null. */
export function ficheroEnCommit(cwd, sha, rutaRepo) {
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  try {
    return git(cwd, ["show", `${sha}:${rutaRepo}`]);
  } catch {
    return null;
  }
}

/** Id entero de una revisión: los 13 primeros hex del commit (52 bits, cabe en un número JSON). */
export function idDeCommit(sha) {
  return parseInt(sha.slice(0, 13), 16);
}
