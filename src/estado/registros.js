// Idempotencia de órdenes, registro de escrituras, nonces y públicas de operación.
// Todo en `.tranquiseo/`, que viaja en el mismo commit que el cambio.

import { createHash } from "node:crypto";
import { publicaDesdeB64 } from "../cripto/claves.js";

const DIA = 86400;
export const RETENCION_ORDENES = 30 * DIA;
export const RETENCION_REGISTRO = 365 * DIA;

// Despacho::ERRORES_TRANSITORIOS del plugin + los propios de Astro (spec §3.1). No se guardan en la
// idempotencia: la reentrega del core tiene que volver a ejecutar la orden.
export const ERRORES_TRANSITORIOS = Object.freeze([
  "tranquiseo_no_disponible",
  "tranquiseo_descarga_fallida",
  "tranquiseo_excepcion",
  "tranquiseo_sin_registro",
  "tranquiseo_redireccion_fallida",
  "tranquiseo_tope_destructivas",
  "tranquiseo_build_fallido",
  "tranquiseo_push_fallido",
  "tranquiseo_ruta_prohibida",
]);

export class Ordenes {
  constructor(almacen) {
    this.almacen = almacen;
    this.lineas = almacen.leerLineas("ordenes.jsonl");
  }

  /** La idempotencia se mira ANTES de ejecutar. */
  buscar(id, ahora) {
    for (let i = this.lineas.length - 1; i >= 0; i--) {
      const l = this.lineas[i];
      if (l.id === id && ahora - l.en <= RETENCION_ORDENES) return l;
    }
    return null;
  }

  /**
   * @param {{id:string, verbo:string, ok:boolean, resultado?:any, error?:any}} salida
   * @param {boolean} esLectura  Las lecturas guardan solo un hash (repos públicos, spec §12).
   */
  guardar(salida, ahora, esLectura = false) {
    if (!salida.ok && ERRORES_TRANSITORIOS.includes(salida.error?.codigo)) return false;
    const linea = { id: salida.id, verbo: salida.verbo, en: ahora, ok: salida.ok };
    if (salida.ok) {
      if (esLectura) linea.hash = createHash("sha256").update(JSON.stringify(salida.resultado ?? null)).digest("hex");
      else linea.resultado = salida.resultado;
    } else linea.error = salida.error;
    this.lineas.push(linea);
    this.almacen.anadirLinea("ordenes.jsonl", linea);
    return true;
  }

  podar(ahora) {
    const antes = this.lineas.length;
    this.lineas = this.lineas.filter((l) => ahora - l.en <= RETENCION_ORDENES);
    if (this.lineas.length !== antes) this.almacen.reescribirLineas("ordenes.jsonl", this.lineas);
    return antes - this.lineas.length;
  }
}

export class Registro {
  constructor(almacen) {
    this.almacen = almacen;
    this.lineas = almacen.leerLineas("registro.jsonl");
  }

  anotar({ orden, verbo, id, ruta, anterior, nuevo, destructiva = false }, ahora) {
    const linea = { en: ahora, orden, verbo, id: id ?? null, ruta: ruta ?? null, anterior: anterior ?? null, nuevo: nuevo ?? null };
    if (destructiva) linea.destructiva = true;
    this.lineas.push(linea);
    this.almacen.anadirLinea("registro.jsonl", linea);
  }

  /** Marca de tope (`Despacho::anotar_destructiva`): solo si la orden salió bien. */
  anotarDestructiva(orden, verbo, ahora) {
    const linea = { en: ahora, orden, verbo, id: null, ruta: null, anterior: null, nuevo: null, destructiva: true };
    this.lineas.push(linea);
    this.almacen.anadirLinea("registro.jsonl", linea);
  }

  destructivasUltimaHora(ahora) {
    const ordenes = new Set();
    for (const l of this.lineas) if (l.destructiva && ahora - l.en < 3600) ordenes.add(l.orden);
    return ordenes.size;
  }

  podar(ahora) {
    const antes = this.lineas.length;
    this.lineas = this.lineas.filter((l) => ahora - l.en <= RETENCION_REGISTRO);
    if (this.lineas.length !== antes) this.almacen.reescribirLineas("registro.jsonl", this.lineas);
  }
}

export class Nonces {
  constructor(almacen) {
    this.almacen = almacen;
    this.datos = almacen.leer("nonces.json", {});
    this.cambiado = false;
  }

  consumir(nonce, dominio, caducaEn, ahora) {
    const clave = `${dominio}:${nonce}`;
    for (const [k, c] of Object.entries(this.datos)) if (c < ahora) delete this.datos[k];
    if (Object.hasOwn(this.datos, clave)) return false;
    this.datos[clave] = caducaEn;
    this.cambiado = true;
    return true;
  }

  guardar() {
    if (this.cambiado) this.almacen.escribir("nonces.json", this.datos);
    this.cambiado = false;
  }
}

export class Publicas {
  constructor(almacen) {
    this.almacen = almacen;
    const datos = almacen.leer("publicas.json", { operacion: [] });
    this.lista = Array.isArray(datos.operacion) ? datos.operacion.filter((p) => publicaDesdeB64(p)) : [];
  }

  /** `control.publicas_operacion`: cada pública que no mida 32 bytes se descarta; vacía no sustituye. */
  reemplazar(lista) {
    if (!Array.isArray(lista)) return false;
    const validas = [...new Set(lista.filter((p) => typeof p === "string" && publicaDesdeB64(p)))].slice(0, 4);
    if (validas.length === 0) return false;
    this.lista = validas;
    this.almacen.escribir("publicas.json", { operacion: validas });
    return true;
  }
}
