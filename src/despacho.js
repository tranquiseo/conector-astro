// El despacho, copia de `Transporte/Despacho.php`: recibe un sobre de orden YA VERIFICADO, ejecuta
// cada orden (idempotencia → argumentos con nombre → tope de destructivas → motor), aplica el
// control y devuelve el cuerpo del resultado. No sabe nada de git ni del build: eso es del ciclo.

import { ErrorVerbo } from "./errores.js";
import { ERRORES_TRANSITORIOS } from "./estado/registros.js";
import { capacidades, ENTREGA_CONTROLADA } from "./capacidades.js";
import { VERSION_CONECTOR } from "./sitio.js";
import { normalizarUrl } from "./cripto/sobre.js";
import { mismoHost, hostDe } from "./verbos/redirecciones.js";
import { descargarMedio, validarUrlMedio } from "./verbos/medios.js";

export const MAX_ORDENES = 5; // Saliente::MAX_ORDENES
const PATRON_ORDEN_ID = /^[A-Za-z0-9._-]{1,64}$/;

function fallo(id, verbo, codigo, mensaje, datos = {}) {
  return { id, verbo, ok: false, error: { codigo, mensaje, datos } };
}

export class Despacho {
  /**
   * @param {object} p
   * @param {import('./sitio.js').Sitio} p.sitio
   * @param {import('./verbos/motor.js').Motor} p.motor
   * @param {import('./estado/registros.js').Ordenes} p.ordenes
   * @param {import('./estado/registros.js').Publicas} p.publicas
   * @param {() => object} [p.transporte] resumen del transporte para `estado`
   */
  constructor({ sitio, motor, ordenes, publicas, transporte = () => ({}) }) {
    this.sitio = sitio;
    this.motor = motor;
    this.ordenes = ordenes;
    this.publicas = publicas;
    this.transporte = transporte;
  }

  ahora() {
    return Math.floor(this.sitio.ahora() / 1000);
  }

  /** `Despacho::es_destructiva`: se decide por lo que pide la orden, antes de validar. */
  esDestructiva(verbo, args) {
    switch (verbo) {
      case "redirects.create":
      case "content.updateSlug":
        return true;
      case "content.update":
        return args.estado !== undefined && args.estado !== "publish";
      case "seo.update":
        if (Array.isArray(args.robots) && args.robots.includes("noindex")) return true;
        if (typeof args.canonical === "string" && args.canonical !== "") {
          const h = hostDe(args.canonical);
          return !h || !mismoHost(h, hostDe(this.sitio.config.homeUrl));
        }
        return false;
      default:
        return false;
    }
  }

  /**
   * Las imágenes por URL se bajan ANTES de ejecutar (el motor es síncrono). Lo que falla queda como
   * error en `motor.descargas` y la orden lo devuelve tal cual.
   */
  async prepararDescargas(ordenes, descargar = descargarMedio) {
    // Entrega controlada: media.upload no se va a ejecutar, no se baja nada (L3).
    if (this.sitio.config.escrituras === false) return;
    for (const o of (Array.isArray(ordenes) ? ordenes : []).slice(0, MAX_ORDENES)) {
      const url = o?.verbo === "media.upload" && o?.argumentos && typeof o.argumentos.url === "string" ? o.argumentos.url : null;
      if (!url || this.motor.descargas.has(url) || this.ordenes.buscar(o.id, this.ahora())) continue;
      try {
        validarUrlMedio(url, this.motor.hostsMedios ?? undefined);
        this.motor.descargas.set(url, await descargar(url));
      } catch (e) {
        this.motor.descargas.set(url, e instanceof ErrorVerbo ? e : new ErrorVerbo("tranquiseo_descarga_fallida", "No se ha podido descargar la imagen."));
      }
    }
  }

  /**
   * @param {object} cuerpo cuerpo del sobre `orden`
   * @returns {{cuerpo: {resultados: object[], control: object, estado: object}, revocar: boolean, salidas: object[]}}
   */
  atender(cuerpo) {
    const ordenes = Array.isArray(cuerpo?.ordenes) ? cuerpo.ordenes.slice(0, MAX_ORDENES) : [];
    const control = cuerpo?.control && typeof cuerpo.control === "object" && !Array.isArray(cuerpo.control) ? cuerpo.control : {};
    const salidas = ordenes.map((o) => this.ejecutar(o));
    const aplicado = this.aplicarControl(control);
    return {
      cuerpo: { resultados: salidas.map((s) => s.salida), control: aplicado.aplicado, estado: this.estado() },
      revocar: aplicado.revocar,
      salidas,
    };
  }

  /** @returns {{salida: object, escritura: boolean, ejecutada: boolean}} */
  ejecutar(orden) {
    if (!orden || typeof orden !== "object" || typeof orden.id !== "string" || !PATRON_ORDEN_ID.test(orden.id)) {
      return { salida: fallo("", "", "tranquiseo_orden_invalida", "La orden no lleva un identificador válido."), escritura: false, ejecutada: false };
    }
    const { id } = orden;
    const verbo = typeof orden.verbo === "string" ? orden.verbo : "";
    const args = orden.argumentos && typeof orden.argumentos === "object" ? orden.argumentos : {};
    const escritura = this.motor.definicion(verbo)?.tipo === "escritura";

    // Idempotencia ANTES de nada.
    const previo = this.ordenes.buscar(id, this.ahora());
    if (previo) {
      const salida = previo.ok
        ? { id, verbo: previo.verbo, ok: true, resultado: previo.resultado ?? null, repetida: true }
        : { id, verbo: previo.verbo, ok: false, error: previo.error, repetida: true };
      // De una lectura solo se guardó el hash (repos públicos): se vuelve a ejecutar, que no cambia nada.
      if (previo.ok && previo.resultado === undefined && previo.hash) {
        // G1 (Fable N4): solo la MISMA lectura. Un id ya usado no puede colar otro verbo (y menos una escritura).
        if (verbo !== previo.verbo || !this.motor.esLectura(verbo)) {
          return { salida: fallo(id, verbo, "tranquiseo_orden_invalida", "Ese identificador de orden ya se usó para otra cosa."), escritura: false, ejecutada: false };
        }
        const r = this.motor.ejecutar(verbo, args, { orden: id });
        return { salida: r.ok ? { id, verbo, ok: true, resultado: r.resultado, repetida: true } : { id, verbo, ok: false, error: r.error, repetida: true }, escritura: false, ejecutada: false };
      }
      return { salida, escritura: false, ejecutada: false };
    }
    if (Array.isArray(orden.argumentos)) {
      return { salida: fallo(id, verbo, "tranquiseo_orden_invalida", "Los argumentos tienen que ir con nombre."), escritura: false, ejecutada: false };
    }

    // Entrega controlada: ni se escribe ni se anota (al quitar la opción, la reentrega se aplica).
    if (escritura && this.sitio.config.escrituras === false) {
      return {
        salida: fallo(id, verbo, "tranquiseo_no_disponible", "Esta web está en entrega controlada: no se escribe nada sin el visto bueno de su responsable.",
          { capacidad: verbo, ...ENTREGA_CONTROLADA }),
        escritura: false, ejecutada: false,
      };
    }

    const destructiva = this.esDestructiva(verbo, args);
    const tope = this.sitio.config.topeDestructivasHora;
    if (destructiva && this.motor.registro.destructivasUltimaHora(this.ahora()) >= tope) {
      return {
        salida: fallo(id, verbo, "tranquiseo_tope_destructivas", "Se ha alcanzado el tope de cambios delicados por hora en esta web. La orden se podrá repetir más tarde.", { tope }),
        escritura, ejecutada: false,
      };
    }

    const r = this.motor.ejecutar(verbo, args, { orden: id });
    if (destructiva && r.ok) this.motor.registro.anotarDestructiva(id, verbo, this.ahora());
    const salida = r.ok ? { id, verbo, ok: true, resultado: r.resultado } : { id, verbo, ok: false, error: r.error };
    // Lo transitorio no se guarda: la reentrega del core tiene que poder salir bien.
    this.ordenes.guardar(salida, this.ahora(), !escritura);
    return { salida, escritura, ejecutada: r.ok };
  }

  aplicarControl(control) {
    const aplicado = {};
    let revocar = false;
    if (Array.isArray(control.publicas_operacion)) aplicado.publicas_operacion = this.publicas.reemplazar(control.publicas_operacion.map(String));
    // El intervalo real lo marca el cron del workflow: se contesta el que hay, no se finge el pedido.
    if (Number.isSafeInteger(control.intervalo)) aplicado.intervalo = this.sitio.config.intervalo;
    // Una web estática no puede pintar el meta de Google desde aquí (v1).
    if (Object.hasOwn(control, "verificacion_google")) aplicado.verificacion_google = false;
    if (control.refrescar_capacidades) aplicado.refrescar_capacidades = true;
    if (control.revocar) {
      aplicado.revocar = true;
      revocar = true;
    }
    return { aplicado, revocar };
  }

  /** Lo que el core sabe de este sitio en cada contacto (`Despacho::estado`). */
  estado() {
    const cap = capacidades(this.sitio, this.motor.verbos(), this.motor.escrituras());
    return {
      plugin: VERSION_CONECTOR,
      plataforma: "astro",
      secuencia: 1,
      home_url: normalizarUrl(this.sitio.config.homeUrl),
      capacidades_en: cap.escaneado_en,
      seo: cap.seo.plugin,
      redirecciones: Boolean(cap.redirecciones.escribible),
      verificacion_google: false,
      capacidades: cap,
      transporte: this.transporte(),
      actualizacion: null,
    };
  }
}

export { ERRORES_TRANSITORIOS };
