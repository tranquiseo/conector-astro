// Ids enteros sintéticos ↔ ficheros. Así el core sigue hablando en `wp_post_id` sin migrar nada.
// Reglas: id ≥ 1, nunca reutilizado (un borrado deja la entrada marcada y el número no vuelve);
// un renombre conserva el id; los ficheros sin id reciben uno ordenados por ruta (determinista).

const FICHERO = "ids.json";
const TIPOS = new Set(["contenido", "media", "termino"]);

export class Ids {
  /** @param {import('./almacen.js').Almacen} almacen */
  constructor(almacen) {
    this.almacen = almacen;
    const datos = almacen.leer(FICHERO, { siguiente: 1, entradas: {} });
    if (!Number.isSafeInteger(datos.siguiente) || datos.siguiente < 1 || typeof datos.entradas !== "object" || datos.entradas === null) {
      throw new Error("estado_ilegible:ids.json");
    }
    this.datos = datos;
    // El contador nunca puede quedar por debajo de un id ya usado (p. ej. tras un merge a mano).
    const maximo = Math.max(0, ...Object.keys(datos.entradas).map(Number));
    if (this.datos.siguiente <= maximo) this.datos.siguiente = maximo + 1;
    this.cambiado = false;
  }

  guardar() {
    if (this.cambiado) this.almacen.escribir(FICHERO, this.datos);
    this.cambiado = false;
  }

  obtener(id) {
    const e = this.datos.entradas[String(id)];
    return e && !e.borrado ? { id: Number(id), ...e } : null;
  }

  porRuta(ruta, tipo) {
    for (const [id, e] of Object.entries(this.datos.entradas)) {
      if (!e.borrado && e.ruta === ruta && (!tipo || e.tipo === tipo)) return { id: Number(id), ...e };
    }
    return null;
  }

  porClave(tipo, clave) {
    for (const [id, e] of Object.entries(this.datos.entradas)) {
      if (!e.borrado && e.tipo === tipo && e.clave === clave) return { id: Number(id), ...e };
    }
    return null;
  }

  listar(tipo) {
    return Object.entries(this.datos.entradas)
      .filter(([, e]) => !e.borrado && (!tipo || e.tipo === tipo))
      .map(([id, e]) => ({ id: Number(id), ...e }))
      .sort((a, b) => a.id - b.id);
  }

  asignar(datos) {
    if (!TIPOS.has(datos.tipo)) throw new TypeError("tipo_de_id_invalido");
    const id = this.datos.siguiente;
    this.datos.siguiente = id + 1;
    this.datos.entradas[String(id)] = { ...datos };
    this.cambiado = true;
    return id;
  }

  actualizar(id, cambios) {
    const e = this.datos.entradas[String(id)];
    if (!e || e.borrado) throw new Error("id_inexistente");
    Object.assign(e, cambios);
    for (const [k, v] of Object.entries(e)) if (v === undefined) delete e[k];
    this.cambiado = true;
  }

  marcarBorrado(id) {
    this.actualizar(id, { borrado: true });
  }

  /**
   * Da id a los ficheros que no lo tienen y marca borrados los que ya no están.
   * @param {Array<{tipo:string, ruta:string, coleccion?:string}>} presentes
   * @returns {number[]} ids nuevos
   */
  sincronizar(tipo, presentes) {
    const nuevos = [];
    const rutas = new Set(presentes.map((p) => p.ruta));
    for (const e of this.listar(tipo)) if (!rutas.has(e.ruta)) this.marcarBorrado(e.id);
    for (const p of [...presentes].sort((a, b) => (a.ruta < b.ruta ? -1 : a.ruta > b.ruta ? 1 : 0))) {
      if (!this.porRuta(p.ruta, tipo)) nuevos.push(this.asignar({ ...p, tipo }));
    }
    return nuevos;
  }
}
