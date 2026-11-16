import 'dotenv/config';
import { publicKeyBase64, publicKeyPem } from '../src/services/licenseTicket';
import { config } from '../src/config';

/**
 * Imprime la clave pública Ed25519 que debe incrustarse en el cliente.
 *
 * - `publicKeyBase64()` es el formato que consume `licensePublicKey` del
 *   cliente Tauri (DER/SPKI en base64).
 * - El PEM se imprime solo como referencia humana.
 *
 * Si no existe un par de claves, este script lo genera en
 * MASKOS_LICENSE_KEYS_DIR (por defecto `.keys/`). En producción es preferible
 * definir MASKOS_LICENSE_PRIVATE_KEY y no dejar la clave privada en disco.
 */
const b64 = publicKeyBase64();
const pem = publicKeyPem();

console.log('licensePublicKey (base64, para el cliente):');
console.log(b64);
console.log('');
console.log('PEM (referencia):');
console.log(pem);
console.log('Directorio de claves:', config.licenseKeysDir);
