// GENERADO por tools/brand/apply.mjs. No editar a mano.
// Fuente: brand.config.json

export const BRAND = {
  "appName": "Kraken Ges",
  "slug": "krakenges",
  "shortName": "Kraken",
  "appTitle": "Kraken Ges — Anti-Detect Browser & Multi-Account Fleet",
  "appDescription": "Navegador Antidetect de Alta Seguridad con Aislamiento Estricto y Huella Coherente.",
  "tagline": "Aislamiento de Navegación de Grado Profesional",
  "companyName": "Kraken Ges",
  "copyright": "© 2026 Kraken Ges. Todos los derechos reservados.",
  "supportUrl": "https://app.krakenchk.com",
  "logoUrl": "/icon.png",
  "logoSquare": "/icon.png",
  "faviconUrl": "/favicon.ico"
} as const;

/** Identificador Android. Debe coincidir con build.gradle y strings.xml. */
export const ANDROID_APPLICATION_ID = "com.krakenges.fleet";

/**
 * Base de la API. Se puede sobrescribir en build con VITE_API_BASE.
 * Sin barra final para que las rutas no salgan con doble slash.
 */
export const API_BASE_URL = (
  (import.meta.env.VITE_API_BASE as string | undefined) || "https://app.krakenchk.com/api"
).replace(/\/+$/, '');
