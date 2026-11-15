// Fechas en la forma del contrato: `Y-m-d H:i:s` en UTC (como `post_date_gmt`).

const dos = (n) => String(n).padStart(2, "0");

export function formatoUtc(fecha) {
  return `${fecha.getUTCFullYear()}-${dos(fecha.getUTCMonth() + 1)}-${dos(fecha.getUTCDate())} ${dos(fecha.getUTCHours())}:${dos(fecha.getUTCMinutes())}:${dos(fecha.getUTCSeconds())}`;
}

// Desfase (ms) de una zona IANA en un instante dado.
function desfase(instanteMs, zona) {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: zona, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instanteMs));
  const v = Object.fromEntries(partes.map((p) => [p.type, p.value]));
  const comoUtc = Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour, +v.minute, +v.second);
  return comoUtc - Math.floor(instanteMs / 1000) * 1000;
}

/** Hora de pared en `zona` → instante (Date). */
export function deZona(anio, mes, dia, hora, minuto, segundo, zona) {
  const ingenuo = Date.UTC(anio, mes - 1, dia, hora, minuto, segundo);
  let t = ingenuo - desfase(ingenuo, zona);
  t = ingenuo - desfase(t, zona);
  return new Date(t);
}

const ATOM = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const SOLO_DIA = /^(\d{4})-(\d{2})-(\d{2})$/;

function valida(a, m, d, h, mi, s) {
  if (m < 1 || m > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
  return d <= new Date(Date.UTC(a, m, 0)).getUTCDate();
}

/**
 * Lo que admite el tipo `fecha` del esquema del plugin: ISO 8601 con zona (ATOM) o
 * `Y-m-d H:i:s` en la zona del sitio. Devuelve `Y-m-d H:i:s` UTC o null.
 */
export function fechaDelContrato(valor, zona) {
  let m = ATOM.exec(valor);
  if (m) {
    const [a, me, d, h, mi, s] = m.slice(1, 7).map(Number);
    if (!valida(a, me, d, h, mi, s)) return null;
    let t = Date.UTC(a, me - 1, d, h, mi, s);
    if (m[7] !== "Z") {
      const signo = m[7][0] === "-" ? -1 : 1;
      const [hh, mm] = m[7].slice(1).split(":").map(Number);
      if (hh > 23 || mm > 59) return null;
      t -= signo * (hh * 60 + mm) * 60000;
    }
    return formatoUtc(new Date(t));
  }
  m = LOCAL.exec(valor);
  if (m) {
    const [a, me, d, h, mi, s] = m.slice(1, 7).map(Number);
    if (!valida(a, me, d, h, mi, s)) return null;
    return formatoUtc(deZona(a, me, d, h, mi, s, zona));
  }
  return null;
}

/**
 * Fecha tal como la escribe un frontmatter (`2026-11-01`, ISO completa o un Date de YAML) →
 * `Y-m-d H:i:s` UTC. Un día sin hora es medianoche en la zona del sitio.
 */
export function fechaDeFrontmatter(valor, zona) {
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : formatoUtc(valor);
  if (typeof valor !== "string") return null;
  const v = valor.trim();
  const m = SOLO_DIA.exec(v);
  if (m) {
    const [a, me, d] = m.slice(1).map(Number);
    return valida(a, me, d, 0, 0, 0) ? formatoUtc(deZona(a, me, d, 0, 0, 0, zona)) : null;
  }
  const directa = fechaDelContrato(v, zona);
  if (directa) return directa;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : formatoUtc(new Date(t));
}
