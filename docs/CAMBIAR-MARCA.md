# Cambiar la marca (nombre, dominio y rutas)

La marca vive en un solo archivo: `brand.config.json`, en la raíz del repo.
No hay que buscar `Kraken Ges` por el código para cambiar el nombre comercial.

## 1. Editar la configuración

Abre `brand.config.json` y cambia como mínimo:

- `appName`: nombre visible en la app, instaladores y Android. También es la
  carpeta de datos del motor en Windows (`%LOCALAPPDATA%\<appName>`) y el
  nombre del `.exe` que empaqueta el instalador.
- `slug`: el nombre en minúsculas, sin espacios (`miapp`). Se usa en carpetas de
  datos de Linux/macOS (`~/.local/share/<slug>`, `/opt/<slug>`), en la clase de
  ventana de Linux, en el nombre del paquete de Arch y en la extensión de
  archivo asociada del instalador de Windows.
- `shortName`: nombre corto para la barra lateral y espacios estrechos.
- `artifactPrefix`: prefijo de los instaladores publicados. Debe coincidir con
  el nombre que genera Tauri (normalmente el `productName`, sin espacios).
- `companyName` y `copyright`: propietario y pie legal.
- `supportUrl` y `publicBaseUrl`: web pública.
- `apiBaseUrl`: backend real (debe terminar en `/api`).
- `updaterEndpoint`: manifiesto del updater nativo.
- `downloadBaseUrl`: carpeta pública de instaladores.
- `updaterDownloadBaseUrl`: carpeta pública de los artefactos firmados del
  updater. El generador reescribe las URLs a esta base.
- `androidApplicationId` y `tauriIdentifier`: identificadores de paquete.
  `androidApplicationId` cambia la identidad de tienda; el paquete Java interno
  se mantiene para no romper el proyecto.
- `windowTitle`: título de la ventana de escritorio.

`appTitle`, `appDescription`, `tagline`, `logoUrl`, `logoSquare` y
`faviconUrl` también se aplican.

## 2. Aplicar los cambios

Desde la raíz del repo:

```bash
node tools/brand/apply.mjs
# o, desde el cliente:
npm run brand:apply
```

El script actualiza:

- `app-client-desktop-and-mobile/src/config/brand.generated.ts`
- `app-client-desktop-and-mobile/index.html`
- `app-client-desktop-and-mobile/src-tauri/tauri.conf.json`
- `app-client-desktop-and-mobile/src-tauri/src/api.rs`
- `app-client-desktop-and-mobile/capacitor.config.ts`
- `app-client-desktop-and-mobile/android/app/build.gradle` (`applicationId`)
- `app-client-desktop-and-mobile/android/app/src/main/res/values/strings.xml`
- `backend-server/src/config/brand.ts` (nombre, prefijo de artefactos y URL
  pública, que es también el origen permitido por CORS)
- `backend-server/.env.example` (URLs públicas y `CORS_ORIGIN`)
- `app-client-desktop-and-mobile/src-tauri/src/brand.rs` (nombre, `slug` e
  identificador para el motor de escritorio: carpetas de datos y del motor,
  servicio del llavero del sistema, clase de ventana, User-Agent de descargas)
- `app-client-desktop-and-mobile/src-tauri/Cargo.toml` (descripción y autor)
- `app-client-desktop-and-mobile/installer/Setup.iss` (instalador de Windows:
  solo las líneas `#define`; el resto del script usa esas variables)
- `app-client-desktop-and-mobile/packaging/arch/PKGBUILD` (variables `_slug`,
  `_appname`...) y `packaging/arch/app.desktop` (generado entero)
- `site/downloads/index.html`, generado desde `site/downloads/index.template.html`
  (nombre, prefijo de los instaladores, versión de `tauri.conf.json` y
  copyright). **Edita el diseño en la plantilla**, no en `index.html`.

Además, sin pasar por el script, leen la marca directamente:

- La interfaz (etiqueta del dashboard, texto del fondo animado, barra lateral,
  planes, registro): `src/config/branding.ts`, que parte de `brand.generated.ts`.
- `vite.config.ts`: el proxy de desarrollo `/api` apunta al origen de
  `apiBaseUrl`.
- Los workflows de CI: el título de los releases, el nombre del `.exe` y los
  patrones de los artefactos del updater salen de `brand.config.json`.

El nombre generado del backend se usa en el emisor de 2FA y en el changelog
de actualizaciones. El prefijo de artefactos se usa en las URLs de descarga.

Para comprobar que no falta nada:

```bash
node tools/brand/apply.mjs --check
# o, desde el cliente:
npm run brand:check
```

`npm run build` ya ejecuta ese `--check`: si cambias el JSON y no aplicas,
el build falla con la lista de archivos pendientes.

## 3. Iconos

El script **no** genera imágenes. Reemplaza estos archivos por los del
comprador:

- `app-client-desktop-and-mobile/public/icon.png`
- `app-client-desktop-and-mobile/public/favicon.ico`
- `app-client-desktop-and-mobile/src-tauri/icons/` (todos los tamaños)
- `app-client-desktop-and-mobile/android/app/src/main/res/mipmap-*/`

Para Tauri puedes generar el juego completo con `npx tauri icon <ruta-del-png>`.
Para Android, usa Android Studio o reemplaza los mipmaps manteniendo los
nombres. Revisa también el splash y los iconos adaptativos si los hay.

## 4. Backend

El backend lee las URLs de entorno. El script deja los valores de ejemplo en
`backend-server/.env.example`; cópialos al `.env` real del servidor:

```env
PUBLIC_BASE_URL=https://tu-dominio.com
DOWNLOAD_BASE_URL=https://tu-dominio.com/downloads
APP_PUBLIC_URL=https://tu-dominio.com
RELEASE_DATE=2026-10-01T00:00:00.000Z
UPDATER_MANIFEST_PATH=updater-manifest.json
```

`APP_PUBLIC_URL` se usará en los enlaces de correo (reset y verificación).
`DOWNLOAD_BASE_URL` debe existir de verdad y servir los instaladores por HTTPS.
`UPDATER_MANIFEST_PATH` apunta al manifiesto firmado del updater; si no existe,
el endpoint responde `204`. Si el dominio cambia, actualiza también
`CORS_ORIGIN`.

## 5. API base en builds concretos

El cliente usa `apiBaseUrl` por defecto. Para un build puntual contra otro
backend, sin tocar la marca:

```bash
VITE_API_BASE=https://otro-dominio.com/api npm run build
```

En Rust, `KRAKENGES_API_BASE` tiene prioridad sobre el valor compilado:

```bash
KRAKENGES_API_BASE=https://otro-dominio.com/api cargo build --release
```

## 6. Claves propias (licencias, updater y firma de Android)

Las tres claves públicas de quien publica la app también están en
`brand.config.json` (`licensePublicKey`, `updaterPublicKey`,
`androidReleaseSha256`) y `apply.mjs` las escribe en `license.rs`,
`tauri.conf.json` y `MainActivity.java`. Mientras falte alguna,
`apply.mjs --check` (y por tanto `npm run build`) falla con la instrucción para
generarla. Cómo crear las tres y dónde va cada clave privada:
`docs/PUESTA-EN-MARCHA.md`.

## 7. Qué NO cambia el script

- Nombres internos de código, que el usuario final no ve. Se mantienen a
  propósito porque cambiarlos rompe datos o despliegues existentes:
  - el paquete Java `com.krakenges.fleet` y el plugin `KrakenGesSession`;
  - el crate de Rust `krakenges-app` (nombre del binario antes de empaquetar);
  - claves de `localStorage` (`krakenges_*`, `krakenges_*`): cambiarlas cierra la
    sesión y borra preferencias de quien ya usa la app;
  - variables de entorno `KRAKENGES_*` (backend y escritorio) y la cabecera
    `x-krakenges-platform`;
  - el prefijo `krakenges:v1:` de los proxys cifrados guardados en la base;
  - en Linux, la carpeta de sesión `~/.local/share/desktop` (la elige
    `ProjectDirs`, que solo usa el nombre de aplicación `desktop`).
- Comentarios del código y documentos internos (`README-DEV.md`,
  `DOCUMENTACION-KRAKENGES.txt`, mockups de `design-concepts/`).
- La base de datos, las claves de licencia ya emitidas ni los datos de usuarios.
- La clave pública del updater.
- Los iconos.
- El texto legal completo (`legal/`, `LICENSE`): sigue siendo responsabilidad
  del comprador adaptarlo a su empresa y país. Menciona el producto por nombre.
- Los scripts del servidor en `ops/` (servicios `systemd`, backups, rutas
  `/opt/krakenges`, usuario `krakenges`, base de datos `krakenges`) y
  `deploy-vps.sh`. Son la instalación del servidor, no la app: si el comprador
  despliega con otro nombre, debe renombrarlos al instalar.
- El texto del fondo animado está ajustado a ~8 letras dentro de un marco fijo:
  con un `shortName` mucho más largo, revisa que no se salga.

## 8. Aviso al cambiar identificadores

Cambiar `tauriIdentifier` o `androidApplicationId` hace que el sistema operativo
trate la app como **otra aplicación**:

- No actualiza la instalación anterior.
- No comparte sus datos locales, licencias ni sesiones.
- Puede requerir volver a firmar y volver a publicar.

Si solo cambias el nombre comercial y quieres conservar actualizaciones,
mantén los identificadores actuales.

El `namespace` de Android y las clases Java (`com.krakenges.fleet`) **no** cambian
con el script. No son marca visible y renombrarlos exige mover archivos y tocar
el manifiesto. Si el comprador necesita un paquete Java distinto, es un refactor
aparte, no un cambio de marca.

Después de cambiar `androidApplicationId`, ejecuta una vez:

```bash
cd app-client-desktop-and-mobile
npx cap sync android
```

Eso regenera `android/app/src/main/assets/capacitor.config.json` con el nuevo
`appId`.

## 9. Verificación rápida

Se probó cambiando la marca entera a una ficticia ("Acme Shield", dominio
`acme.example`, `slug` `acmeshield`): el script reescribe los 15 destinos y
cliente, backend y Rust compilan sin tocar nada más.

```bash
node tools/brand/apply.mjs --check
cd app-client-desktop-and-mobile && npx tsc --noEmit
cd ../backend-server && npx tsc --noEmit
```

Para el escritorio, además:

```bash
cd app-client-desktop-and-mobile/src-tauri && cargo check
```

Si el build de Android se hace en CI, el workflow también ejecuta
`node tools/brand/apply.mjs --check` antes de compilar.
