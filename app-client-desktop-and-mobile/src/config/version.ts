import packageJson from '../../package.json';

/**
 * Versión visible de la interfaz.
 *
 * Se toma de package.json para no dejar "v1.0.0" escrito a mano en tres
 * pantallas después de cada release. En Tauri, Ajustes sigue consultando la
 * versión real del binario cuando está disponible.
 */
export const APP_VERSION = packageJson.version;
