# Contenido remoto (sin recompilar la app)

La app consulta `GET /api/content` y guarda una copia local. La primera pintura
usa el catálogo compilado; cuando llega la respuesta, se actualizan precios,
nombres y textos sin descargar otra APK ni instalar otra versión de escritorio.

## Dónde se edita

Por defecto el backend lee:

```text
content/public-content.json
```

Se puede cambiar con la variable de entorno `PUBLIC_CONTENT_PATH`. El archivo
se relee cuando cambia su fecha o tamaño; no hay que reiniciar el backend para
publicar un cambio.

Si el archivo no existe, el endpoint devuelve el catálogo actual de
`src/config/plans.ts` y los textos compilados. Si el JSON es inválido, ocurre lo
mismo y se registra el error: la app nunca se queda sin catálogo.

## Formato

```json
{
  "version": 2,
  "updatedAt": "2026-10-22T12:00:00.000Z",
  "brand": {},
  "texts": {
    "loginTitle": "Navegación sin rastro.",
    "loginTitleHighlight": "Privacidad de alto nivel.",
    "loginSubtitle": "Texto de bienvenida.",
    "plansSummaryTitle": "Suscripción & Licencias de Flota",
    "plansSectionEyebrow": "Escalabilidad de Infraestructura",
    "plansSectionTitle": "Tiers de Potencia & Huella Digital"
  },
  "plans": {
    "shadow": {
      "name": "Shadow",
      "price": 29,
      "currency": "USD",
      "interval": "mes",
      "tagline": "Operaciones individuales y multicuenta estándar.",
      "features": [
        "50 perfiles aislados",
        "5 sesiones simultáneas activas"
      ]
    }
  },
  "theme": {
    "id": "default",
    "version": 1
  }
}
```

Los ids válidos son `ghost`, `shadow`, `specter` y `phantom`. Los campos son
opcionales: lo que no se incluya conserva el valor compilado.

## Qué NO se puede cambiar desde aquí

- Límites de perfiles, sesiones o API Keys.
- Permisos, roles, claves o secretos.
- El `id` del plan o su lógica de autorización.

Esos datos viven en `src/config/plans.ts` y se validan en el backend. El archivo
remoto solo cambia lo que se muestra al usuario.

## Caché

- Backend: `Cache-Control: public, max-age=30, stale-while-revalidate=300`.
- App: conserva la última respuesta buena durante 60 segundos y refresca en
  segundo plano. Si falla la red, sigue usando la copia local.

## Siguiente fase

El panel de administración escribirá este mismo archivo (o su equivalente en
base de datos) con validación, vista previa, historial y rollback. El motor de
temas consumirá `theme` y un manifiesto firmado; esta primera fase no ejecuta
CSS ni JavaScript remoto.
