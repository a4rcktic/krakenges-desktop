#!/usr/bin/env node
/**
 * Comprueba que toda vista invoca comandos que el puente implementa.
 *
 * POR QUE EXISTE ESTE SCRIPT
 *
 * invoke() no llama a las funciones de electronAPI declaradas en useAuth: va al
 * switch de services/tauriBridge.ts. Si una vista invoca un comando que ese
 * switch no implementa, el error aparece en tiempo de ejecucion, no al
 * compilar. TypeScript no dice nada.
 *
 * Y casi todas las llamadas estan envueltas en un .catch(() => []) o un
 * try/catch que devuelve lista vacia, para que un fallo de red no rompa la
 * pantalla. Eso es razonable, pero convierte un comando mal escrito en una
 * pantalla vacia sin explicacion: hubo un tiempo en que perfiles y sesiones
 * mostraban cero y no habia forma de saber si era un fallo de red o un bug.
 *
 * Pasó de verdad seis veces:
 *
 *   apiGetProfiles       -> no existe; el real es server_profiles_list
 *   apiGetSessions       -> no existe; el real es server_sessions_list
 *   get_profiles         -> no existe
 *   get_sessions         -> no existe
 *   reactivate_session   -> no existe; el real es server_reactivate_session
 *   check_engine_update  -> no existe; el real es check_engine_status
 *   purge_sessions       -> no existe en el puente (la ruta si existe)
 *   export_backup        -> no existe en el puente (la ruta si existe)
 *   server_purge_cache   -> no hay ruta en el backend
 *
 * Sale con codigo 1 si queda alguno, de forma que el build falle y no se
 * descubra en el movil de un cliente dentro de tres semanas.
 *
 * Es un script y no un test porque el cliente no tiene runner de tests, y
 * anadir uno solo para esto traeria tipos que rompen tsc, que es lo que corre
 * de verdad en el pipeline.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const SRC_CLIENTE = path.join(RAIZ, 'app-client-desktop-and-mobile', 'src');
const BRIDGE = path.join(SRC_CLIENTE, 'services', 'tauriBridge.ts');

/** Comandos que implementa el switch del bridge. */
function comandosImplementados() {
  const texto = fs.readFileSync(BRIDGE, 'utf8');
  const encontrados = texto.match(/case\s+'([^']+)'/g) || [];
  return new Set(
    encontrados
      .map((m) => {
        const q = m.match(/'([^']+)'/);
        return q ? q[1] : '';
      })
      .filter(Boolean)
  );
}

/** Todos los .ts y .tsx del cliente, saltando el propio bridge. */
function ficherosFuente() {
  const salida = [];
  const recorrer = (dir) => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const completa = path.join(dir, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name === 'node_modules') continue;
        recorrer(completa);
      } else if (/\.tsx?$/.test(entrada.name)) {
        salida.push(completa);
      }
    }
  };
  recorrer(SRC_CLIENTE);
  return salida;
}

/** comando -> ficheros que lo invocan */
function comandosInvocados() {
  const usos = new Map();
  const patron = /invoke(?:<[^>]*>)?\(\s*'([^']+)'/g;
  for (const fichero of ficherosFuente()) {
    if (fichero === BRIDGE) continue; // el puente no se invoca a si mismo
    const texto = fs.readFileSync(fichero, 'utf8');
    let m;
    while ((m = patron.exec(texto)) !== null) {
      const cmd = m[1];
      const lista = usos.get(cmd) || [];
      lista.push(path.relative(RAIZ, fichero));
      usos.set(cmd, lista);
    }
  }
  return usos;
}

const implementados = comandosImplementados();
const invocados = comandosInvocados();

console.log('[bridge-check] comandos implementados por el puente: ' + implementados.size);
console.log('[bridge-check] comandos invocados por las vistas: ' + invocados.size);

// 1. Todo lo que se invoca tiene que existir en el puente.
const huerfanos = [];
for (const [cmd, ficheros] of invocados) {
  if (!implementados.has(cmd)) {
    huerfanos.push('  ' + cmd + '   <- ' + [...new Set(ficheros)].join(', '));
  }
}

if (huerfanos.length) {
  console.error('\n[bridge-check] FALLO: hay vistas invocando comandos que el puente no implementa.');
  console.error('Esos comandos fallan en ejecucion, no al compilar. Y como casi todo va');
  console.error('envuelto en un catch que devuelve lista vacia, la pantalla sale en cero');
  console.error('sin explicar por que.\n');
  huerfanos.forEach((l) => console.error(l));
  console.error('\n  El switch de services/tauriBridge.ts es la unica fuente de verdad.');
  console.error('  Los nombres de electronAPI en useAuth NO existen: no los uses.\n');
  process.exit(1);
}

// 2. Los nombres que ya se sepa que son fantasma no deben volver.
const FANTASMA = [
  'apiGetProfiles', 'apiGetSessions', 'apiGetDashboard', 'apiGetUsers',
  'apiGetFingerprint', 'get_profiles', 'get_sessions',
  'purge_sessions', 'export_backup', 'reactivate_session', 'check_engine_update',
];
const regresaron = FANTASMA.filter((c) => invocados.has(c));
if (regresaron.length) {
  console.error('\n[bridge-check] FALLO: vuelve un nombre que ya se sabe que no existe:');
  regresaron.forEach((c) => console.error('  ' + c));
  process.exit(1);
}

console.log('[bridge-check] OK: todas las vistas invocan comandos que el puente implementa.');
