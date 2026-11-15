// Tipo y dimensiones de una imagen mirando sus BYTES, nunca la extensión ni lo que diga quien la
// manda. SVG no se admite nunca (es XML que puede llevar script).

const MIME = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif" };

export function tipoPorBytes(b) {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 6 && (b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a")) return "gif";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp" && ["avif", "avis"].includes(b.toString("latin1", 8, 12))) return "avif";
  return null;
}

export const mimeDe = (ext) => MIME[ext] ?? null;

function jpeg(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marca = b[i + 1];
    if (marca === 0xd8 || marca === 0x01 || (marca >= 0xd0 && marca <= 0xd7)) {
      i += 2;
      continue;
    }
    const largo = b.readUInt16BE(i + 2);
    if ((marca >= 0xc0 && marca <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marca)) {
      return { alto: b.readUInt16BE(i + 5), ancho: b.readUInt16BE(i + 7) };
    }
    i += 2 + largo;
  }
  return null;
}

function webp(b) {
  const trozo = b.toString("latin1", 12, 16);
  if (trozo === "VP8 " && b.length >= 30) return { ancho: b.readUInt16LE(26) & 0x3fff, alto: b.readUInt16LE(28) & 0x3fff };
  if (trozo === "VP8L" && b.length >= 25) {
    const v = b.readUInt32LE(21);
    return { ancho: (v & 0x3fff) + 1, alto: ((v >> 14) & 0x3fff) + 1 };
  }
  if (trozo === "VP8X" && b.length >= 30) return { ancho: b.readUIntLE(24, 3) + 1, alto: b.readUIntLE(27, 3) + 1 };
  return null;
}

function avif(b) {
  const i = b.indexOf("ispe", 0, "latin1");
  if (i < 0 || i + 16 > b.length) return null;
  return { ancho: b.readUInt32BE(i + 8), alto: b.readUInt32BE(i + 12) };
}

/** @returns {{tipo:string, ancho:number, alto:number}|null} */
export function dimensiones(b) {
  const tipo = tipoPorBytes(b);
  let d = null;
  try {
    if (tipo === "png" && b.length >= 24) d = { ancho: b.readUInt32BE(16), alto: b.readUInt32BE(20) };
    else if (tipo === "gif") d = { ancho: b.readUInt16LE(6), alto: b.readUInt16LE(8) };
    else if (tipo === "jpg") d = jpeg(b);
    else if (tipo === "webp") d = webp(b);
    else if (tipo === "avif") d = avif(b);
  } catch {
    d = null;
  }
  if (!d || !(d.ancho > 0) || !(d.alto > 0)) return null;
  return { tipo, ...d };
}
