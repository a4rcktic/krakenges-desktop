# Puesta en marcha con tu propia cuenta

Guía para quien recibe el código y lo va a compilar y publicar **con sus
propias cuentas** (GitHub, servidor, firma). Sigue los pasos en orden: el build
se niega a continuar mientras falte algo que haría que la app no funcione.

## 1. Tu repositorio en GitHub

1. Crea un repositorio **privado** en tu cuenta.
2. Sube el código:

   ```bash
   git init
   git add .
   git commit -m "Código inicial"
   git branch -M main
   git remote add origin git@github.com:TU_USUARIO/TU_REPO.git
   git push -u origin main
   ```

   `.gitignore` ya excluye `.env`, keystores, claves (`*.key`, `*.pem`,
   `backend-server/.keys/`) y binarios. Revisa `git status` antes del primer
   commit de todos modos.
3. En el repositorio: **Settings → Actions → General**, permite Actions.
   En repos privados GitHub cobra los minutos que pasen del cupo gratuito: si
   tu cuenta no tiene método de pago, los workflows no arrancan.

## 2. Tu marca

Edita `brand.config.json` (nombre, `slug`, dominio, identificadores) como
explica `docs/CAMBIAR-MARCA.md`. Usa identificadores propios
(`com.tuempresa.app`): con los de otra app, en un mismo equipo una
sobrescribiría a la otra.

## 3. Tus claves

Son tres pares de claves. La parte **pública** va en `brand.config.json`; la
**privada** nunca va al repositorio.

### 3.1 Licencias (servidor)

El servidor firma las licencias y la app comprueba la firma.

```bash
cd backend-server
npm install
npm run keys:generate     # crea backend-server/.keys/ (privada + pública)
npm run keys:pub          # imprime la pública en base64
```

- Copia lo que imprime `keys:pub` a `licensePublicKey`.
- La privada (`.keys/license_ed25519.pem`) va a tu servidor: copia la carpeta
  `.keys/` o pon su base64 en `KRAKENGES_LICENSE_PRIVATE_KEY` del `.env`.
  Guárdala también en un sitio seguro: si la pierdes, todas las apps
  instaladas dejan de aceptar licencias nuevas hasta publicar una versión con
  otra clave.

### 3.2 Actualizaciones automáticas (escritorio)

```bash
cd app-client-desktop-and-mobile
npm install
npx tauri signer generate -w ~/.tauri/updater.key
```

- Copia el contenido de `~/.tauri/updater.key.pub` a `updaterPublicKey`.
- La privada y su contraseña van a los secrets de GitHub (paso 5).

### 3.3 Firma de Android

```bash
keytool -genkeypair -v -keystore release.keystore -alias TU_ALIAS \
  -keyalg RSA -keysize 4096 -validity 10000
keytool -exportcert -alias TU_ALIAS -keystore release.keystore | sha256sum
```

- Copia los 64 caracteres del `sha256sum` a `androidReleaseSha256`. La app
  comprueba al arrancar que el APK está firmado con esa keystore: si no
  coincide, se cierra.
- Guarda `release.keystore` fuera del repo. Si la pierdes no podrás publicar
  actualizaciones de la app de Android.
- Para compilar en local, copia `android/keystore.properties.example` a
  `android/keystore.properties` y rellénalo.

## 4. Aplicar

```bash
node tools/brand/apply.mjs
node tools/brand/apply.mjs --check   # debe terminar sin errores
```

Reemplaza también los iconos (lista en `docs/CAMBIAR-MARCA.md`, apartado 3) y
haz commit.

## 5. Secrets de GitHub

En **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Valor |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 release.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | contraseña de la keystore |
| `ANDROID_KEY_ALIAS` | el alias (`TU_ALIAS`) |
| `ANDROID_KEY_PASSWORD` | contraseña de la clave (suele ser la misma) |
| `TAURI_SIGNING_PRIVATE_KEY` | contenido de `~/.tauri/updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | la contraseña que pusiste al generarla |

`GITHUB_TOKEN` lo pone GitHub solo.

## 6. Compilar

- **Escritorio** (Windows, Linux y Arch): pestaña **Actions → Build Desktop →
  Run workflow**.
- **Android**: se compila al subir un tag que empiece por `v` (o
  `apk-`), o a mano desde **Actions → Build Android APK**.

La versión sale de `app-client-desktop-and-mobile/src-tauri/tauri.conf.json`.
Para publicar una versión:

```bash
git tag v1.0.1
git push origin v1.0.1
```

Los instaladores quedan en el release de GitHub con el nombre de tu marca.

## 7. Servidor

- Despliegue del backend PostgreSQL: `backend-server-pg/ops/README.md`.
- Backend MongoDB (rollback): `backend-server/README.md` y los scripts de `ops/`.
- `.env` del servidor: parte de `backend-server/.env.example` (las URLs ya
  traen tu dominio tras el paso 4).
- Backups: `docs/BACKUP-Y-RESTAURACION.md`.
- Publicar actualizaciones automáticas: `docs/RELEASE-UPDATER.md`.

## Si algo falla

- `npm run build` dice que faltan claves → vuelve al paso 3.
- La app de Android abre y se cierra → `androidReleaseSha256` no es la huella
  de la keystore con la que firmaste.
- Nadie puede iniciar sesión → `licensePublicKey` no corresponde a la clave
  privada que usa tu servidor.
- El updater no instala nada → `updaterPublicKey` no corresponde a
  `TAURI_SIGNING_PRIVATE_KEY`.
