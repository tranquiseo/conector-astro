// El sobre del canal: mismo formato y mismos bytes firmados que `Cripto/Mensaje.php` del plugin.
//
// La firma cubre los bytes exactos del JSON que viajan, con un prefijo de dominio:
//   bytes_firmados = "tranquiseo/v1/" + dominio + "\n" + json
// El receptor verifica sobre esos bytes sin reconstruir nada, así que no hace falta serializar
// igual que PHP para interoperar. Aun así `serializar` imita a `wp_json_encode` con
// JSON_UNESCAPED_SLASHES|UNICODE|LINE_TERMINATORS y claves ordenadas, para que el mismo sobre dé
// los mismos bytes en las dos puntas (lo comprueba el test cruzado con PHP).

import { randomBytes } from "node:crypto";

export const VERSION = 1;
export const PREFIJO = "tranquiseo/v1/";
export const TAMANO_MAXIMO = 8 * 1024 * 1024; // Mensaje::TAMANO_MAXIMO
export const PROFUNDIDAD_MAXIMA = 32; // json_decode( $json, true, 32 )
export const VENTANA = 300; // TRANQUISEO_VENTANA
export const DERIVA = 60; // TRANQUISEO_DERIVA

export const DOMINIOS = Object.freeze(["orden", "consulta", "resultado", "alta", "reclave"]);
export const CAMPOS = Object.freeze(["v", "dominio", "sitio_id", "home_url", "emitido_en", "nonce", "cuerpo"]);

export function nonce() {
  return randomBytes(16).toString("hex");
}

// untrailingslashit( strtolower( trim( $url ) ) )
export function normalizarUrl(url) {
  return String(url ?? "").trim().toLowerCase().replace(/[/\\]+$/, "");
}

export function crearSobre(dominio, sitioId, homeUrl, cuerpo, ahora = Math.floor(Date.now() / 1000)) {
  return {
    v: VERSION,
    dominio: String(dominio),
    sitio_id: String(sitioId),
    home_url: normalizarUrl(homeUrl),
    emitido_en: ahora,
    nonce: nonce(),
    cuerpo,
  };
}

const esObjeto = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function errorDeEstructura(sobre) {
  if (!esObjeto(sobre)) return "sobre_no_es_array";
  const claves = Object.keys(sobre).sort().join(",");
  if (claves !== [...CAMPOS].sort().join(",")) return "campos_incorrectos";
  if (sobre.v !== VERSION) return "version_desconocida";
  if (!DOMINIOS.includes(sobre.dominio)) return "dominio_desconocido";
  if (typeof sobre.sitio_id !== "string" || sobre.sitio_id === "") return "sitio_id_invalido";
  if (typeof sobre.home_url !== "string" || sobre.home_url === "") return "home_url_invalido";
  if (!Number.isSafeInteger(sobre.emitido_en)) return "emitido_en_invalido";
  if (typeof sobre.nonce !== "string" || !/^[a-f0-9]{32,64}$/.test(sobre.nonce)) return "nonce_invalido";
  // En PHP `cuerpo` es un array: vale objeto o lista (un objeto vacío llega como `[]`).
  if (!esObjeto(sobre.cuerpo) && !Array.isArray(sobre.cuerpo)) return "cuerpo_invalido";
  return null;
}

function ordenar(valor) {
  if (Array.isArray(valor)) return valor.map(ordenar);
  if (esObjeto(valor)) {
    const salida = {};
    // ksort( SORT_STRING ): orden por bytes. Con claves ASCII coincide con el orden de JS.
    for (const clave of Object.keys(valor).sort(compararBytes)) salida[clave] = ordenar(valor[clave]);
    return salida;
  }
  return valor;
}

function compararBytes(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function comprobarSerializable(valor, profundidad = 0) {
  if (profundidad > PROFUNDIDAD_MAXIMA) throw new TypeError("sobre_no_serializable");
  if (typeof valor === "number" && !Number.isFinite(valor)) throw new TypeError("sobre_no_serializable");
  if (typeof valor === "string" && !valor.isWellFormed()) throw new TypeError("sobre_no_serializable");
  if (["function", "undefined", "symbol", "bigint"].includes(typeof valor)) throw new TypeError("sobre_no_serializable");
  if (Array.isArray(valor)) for (const v of valor) comprobarSerializable(v, profundidad + 1);
  else if (esObjeto(valor)) {
    for (const [k, v] of Object.entries(valor)) {
      if (!k.isWellFormed()) throw new TypeError("sobre_no_serializable");
      comprobarSerializable(v, profundidad + 1);
    }
  }
}

export function serializar(sobre) {
  const error = errorDeEstructura(sobre);
  if (error !== null) throw new TypeError(error);
  comprobarSerializable(sobre);
  // JSON.stringify ya no escapa «/», ni Unicode, ni U+2028/U+2029: lo mismo que las tres banderas de PHP.
  return JSON.stringify(ordenar(sobre));
}

export function bytesFirmados(json, dominio) {
  return Buffer.from(PREFIJO + dominio + "\n" + json, "utf8");
}

function profundidad(valor, nivel = 1) {
  if (nivel > PROFUNDIDAD_MAXIMA) return nivel;
  let max = nivel;
  if (Array.isArray(valor) || esObjeto(valor)) {
    for (const v of Object.values(valor)) {
      if (v !== null && typeof v === "object") max = Math.max(max, profundidad(v, nivel + 1));
      if (max > PROFUNDIDAD_MAXIMA) break;
    }
  }
  return max;
}

// Mensaje::decodificar: null si no es un JSON de objeto razonable.
export function decodificar(json) {
  if (typeof json !== "string" || json === "" || Buffer.byteLength(json, "utf8") > TAMANO_MAXIMO) return null;
  let sobre;
  try {
    sobre = JSON.parse(json);
  } catch {
    return null;
  }
  if (sobre === null || typeof sobre !== "object") return null;
  if (profundidad(sobre) > PROFUNDIDAD_MAXIMA) return null;
  return sobre;
}
