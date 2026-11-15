// El motor (`Verbos/Motor.php`): verbo desconocido → rechazo; esquema cerrado; capacidad que
// falta → `tranquiseo_no_disponible` con capacidad, motivo y remedio (degradar, nunca reventar).
// No sabe por dónde llegó la orden: lo mismo vale para el ciclo de la Action y para los tests.

import { ErrorVerbo } from "../errores.js";
import { validar } from "./esquema.js";
import { catalogo as catalogoLectura } from "./lectura.js";
import { catalogo as catalogoEscritura } from "./escritura.js";
import { catalogo as catalogoMedios } from "./medios.js";
import { catalogo as catalogoRedirecciones } from "./redirecciones.js";
import { ENTREGA_CONTROLADA, NO_DISPONIBLES, REMEDIOS_REDIRECCIONES, redirecciones } from "../capacidades.js";
import { sanearHtml } from "../contenido/html.js";
import { validarSchema } from "../contenido/schema.js";
import { Registro } from "../estado/registros.js";
import { Programados } from "../programados.js";

export function catalogo() {
  return { ...catalogoLectura(), ...catalogoEscritura(), ...catalogoMedios(), ...catalogoRedirecciones() };
}

function ctxEsquema(sitio) {
  return { zona: sitio.config.zona, html: sanearHtml, schema: validarSchema };
}

function capacidadQueFalta(sitio, definicion) {
  if (definicion.necesita === "redirecciones") {
    const r = redirecciones(sitio);
    if (r.escribible) return null;
    return {
      capacidad: "redirecciones", motivo: r.motivo, mensaje: "Este sitio no puede gestionar redirecciones ahora mismo.",
      remedio: REMEDIOS_REDIRECCIONES[r.motivo] ?? "Escríbenos y lo miramos.",
    };
  }
  return null;
}

export class Motor {
  /**
   * @param {import('../sitio.js').Sitio} sitio
   * @param {{registro?: Registro, programados?: Programados, descargas?: Map<string, Buffer|Error>, hostsMedios?: string[]}} [estado]
   *   el ciclo pasa los suyos; `descargas` son las imágenes por URL ya bajadas por el despacho.
   */
  constructor(sitio, estado = {}) {
    this.sitio = sitio;
    this.registro = estado.registro ?? new Registro(sitio.almacen);
    this.programados = estado.programados ?? new Programados(sitio.almacen);
    this.descargas = estado.descargas ?? new Map();
    this.hostsMedios = estado.hostsMedios ?? null;
    this.orden = null;
  }

  esLectura(verbo) {
    return catalogo()[verbo]?.tipo === "lectura";
  }

  verbos() {
    return [...Object.keys(catalogo()), ...Object.keys(NO_DISPONIBLES)].filter((v, i, a) => a.indexOf(v) === i).sort();
  }

  /** Verbos que escriben (los que bloquea la entrega controlada). */
  escrituras() {
    return Object.entries(catalogo()).filter(([, d]) => d.tipo === "escritura").map(([v]) => v).sort();
  }

  definicion(verbo) {
    return catalogo()[verbo] ?? null;
  }

  /**
   * @returns {{ok: true, resultado: any} | {ok: false, error: {codigo: string, mensaje: string, datos: object}}}
   */
  ejecutar(verbo, argumentos = {}, { orden = null } = {}) {
    this.orden = orden;
    try {
      return { ok: true, resultado: this.#ejecutar(verbo, argumentos) };
    } catch (e) {
      if (e instanceof ErrorVerbo) return { ok: false, error: e.aJson() };
      return { ok: false, error: { codigo: "tranquiseo_excepcion", mensaje: "El verbo ha fallado de forma inesperada.", datos: { detalle: e?.constructor?.name ?? "Error" } } };
    }
  }

  #ejecutar(verbo, argumentos) {
    const cat = catalogo();
    if (typeof verbo !== "string" || !Object.hasOwn(cat, verbo)) {
      if (typeof verbo === "string" && Object.hasOwn(NO_DISPONIBLES, verbo)) {
        const nd = NO_DISPONIBLES[verbo];
        throw new ErrorVerbo("tranquiseo_no_disponible", "Esta web no puede hacer eso.", { capacidad: verbo, motivo: nd.motivo, remedio: nd.remedio });
      }
      throw new ErrorVerbo("tranquiseo_verbo_desconocido", `El verbo ${String(verbo).slice(0, 80)} no existe.`);
    }
    const definicion = cat[verbo];
    // Segunda barrera de la entrega controlada (G1, Fable N4): por aquí no sale ninguna escritura.
    if (definicion.tipo === "escritura" && this.sitio.config.escrituras === false) {
      throw new ErrorVerbo("tranquiseo_no_disponible", "Esta web está en entrega controlada: no se escribe nada sin el visto bueno de su responsable.",
        { capacidad: verbo, ...ENTREGA_CONTROLADA });
    }
    const limpios = validar(definicion.esquema, argumentos ?? {}, ctxEsquema(this.sitio));
    const falta = capacidadQueFalta(this.sitio, definicion);
    if (falta) {
      throw new ErrorVerbo("tranquiseo_no_disponible", falta.mensaje, { capacidad: falta.capacidad, motivo: falta.motivo, remedio: falta.remedio });
    }
    return definicion.ejecutar(this.sitio, limpios, this);
  }
}
