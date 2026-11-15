// El canal saliente, como `Transporte/Saliente.php::enviar`: sobre firmado por el sitio, POST JSON
// `{sobre, firma}` a `<base>/<ruta>`, sin seguir redirecciones. 204 o un acuse sin sobre → null;
// 200 con sobre → `{sobre, firma}` (lo verifica quien llama); lo demás → error con el código HTTP.

import { crearSobre } from "./cripto/sobre.js";
import { empaquetar } from "./cripto/canal.js";
import { VERSION_CONECTOR } from "./sitio.js";

export const URL_BASE = "https://tranquiseo.com/conector";
const TOPE_RESPUESTA = 9 * 1024 * 1024;

export class ErrorDeRed extends Error {
  constructor(codigo, mensaje, http = null) {
    super(mensaje);
    this.codigo = codigo;
    this.http = http;
  }
}

/** La base solo puede ser https (o http a 127.0.0.1 / localhost, para las pruebas). */
export function validarBase(base) {
  const u = new URL(base);
  const local = u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !local) throw new Error("url_base_no_https");
  if (u.username || u.password || u.search || u.hash) throw new Error("url_base_invalida");
  return base.replace(/\/+$/, "");
}

/**
 * @param {object} p
 * @param {string} p.base       URL base del canal
 * @param {string} p.ruta       consulta | resultado | baja
 * @param {string} p.dominio    dominio del sobre
 * @param {object} p.cuerpo
 * @param {string} p.sitioId
 * @param {string} p.homeUrl
 * @param {import('node:crypto').KeyObject} p.privada
 * @param {number} [p.ahora]    segundos
 * @param {typeof fetch} [p.fetch]
 * @param {number} [p.tope]     ms
 * @returns {Promise<{sobre: string, firma: string} | null>}
 */
export async function enviar({ base, ruta, dominio, cuerpo, sitioId, homeUrl, privada, ahora, fetch: f = globalThis.fetch, tope = 25000 }) {
  const paquete = empaquetar(crearSobre(dominio, sitioId, homeUrl, cuerpo, ahora), privada);
  let respuesta;
  try {
    respuesta = await f(`${validarBase(base)}/${ruta}`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(tope),
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": `Tranquiseo-Conector/${VERSION_CONECTOR}; ${homeUrl}` },
      body: JSON.stringify(paquete),
    });
  } catch (e) {
    throw new ErrorDeRed("tranquiseo_sin_red", e?.name === "TimeoutError" ? "tiempo agotado" : "sin red");
  }
  if (respuesta.status === 204) return null;
  if (respuesta.status !== 200) {
    await respuesta.body?.cancel().catch(() => {});
    throw new ErrorDeRed("tranquiseo_rechazado", `El servicio ha respondido ${respuesta.status}.`, respuesta.status);
  }
  const texto = await respuesta.text();
  if (texto.length > TOPE_RESPUESTA) throw new ErrorDeRed("tranquiseo_respuesta_invalida", "La respuesta es demasiado grande.");
  let datos;
  try {
    datos = JSON.parse(texto);
  } catch {
    throw new ErrorDeRed("tranquiseo_respuesta_invalida", "La respuesta no es JSON.");
  }
  if (!datos || typeof datos !== "object") throw new ErrorDeRed("tranquiseo_respuesta_invalida", "La respuesta no es JSON.");
  if (datos.sobre === undefined && datos.firma === undefined) return null; // acuse: `{vacio:true}`, `{recibidos:n}`
  if (typeof datos.sobre !== "string" || typeof datos.firma !== "string") throw new ErrorDeRed("tranquiseo_respuesta_invalida", "La respuesta trae un sobre a medias.");
  return { sobre: datos.sobre, firma: datos.firma };
}

export const RETROCESO_MAXIMO = 6 * 3600;

/** `Saliente::anotar_fallo`: espera = intervalo × 2^fallos, con tope de 6 h. */
export function siguienteIntento(estadoRed, intervalo, ahora, motivo) {
  const fallos = (Number.isSafeInteger(estadoRed.fallos_seguidos) ? estadoRed.fallos_seguidos : 0) + 1;
  const espera = Math.min(RETROCESO_MAXIMO, intervalo * 2 ** Math.min(fallos, 10));
  return { ...estadoRed, fallos_seguidos: fallos, proximo_no_antes: ahora + espera, ultimo_error: String(motivo).slice(0, 80) };
}
