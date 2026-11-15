// El equivalente a `WP_Error` del plugin: código `tranquiseo_*`, mensaje y datos. El motor lo
// convierte en `{codigo, mensaje, datos}` (forma de `Despacho::fallo()`).

export class ErrorVerbo extends Error {
  /**
   * @param {string} codigo
   * @param {string} mensaje
   * @param {object} [datos]
   */
  constructor(codigo, mensaje, datos = {}) {
    super(mensaje);
    this.codigo = codigo;
    this.datos = datos && typeof datos === "object" && !Array.isArray(datos) ? datos : {};
  }

  aJson() {
    return { codigo: this.codigo, mensaje: this.message, datos: this.datos };
  }
}
