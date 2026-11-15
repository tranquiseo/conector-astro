// La CLI habla con GitHub a través de `gh` (la sesión del propio cliente): así no pedimos ni
// guardamos ningún token suyo. Siempre argv, nunca una línea de shell; el secreto, por stdin.

import { spawnSync } from "node:child_process";

/**
 * @param {string} [comando] binario de gh (en las pruebas, uno falso)
 * @param {string} cwd
 * @returns {(args: string[], o?: {entrada?: string, tope?: number}) => {codigo: number, salida: string, error: string}}
 */
export function crearGh(comando = "gh", cwd = process.cwd()) {
  return (args, { entrada, tope = 60000 } = {}) => {
    const r = spawnSync(comando, args, {
      cwd, encoding: "utf8", timeout: tope, input: entrada ?? "", maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    });
    if (r.error) return { codigo: -1, salida: "", error: r.error.code === "ENOENT" ? "gh_no_instalado" : String(r.error.code ?? "error") };
    return { codigo: r.status ?? -1, salida: r.stdout ?? "", error: r.stderr ?? "" };
  };
}

/** Comprobaciones comunes: sesión iniciada y repo de GitHub. */
export function repoDeGh(gh) {
  const sesion = gh(["auth", "status"]);
  if (sesion.error === "gh_no_instalado") return { ok: false, mensaje: "Hace falta la CLI de GitHub (`gh`): https://cli.github.com" };
  if (sesion.codigo !== 0) return { ok: false, mensaje: "Inicia sesión en GitHub con `gh auth login` y vuelve a probar." };
  const v = gh(["repo", "view", "--json", "nameWithOwner,visibility,defaultBranchRef"]);
  let datos = null;
  try {
    datos = JSON.parse(v.salida);
  } catch {
    datos = null;
  }
  const repo = datos?.nameWithOwner;
  if (v.codigo !== 0 || typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split("/").some((s) => /^\.+$/.test(s))) {
    return { ok: false, mensaje: "Esta carpeta no parece un repo de GitHub. Ejecuta la orden dentro del repo de la web." };
  }
  const rama = typeof datos.defaultBranchRef?.name === "string" && /^[A-Za-z0-9._\/-]{1,200}$/.test(datos.defaultBranchRef.name) ? datos.defaultBranchRef.name : "main";
  return { ok: true, repo, rama, publico: String(datos.visibility ?? "").toUpperCase() === "PUBLIC" };
}
