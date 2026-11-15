// Ed25519 con node:crypto. Las claves viajan en el mismo formato que en el plugin (sodium):
// pública = 32 bytes en base64; privada = semilla de 32 bytes o clave secreta sodium de 64
// (semilla || pública), en base64. La privada se convierte en KeyObject y no vuelve a ser texto.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

export const BYTES_FIRMA = 64;

function base64Estricto(texto) {
  if (typeof texto !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(texto) || texto.length % 4 !== 0) return null;
  return Buffer.from(texto, "base64");
}

export function privadaDesdeB64(texto) {
  const bytes = base64Estricto(String(texto ?? "").trim());
  if (!bytes || (bytes.length !== 32 && bytes.length !== 64)) throw new TypeError("clave_privada_invalida");
  const semilla = bytes.subarray(0, 32);
  const der = Buffer.concat([PKCS8_ED25519, semilla]);
  const clave = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  // Formato sodium (64 bytes): la mitad final tiene que ser la pública de esa semilla.
  const coherente = bytes.length === 32 || publicaB64(clave) === bytes.subarray(32).toString("base64");
  der.fill(0);
  bytes.fill(0);
  if (!coherente) throw new TypeError("clave_privada_invalida");
  return clave;
}

export function publicaDesdeB64(texto) {
  const bytes = base64Estricto(texto);
  if (!bytes || bytes.length !== 32) return null;
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519, bytes]), format: "der", type: "spki" });
}

export function publicaB64(claveObjeto) {
  const publica = claveObjeto.type === "private" ? createPublicKey(claveObjeto) : claveObjeto;
  return publica.export({ format: "der", type: "spki" }).subarray(SPKI_ED25519.length).toString("base64");
}

// Para el alta: el par nuevo. Se devuelve la privada como KeyObject y, aparte, su semilla en
// base64 SOLO para entregarla por stdin a `gh secret set`. Quien la reciba la borra al acabar.
export function generarPar() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privada: privateKey, publica: publicaB64(publicKey) };
}

export function semillaB64(privada) {
  return privada.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_ED25519.length).toString("base64");
}

export function firmar(bytes, privada) {
  return sign(null, bytes, privada).toString("base64");
}

export function verificarFirma(bytes, firmaB64, publicaB64Texto) {
  const firma = base64Estricto(firmaB64);
  const publica = publicaDesdeB64(publicaB64Texto);
  if (!firma || firma.length !== BYTES_FIRMA || !publica) return false;
  try {
    return verify(null, bytes, publica, firma);
  } catch {
    return false;
  }
}

export { base64Estricto };
