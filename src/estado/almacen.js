// Lectura y escritura de `.tranquiseo/`. JSON con claves ordenadas y salto de línea final, para
// que los diffs del repo del cliente se lean bien. JSONL: una línea por evento, solo se añade.

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, lstatSync, renameSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export const CARPETA = ".tranquiseo";

function ordenar(valor) {
  if (Array.isArray(valor)) return valor.map(ordenar);
  if (valor && typeof valor === "object") {
    const salida = {};
    for (const k of Object.keys(valor).sort()) salida[k] = ordenar(valor[k]);
    return salida;
  }
  return valor;
}

export function jsonEstable(valor) {
  return JSON.stringify(ordenar(valor), null, 2) + "\n";
}

export class Almacen {
  /** @param {string} raizRepo */
  constructor(raizRepo) {
    this.raizRepo = resolve(raizRepo);
    this.dir = join(this.raizRepo, CARPETA);
  }

  ruta(nombre) {
    if (!/^[a-z0-9-]+\.(json|jsonl)$/.test(nombre)) throw new TypeError("nombre_de_estado_invalido");
    const r = join(this.dir, nombre);
    if (!r.startsWith(this.dir + sep)) throw new TypeError("nombre_de_estado_invalido");
    return r;
  }

  #comprobarNoEnlace(r) {
    // Un enlace simbólico plantado en .tranquiseo/ haría escribir fuera: no se sigue nunca.
    for (const p of [this.dir, r]) {
      if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error("estado_es_enlace_simbolico");
    }
  }

  leer(nombre, defecto) {
    const r = this.ruta(nombre);
    this.#comprobarNoEnlace(r);
    if (!existsSync(r)) return structuredClone(defecto);
    try {
      return JSON.parse(readFileSync(r, "utf8"));
    } catch {
      throw new Error(`estado_ilegible:${nombre}`);
    }
  }

  escribir(nombre, valor) {
    const r = this.ruta(nombre);
    mkdirSync(dirname(r), { recursive: true });
    this.#comprobarNoEnlace(r);
    const tmp = r + ".tmp";
    writeFileSync(tmp, jsonEstable(valor));
    renameSync(tmp, r);
  }

  leerLineas(nombre) {
    const r = this.ruta(nombre);
    this.#comprobarNoEnlace(r);
    if (!existsSync(r)) return [];
    const salida = [];
    for (const linea of readFileSync(r, "utf8").split("\n")) {
      if (linea.trim() === "") continue;
      try {
        salida.push(JSON.parse(linea));
      } catch {
        // Una línea rota no tumba el resto (p. ej. un merge a mano del cliente).
      }
    }
    return salida;
  }

  anadirLinea(nombre, valor) {
    const r = this.ruta(nombre);
    mkdirSync(dirname(r), { recursive: true });
    this.#comprobarNoEnlace(r);
    appendFileSync(r, JSON.stringify(ordenar(valor)) + "\n");
  }

  reescribirLineas(nombre, valores) {
    const r = this.ruta(nombre);
    mkdirSync(dirname(r), { recursive: true });
    this.#comprobarNoEnlace(r);
    const tmp = r + ".tmp";
    writeFileSync(tmp, valores.map((v) => JSON.stringify(ordenar(v)) + "\n").join(""));
    renameSync(tmp, r);
  }
}
