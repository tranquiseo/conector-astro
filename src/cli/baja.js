// `npx github:tranquiseo/conector-astro baja` (spec §10). La privada solo vive en GitHub Secrets, que no
// se pueden leer desde fuera, así que el aviso firmado lo manda la propia Action:
//
//   1. `gh workflow run tranquiseo.yml -f accion=baja` → la Action manda `/conector/baja` firmado y
//      commitea `.tranquiseo/revocado.json`.
//   2. Se espera a que esa ejecución acabe (necesita el secreto: borrarlo antes la dejaría sin firma).
//   3. `gh secret delete` y `gh workflow disable`: sin clave y sin cron, el sitio deja de gastar
//      minutos y no puede firmar nada más.
//
// `--forzar` se salta 1-2 (por ejemplo, si el workflow está roto): corta en local y avisa de que el
// sitio hay que revocarlo también desde el panel.

import { resolve } from "node:path";
import { crearGh, repoDeGh } from "./gh.js";
import { SECRETO, WORKFLOW } from "./alta.js";

/**
 * @param {object} p
 * @param {string} [p.raizRepo]
 * @param {string} [p.gh]
 * @param {boolean} [p.forzar]
 * @param {{cada?: number, tope?: number}} [p.espera]  ms
 * @param {() => number} [p.ahora] ms
 * @param {(ms: number) => Promise<void>} [p.dormir]
 * @param {(l: string) => void} [p.log]
 * @returns {Promise<number>}
 */
export async function baja({ raizRepo = process.cwd(), gh: binGh = "gh", forzar = false, espera = {}, ahora = () => Date.now(), dormir = (ms) => new Promise((r) => setTimeout(r, ms)), log = (l) => process.stdout.write(l + "\n") } = {}) {
  const gh = crearGh(binGh, resolve(raizRepo));
  const repo = repoDeGh(gh);
  if (!repo.ok) {
    log(repo.mensaje);
    return 2;
  }
  const cada = espera.cada ?? 5000;
  const tope = espera.tope ?? 10 * 60 * 1000;

  if (!forzar) {
    const inicio = ahora();
    const lanzado = gh(["workflow", "run", WORKFLOW, "--repo", repo.repo, "--ref", repo.rama, "-f", "accion=baja"]);
    if (lanzado.codigo !== 0) {
      log(`No se ha podido lanzar el workflow ${WORKFLOW}. Comprueba que existe y está activo; si quieres cortar igualmente: \`baja --forzar\`.`);
      return 1;
    }
    log("Dando de baja: esperando a que la Action avise a Tranquiseo…");
    let ejecucion = null;
    while (ahora() - inicio <= tope) {
      const l = gh(["run", "list", "--repo", repo.repo, "--workflow", WORKFLOW, "--event", "workflow_dispatch", "--limit", "5", "--json", "databaseId,status,conclusion,createdAt"]);
      let runs = [];
      try {
        runs = JSON.parse(l.salida);
      } catch {
        runs = [];
      }
      // La nuestra: la más reciente creada desde que la lanzamos (30 s de margen por relojes).
      const candidatas = (Array.isArray(runs) ? runs : []).filter((r) => r && Date.parse(r.createdAt) >= inicio - 30000)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      ejecucion = candidatas[0] ?? null;
      if (ejecucion && ejecucion.status === "completed") break;
      await dormir(cada);
    }
    if (!ejecucion || ejecucion.status !== "completed") {
      log("La ejecución de baja no ha terminado a tiempo. No se ha borrado nada: mira la pestaña Actions y vuelve a lanzar `baja` cuando acabe.");
      return 1;
    }
    if (ejecucion.conclusion !== "success") {
      log("La ejecución de baja ha fallado (mira la pestaña Actions). No se ha borrado nada; si quieres cortar igualmente: `baja --forzar`.");
      return 1;
    }
  } else {
    log("Baja forzada: no se avisa a Tranquiseo desde la web. Revoca también el sitio desde tu panel.");
  }

  const borrado = gh(["secret", "delete", SECRETO, "--repo", repo.repo]);
  const parado = gh(["workflow", "disable", WORKFLOW, "--repo", repo.repo]);
  if (borrado.codigo !== 0) log(`No se ha podido borrar el secreto ${SECRETO}: bórralo a mano en Settings → Secrets and variables → Actions.`);
  if (parado.codigo !== 0) log(`No se ha podido desactivar el workflow ${WORKFLOW}: desactívalo a mano en la pestaña Actions.`);
  if (borrado.codigo !== 0 || parado.codigo !== 0) return 1;
  log("Baja hecha: secreto borrado y workflow desactivado. Haz `git pull` para traerte el commit de la baja.");
  return 0;
}
