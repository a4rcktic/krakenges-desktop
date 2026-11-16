# Publicar una actualización de escritorio

El updater de Tauri no usa el endpoint `/api/updates/check`: usa
`/api/updates/manifest` y verifica la firma Ed25519 de cada artefacto. Si no hay
manifiesto, el endpoint responde `204` y el cliente no ofrece actualizaciones.
Eso es preferible a ofrecer una actualización que no se puede verificar.

## Requisitos

- `bundle.createUpdaterArtifacts` está activo en
  `app-client-desktop-and-mobile/src-tauri/tauri.conf.json`.
- La clave privada del updater está fuera del repositorio, en el secret
  `TAURI_SIGNING_PRIVATE_KEY` (y su contraseña, si tiene).
- La clave pública de `plugins.updater.pubkey` corresponde a esa clave privada.
  Si el comprador cambia la clave, debe cambiar también la pública.
- Los artefactos se publican por HTTPS en `updaterDownloadBaseUrl`
  (`brand.config.json`). Por defecto:
  `https://krakenges.example/downloads/updater`.

No se debe subir la clave privada ni el fichero `.sig` sin el artefacto al que
pertenece.

## 1. Compilar y firmar

La compilación se hace fuera del portátil, en el VPS o en GitHub. El build debe
llevar la clave de firma:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat /ruta/segura/updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="..."
cd app-client-desktop-and-mobile
npm run build
npx tauri build
```

Tauri genera, entre otros:

- Linux: `Kraken Ges_<version>_amd64.AppImage` y su `.sig`. Según la versión de
  Tauri también puede generar `Kraken Ges_<version>_amd64.AppImage.tar.gz` y su
  `.sig`; el plugin actual acepta ambos formatos.
- Windows: `Kraken Ges_<version>_x64-setup.exe` y su `.sig` (NSIS), o el `.msi`
  y su `.sig`. Las versiones antiguas de Tauri generaban `.nsis.zip`/`.msi.zip`.
- `latest.json`, si se usa `tauri-action` o el flujo de release de Tauri.

El manifiesto debe apuntar al artefacto que Tauri pueda instalar y verificar:
el `.AppImage` (o su `.tar.gz`) en Linux y el `.exe` o `.msi` firmado en
Windows. Los instaladores `.deb`, `.rpm` y el `.exe` autónomo de Inno Setup
siguen siendo válidos para descarga manual, pero el updater usa un único
artefacto por plataforma.

## 2. Subir los artefactos

Sube el artefacto y su `.sig` a:

```text
<updaterDownloadBaseUrl>/<version>/
```

Ejemplo:

```text
https://krakenges.example/downloads/updater/1.0.1/KrakenGes_1.0.1_amd64.AppImage
https://krakenges.example/downloads/updater/1.0.1/KrakenGes_1.0.1_x64-setup.exe
```

El `.sig` no se sirve al cliente: el generador copia su contenido al manifiesto.

## 3. Generar el manifiesto

Con un `latest.json` de Tauri:

```bash
node tools/updater-manifest/generate.mjs \
  --latest /ruta/latest.json \
  --output backend-server/updater-manifest.json
```

O desde un directorio con los artefactos y sus `.sig`:

```bash
node tools/updater-manifest/generate.mjs \
  --artifacts /ruta/artefactos \
  --version 1.0.1 \
  --notes "Correcciones de seguridad" \
  --pub-date "2026-10-20T12:00:00.000Z"
```

El generador:

- Valida la versión semver y la fecha.
- Exige firma y URL en cada plataforma.
- Reescribe las URLs al host público.
- Ordena las plataformas para que el fichero sea estable.
- Falla si hay dos artefactos para la misma plataforma.
- No inventa notas ni fechas: si no hay fecha, usa la hora real de generación.

Para comprobar que el manifiesto desplegado coincide con los artefactos:

```bash
node tools/updater-manifest/generate.mjs \
  --latest /ruta/latest.json \
  --check
```

Para ver el resultado sin escribir:

```bash
node tools/updater-manifest/generate.mjs --latest /ruta/latest.json --dry-run
```

Prueba del propio generador:

```bash
node tools/updater-manifest/generate.mjs --self-test
```

## 4. Desplegar el manifiesto

El backend lo busca en `UPDATER_MANIFEST_PATH`. Si no se define, usa
`backend-server/updater-manifest.json` (en desarrollo y en `dist`).

```env
UPDATER_MANIFEST_PATH=updater-manifest.json
```

El fichero debe quedar fuera de `dist` y sobrevivir a los despliegues. Con
systemd, una opción es:

```ini
WorkingDirectory=/opt/krakenges/backend
Environment=UPDATER_MANIFEST_PATH=/opt/krakenges/updater-manifest.json
```

No se debe reemplazar el manifiesto antes de que los artefactos estén
accesibles: el cliente recibiría una URL que aún no existe.

## 5. Verificar

El cliente de escritorio pide el endpoint sin `target` ni `current_version`
(el `endpoint` de `tauri.conf.json` no lleva placeholders). El backend devuelve
entonces el manifiesto completo y el plugin de Tauri elige su plataforma. Por
eso también vale probarlo sin query:

```bash
curl -i 'https://krakenges.example/api/updates/manifest'
```

Debe devolver `200`, `Cache-Control: no-store` y un JSON con `version`,
`pub_date` y `platforms` con las entradas `linux-x86_64` y `windows-x86_64`.
Para una plataforma concreta, sustituye el dominio y la versión:

```bash
curl -i 'https://krakenges.example/api/updates/manifest?platform=linux&arch=x86_64&current_version=0.9.0'
```

Debe devolver `200`, `Cache-Control: no-store` y un JSON con `version`,
`pub_date`, `platforms["linux-x86_64"].signature` y
`platforms["linux-x86_64"].url`.

La misma versión o una posterior debe devolver `204`:

```bash
curl -i 'https://krakenges.example/api/updates/manifest?platform=linux&arch=x86_64&current_version=1.0.1'
```

Comprueba también Windows:

```bash
curl -i 'https://krakenges.example/api/updates/manifest?target=windows-x86_64&current_version=0.9.0'
```

Por último, instala la versión anterior en una máquina real, abre la app y
confirma que:

1. Detecta la versión nueva.
2. Muestra las notas reales.
3. Descarga el artefacto correcto.
4. La firma se valida y la instalación termina.
5. La versión instalada cambia en Ajustes.

No des por buena una release solo porque el manifiesto responde `200`.

## Qué falta en el repositorio

- No hay clave privada ni artefactos firmados versionados.
- No hay un `updater-manifest.json` versionado por defecto: sin él, el endpoint
  responde `204`.
- El workflow de escritorio ya publica el AppImage y el `.exe` firmados y
  genera `updater-manifest.json` como asset de la release. Copiar los
  artefactos y el manifiesto al VPS sigue siendo manual; el manifiesto no debe
  activarse hasta que las URLs públicas respondan.
- El comprador debe generar su propia clave si no conserva la actual. Cambiar
  `pubkey` sin actualizar la clave privada deja el updater sin actualizaciones
  válidas.
