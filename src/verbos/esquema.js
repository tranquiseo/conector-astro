// Validación de argumentos de un verbo. Esquema CERRADO, copiado de `Verbos/Esquema.php`:
// un argumento que no está en la definición rechaza la orden entera (riesgo D), y ningún tipo
// se evalúa (R7). `html` y `schema` los aporta la capa de escritura (`ctx.html`, `ctx.schema`).

import { ErrorVerbo } from "../errores.js";
import { sanitizeTextField } from "../util/texto.js";
import { fechaDelContrato } from "../util/fechas.js";

class Invalido extends Error {}

const esEnteroTexto = (v) => typeof v === "string" && /^[0-9]+$/.test(v);
const largoBytes = (s) => Buffer.byteLength(s, "utf8");

/**
 * @param {Record<string, object>} definicion
 * @param {object} argumentos
 * @param {{zona?: string, html?: Function, schema?: Function}} [ctx]
 */
export function validar(definicion, argumentos, ctx = {}) {
  if (argumentos === null || typeof argumentos !== "object" || Array.isArray(argumentos)) {
    // PHP recibe `array()` para un objeto JSON vacío: una lista vacía también vale.
    if (Array.isArray(argumentos) && argumentos.length === 0) argumentos = {};
    else throw new ErrorVerbo("tranquiseo_argumento_invalido", "Los argumentos tienen que ser un objeto.");
  }
  const sobrantes = Object.keys(argumentos).filter((k) => !Object.hasOwn(definicion, k));
  if (sobrantes.length > 0) {
    throw new ErrorVerbo("tranquiseo_argumento_no_permitido", `Argumentos no permitidos: ${sobrantes.join(", ")}`);
  }
  const limpios = {};
  for (const [campo, regla] of Object.entries(definicion)) {
    if (!Object.hasOwn(argumentos, campo)) {
      if (regla.obligatorio) throw new ErrorVerbo("tranquiseo_falta_argumento", `Falta el argumento ${campo}.`);
      if (Object.hasOwn(regla, "defecto")) limpios[campo] = structuredClone(regla.defecto);
      continue;
    }
    try {
      limpios[campo] = normalizar(regla, argumentos[campo], ctx);
    } catch (e) {
      if (e instanceof Invalido) throw new ErrorVerbo("tranquiseo_argumento_invalido", `El argumento ${campo} no vale: ${e.message}`);
      throw e;
    }
  }
  return limpios;
}

function normalizar(regla, valor, ctx) {
  switch (regla.tipo) {
    case "entero": {
      if (!Number.isSafeInteger(valor) && !esEnteroTexto(valor)) throw new Invalido("se esperaba un número entero");
      const n = Number(valor);
      if (!Number.isSafeInteger(n)) throw new Invalido("se esperaba un número entero");
      if (regla.minimo !== undefined && n < regla.minimo) throw new Invalido(`mínimo ${regla.minimo}`);
      if (regla.maximo !== undefined && n > regla.maximo) throw new Invalido(`máximo ${regla.maximo}`);
      return n;
    }
    case "texto": {
      if (typeof valor !== "string") throw new Invalido("se esperaba texto");
      const largo = regla.largo ?? 500;
      if (largoBytes(valor) > largo) throw new Invalido(`máximo ${largo} caracteres`);
      return sanitizeTextField(valor);
    }
    case "html": {
      if (typeof valor !== "string") throw new Invalido("se esperaba texto");
      const largo = regla.largo ?? 1048576;
      if (largoBytes(valor) > largo) throw new Invalido(`máximo ${largo} bytes`);
      if (typeof ctx.html !== "function") throw new Invalido("tipo desconocido");
      try {
        return ctx.html(valor);
      } catch (e) {
        throw new Invalido(e.message);
      }
    }
    case "schema": {
      if (valor === null || valor === "") return "";
      if (typeof valor !== "string" && (typeof valor !== "object" || valor === null)) throw new Invalido("se esperaba JSON-LD");
      if (typeof ctx.schema !== "function") throw new Invalido("tipo desconocido");
      try {
        return ctx.schema(valor);
      } catch (e) {
        throw new Invalido(e.message);
      }
    }
    case "base64": {
      if (typeof valor !== "string") throw new Invalido("se esperaba texto en base64");
      const largo = regla.largo ?? 8000000;
      if (valor.length > largo) throw new Invalido(`máximo ${largo} caracteres en base64`);
      const limpio = valor.replace(/\s+/g, "");
      if (limpio === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(limpio)) throw new Invalido("el contenido no es base64");
      return limpio;
    }
    case "url": {
      if (typeof valor !== "string" || valor.length > 2000) throw new Invalido("se esperaba una URL");
      // Como `esc_url_raw(…, ['http','https'])`: fuera los caracteres que no van en una URL.
      const limpia = valor.trim().replace(/ /g, "%20").replace(/[^a-z0-9\-~+_.?#=!&;,/:%@$|*'()[\]\x80-￿]/gi, "");
      if (limpia === "" || !/^https?:\/\/[^/\s]+/i.test(limpia)) throw new Invalido("solo se admiten URLs http o https");
      return limpia;
    }
    case "ruta": {
      if (typeof valor !== "string" || valor.length > 500) throw new Invalido("se esperaba una ruta");
      const limpia = valor.trim();
      if (limpia === "" || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(limpia) || limpia.includes("\0")) {
        throw new Invalido("la ruta tiene que ser relativa a la raíz del sitio");
      }
      const ruta = "/" + limpia.replace(/^\/+|\/+$/g, "");
      // Lista blanca (J8, M5): sin espacios, saltos de línea, comodines (`*`, `:splat`) ni consultas,
      // que un `_redirects` o un `vercel.json` generados a partir del JSON leerían como regla.
      if (!/^\/[A-Za-z0-9._~%\/-]*$/.test(ruta) || /%(?![0-9A-Fa-f]{2})/.test(ruta) || ruta.split("/").some((s) => s === "." || s === "..")) {
        throw new Invalido("la ruta solo admite letras, números, «-», «_», «.», «~», «/» y caracteres codificados con %");
      }
      return ruta;
    }
    case "fecha": {
      if (typeof valor !== "string" || valor.length > 40) throw new Invalido("se esperaba una fecha");
      const f = fechaDelContrato(valor, ctx.zona ?? "UTC");
      if (!f) throw new Invalido("la fecha tiene que ir en ISO 8601");
      return f;
    }
    case "lista_de_opciones": {
      if (!Array.isArray(valor)) throw new Invalido("se esperaba una lista");
      for (const e of valor) {
        if (typeof e !== "string" || !regla.valores.includes(e)) throw new Invalido(`valores admitidos: ${regla.valores.join(", ")}`);
      }
      return [...new Set(valor)];
    }
    case "booleano":
      if (typeof valor !== "boolean") throw new Invalido("se esperaba verdadero o falso");
      return valor;
    case "opcion":
      if (typeof valor !== "string" || !regla.valores.includes(valor)) throw new Invalido(`valores admitidos: ${regla.valores.join(", ")}`);
      return valor;
    case "lista_de_enteros": {
      if (!Array.isArray(valor)) throw new Invalido("se esperaba una lista");
      const maximo = regla.maximo_elementos ?? 100;
      if (valor.length > maximo) throw new Invalido(`máximo ${maximo} elementos`);
      return valor.map((e) => {
        if (!Number.isSafeInteger(e) && !esEnteroTexto(e)) throw new Invalido("la lista solo admite números enteros");
        return Number(e);
      });
    }
    default:
      throw new Invalido("tipo desconocido");
  }
}
