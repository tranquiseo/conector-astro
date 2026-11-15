#!/usr/bin/env node
// CLI del conector Astro de Tranquiseo. Se ejecuta en la máquina del cliente, dentro del repo de su web.
//
//   npx github:tranquiseo/conector-astro alta <CODIGO>
//   npx github:tranquiseo/conector-astro baja [--forzar]

import { alta } from "../src/cli/alta.js";
import { baja } from "../src/cli/baja.js";

const AYUDA = `Uso:
  tranquiseo-astro alta <CODIGO>   conecta esta web con Tranquiseo (el código sale de tu panel)
  tranquiseo-astro baja [--forzar] desconecta esta web, borra el secreto y desactiva el workflow

Hay que ejecutarlo dentro del repo de la web, con la CLI de GitHub (gh) con la sesión iniciada.`;

async function main(argv) {
  const [orden, ...resto] = argv;
  // Solo para pruebas y laboratorio; validarBase exige https salvo a 127.0.0.1.
  const base = process.env.TRANQUISEO_URL_BASE || undefined;
  if (orden === "alta" && resto.length === 1) return alta({ codigo: resto[0], ...(base ? { base } : {}) });
  if (orden === "baja" && (resto.length === 0 || (resto.length === 1 && resto[0] === "--forzar"))) return baja({ forzar: resto[0] === "--forzar" });
  process.stdout.write(AYUDA + "\n");
  return orden === undefined || orden === "--help" || orden === "-h" ? 0 : 2;
}

main(process.argv.slice(2)).then((codigo) => {
  process.exitCode = codigo;
}, () => {
  process.stdout.write("Error inesperado. No se ha impreso ninguna clave.\n");
  process.exitCode = 1;
});
