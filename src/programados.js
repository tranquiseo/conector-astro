// Contenido programado (spec §9.4): `estado:'future'` vive como `_slug.md` y su fecha en
// `.tranquiseo/programados.json` (`{"<id>": "Y-m-d H:i:s" UTC}`). Cada ejecución publica los vencidos
// ANTES de consultar al core. El ciclo compila y hace commit; si el build rompe, deshace.

import { join, dirname } from "node:path";
import { moverFichero } from "./contenido/escribir.js";
import { formatoUtc } from "./util/fechas.js";

const FICHERO = "programados.json";
// Un programado que lleva más de esto vencido sin publicarse se ha atascado (lo normal: la rama no
// admite el push y el contador de fallos no puede guardarse). Se deja de compilar por él en cada
// cron (J8, M7); lo desatasca una orden del core (`content.update` con `estado: publish`).
export const MAX_RETRASO_PROGRAMADO_MS = 72 * 3600 * 1000;

export class Programados {
  constructor(almacen) {
    this.almacen = almacen;
    this.datos = almacen.leer(FICHERO, {});
    this.cambiado = false;
  }

  fijar(id, fechaUtc) {
    this.datos[String(id)] = fechaUtc;
    this.cambiado = true;
  }

  quitar(id) {
    if (Object.hasOwn(this.datos, String(id))) {
      delete this.datos[String(id)];
      this.cambiado = true;
    }
  }

  fecha(id) {
    return this.datos[String(id)] ?? null;
  }

  vencidos(ahoraMs) {
    const ahora = formatoUtc(new Date(ahoraMs));
    return Object.entries(this.datos).filter(([, f]) => f <= ahora).map(([id]) => Number(id)).sort((a, b) => a - b);
  }

  guardar() {
    if (this.cambiado) this.almacen.escribir(FICHERO, this.datos);
    this.cambiado = false;
  }
}

/**
 * Publica los programados vencidos: `_slug.md` → `slug.md` y estado `publish` en ids.json.
 * @returns {{publicados: number[], avisos: string[]}}
 */
export function publicarVencidos(sitio, programados) {
  const publicados = [];
  const avisos = [];
  // Entrega controlada (M1, Fable N4): publicar un programado es escribir. Se queda con su fecha
  // y sale en cuanto se quite la opción.
  if (sitio.config.escrituras === false) {
    if (programados.vencidos(sitio.ahora()).length > 0) avisos.push("programados_en_espera:entrega_controlada");
    return { publicados, avisos };
  }
  for (const id of programados.vencidos(sitio.ahora())) {
    const fecha = Date.parse(programados.fecha(id).replace(" ", "T") + "Z");
    if (Number.isFinite(fecha) && sitio.ahora() - fecha > MAX_RETRASO_PROGRAMADO_MS) {
      avisos.push(`programado_atascado:${id}`);
      continue;
    }
    const c = sitio.contenido(id);
    if (!c || c.estado !== "future") {
      // Ya no existe o alguien lo cambió a mano: se olvida la fecha.
      programados.quitar(id);
      continue;
    }
    if (c.col.borradores?.modo !== "prefijo") {
      avisos.push(`programado_sin_prefijo:${id}`);
      programados.quitar(id);
      continue;
    }
    const destino = join(dirname(c.abs), `${c.slug}.md`);
    try {
      moverFichero(sitio, c.abs, destino);
    } catch {
      avisos.push(`programado_no_publicado:${id}`);
      continue;
    }
    sitio.ids.actualizar(id, { ruta: sitio.rutaRepo(destino), estado: undefined });
    programados.quitar(id);
    publicados.push(id);
    sitio.invalidar();
  }
  return { publicados, avisos };
}
