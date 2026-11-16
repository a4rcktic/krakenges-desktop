#!/usr/bin/env node
/**
 * Paridad del catalogo de planes.
 *
 * El backend y el cliente tienen cada uno su copia de los cuatro planes. No
 * comparten modulo porque son dos paquetes distintos, pero si pueden divergir
 * sin que nadie lo note: ya paso con `pro` (Shadow en la UI, Specter en el
 * servidor) y con los ids free/enterprise.
 *
 * Este script lee los dos ficheros y compara id, nombre, precio y limites. No
 * ejecuta TypeScript: extrae los bloques con una expresion regular sobre una
 * estructura que ambos ficheros comparten a proposito.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const FILES = {
  backend: path.join(ROOT, 'backend-server/src/config/plans.ts'),
  client: path.join(ROOT, 'app-client-desktop-and-mobile/src/domain/plans.ts'),
};
const IDS = ['ghost', 'shadow', 'specter', 'phantom'];

function fail(message) {
  console.error(`[plan-check] ERROR: ${message}`);
  process.exit(1);
}

function parsePlans(label, file) {
  if (!fs.existsSync(file)) fail(`no existe ${file}`);
  const src = fs.readFileSync(file, 'utf8');
  const plans = {};

  for (const id of IDS) {
    // Bloque de 2 espacios de indentacion que termina en "  },".
    const blockRe = new RegExp(`^  ${id}: \\{([\\s\\S]*?)^  \\},?$`, 'm');
    const block = src.match(blockRe);
    if (!block) fail(`${label}: no se encontro el bloque "${id}" en ${path.basename(file)}`);

    const body = block[1];
    const name = body.match(/\bname: '([^']+)'/);
    const price = body.match(/\bprice: (-?\d+)/);
    const maxProfiles = body.match(/\bmaxProfiles: (-?\d+)/);
    const maxSessions = body.match(/\bmaxSessions: (-?\d+)/);
    const maxApiKeys = body.match(/\bmaxApiKeys: (-?\d+)/);

    if (!name || !price || !maxProfiles || !maxSessions || !maxApiKeys) {
      fail(`${label}: al bloque "${id}" le falta name, price o algun limite`);
    }

    plans[id] = {
      name: name[1],
      price: Number(price[1]),
      maxProfiles: Number(maxProfiles[1]),
      maxSessions: Number(maxSessions[1]),
      maxApiKeys: Number(maxApiKeys[1]),
    };
  }

  return { plans, src };
}

const backend = parsePlans('backend', FILES.backend);
const client = parsePlans('cliente', FILES.client);

let errors = 0;
for (const id of IDS) {
  for (const field of ['name', 'price', 'maxProfiles', 'maxSessions', 'maxApiKeys']) {
    if (backend.plans[id][field] !== client.plans[id][field]) {
      console.error(
        `[plan-check] ${id}.${field}: backend=${backend.plans[id][field]} cliente=${client.plans[id][field]}`
      );
      errors++;
    }
  }
}

// El alias `pro` debe ser Shadow en los dos lados. Es el bug que motivo este
// script: el servidor daba limites de Specter y la UI mostraba Shadow.
if (!/p === 'shadow' \|\| p === 'pro'\) return 'shadow'/.test(backend.src)) {
  console.error("[plan-check] backend: normalizePlan no mapea pro -> shadow");
  errors++;
}
if (!/^\s*pro: 'shadow',/m.test(client.src)) {
  console.error("[plan-check] cliente: ALIASES no mapea pro -> shadow");
  errors++;
}

if (errors > 0) {
  fail(`${errors} diferencia(s) entre backend y cliente`);
}

const resumen = IDS.map((id) => {
  const p = backend.plans[id];
  return `${id}=$${p.price} (${p.maxProfiles}/${p.maxSessions}/${p.maxApiKeys})`;
}).join(' · ');

console.log(`[plan-check] OK: ${IDS.length} planes coinciden. ${resumen}`);
