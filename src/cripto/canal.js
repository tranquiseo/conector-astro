// Empaquetar y verificar sobres. Copia del orden de comprobación de `Cripto/Verificador.php`:
// estructura → dominio → sitio_id → home_url → ventana → firma → nonce. Hacia fuera, un único
// error genérico (`tranquiseo_no_autorizado`); el motivo, solo para el log.

import { timingSafeEqual } from "node:crypto";
import { bytesFirmados, decodificar, DERIVA, errorDeEstructura, normalizarUrl, serializar, VENTANA } from "./sobre.js";
import { base64Estricto, BYTES_FIRMA, firmar, verificarFirma } from "./claves.js";

export function empaquetar(sobre, privada) {
  const json = serializar(sobre);
  return { sobre: json, firma: firmar(bytesFirmados(json, sobre.dominio), privada) };
}

function iguales(a, b) {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

function rechazo(motivo) {
  return { ok: false, codigo: "tranquiseo_no_autorizado", motivo };
}

/**
 * @param {object} p
 * @param {string} p.json            El sobre tal cual llegó (texto).
 * @param {string} p.firma           Firma en base64.
 * @param {string} p.dominio         Dominio esperado.
 * @param {string} p.sitioId         Nuestro sitio_id.
 * @param {string} p.homeUrl         Nuestra home_url.
 * @param {string[]} p.publicas      Públicas aceptables (base64).
 * @param {{consumir(nonce:string, dominio:string, caducaEn:number, ahora:number):boolean}} p.nonces
 * @param {number} [p.ahora]
 */
export function verificarSobre({ json, firma, dominio, sitioId, homeUrl, publicas, nonces, ahora = Math.floor(Date.now() / 1000) }) {
  const sobre = decodificar(json);
  if (sobre === null) return rechazo("sobre_ilegible");

  const error = errorDeEstructura(sobre);
  if (error !== null) return rechazo(error);

  if (!iguales(dominio, sobre.dominio)) return rechazo("dominio_no_esperado");
  if (!sitioId) return rechazo("sitio_sin_alta");
  if (!iguales(sitioId, sobre.sitio_id)) return rechazo("sitio_destino_ajeno");
  if (!iguales(normalizarUrl(homeUrl), sobre.home_url)) return rechazo("home_url_no_coincide");

  const desfase = ahora - sobre.emitido_en;
  if (desfase > VENTANA || desfase < -DERIVA) return rechazo("fuera_de_ventana");

  const bytesFirma = base64Estricto(firma);
  if (!bytesFirma || bytesFirma.length !== BYTES_FIRMA) return rechazo("firma_malformada");

  if (!Array.isArray(publicas) || publicas.length === 0) return rechazo("sin_clave_de_operacion");

  const bytes = bytesFirmados(json, sobre.dominio);
  if (!publicas.some((p) => verificarFirma(bytes, firma, p))) return rechazo("firma_invalida");

  const caducaEn = sobre.emitido_en + VENTANA + DERIVA;
  if (!nonces.consumir(sobre.nonce, sobre.dominio, caducaEn, ahora)) return rechazo("nonce_repetido");

  return { ok: true, sobre };
}
