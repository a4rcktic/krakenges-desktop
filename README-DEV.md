# Kraken Ges — Enterprise Multiplatform Antidetect & Stealth Suite

Bienvenido al repositorio maestro de **Kraken Ges**. Este paquete contiene la totalidad del código fuente, aplicaciones móviles, aplicación de escritorio, servidor backend y documentación. Los binarios de distribución **no** se versionan aquí: se regeneran en CI o en el VPS a partir de este mismo código.

Repositorio: el tuyo en GitHub (privado). Primeros pasos con tu propia cuenta: `docs/PUESTA-EN-MARCHA.md`.

---

## ⚠️ Estado del repositorio (20/10/2026)

Este paquete está en **pre-lanzamiento (v1.0.1)** y hay tres cosas que debes saber antes de usarlo:

1. **No hay binarios versionados.** Los instaladores antiguos de `releases-instaladores/` son de una build del **24/09**, no incluyen el trabajo posterior y **no forman parte del repositorio**. Hay que regenerarlos desde este código.
2. **Verificación local del 20/10.** `cargo check` pasa y `cargo test --lib` da 80/80 tests en verde; las 39 comprobaciones del shim (`src-tauri/tests/shim_behavior.test.cjs`) también pasan. Los instaladores de release se siguen compilando fuera del portátil, en el VPS o en CI.
3. **La credencial del propietario local estuvo expuesta.** `OWNER_PASSWORD` estaba hardcodeado en el código y era recuperable con `strings` desde cualquier instalador. Se corrigió, pero **las instalaciones ya desplegadas siguen con la contraseña antigua**: hay que cambiarla en cada una.

Los binarios antiguos de `releases-instaladores/` son anteriores al cambio de marca y no se publican. Los artefactos nuevos se generan con `Kraken Ges` desde GitHub Actions o el VPS.

El despliegue del backend está documentado en **`backend-server-pg/ops/README.md`**; la puesta en marcha, en **`docs/PUESTA-EN-MARCHA.md`**.

La referencia completa y verificada del proyecto está en **`DOCUMENTACION-KRAKENGES.txt`**. Ese documento se reescribió el 29/09 porque la versión anterior contenía 16 afirmaciones que ya no correspondían al código (cifras del catálogo de huellas, rutas, versión del motor y política de proxies).

---

## 📁 Estructura del Proyecto

```text
Kraken Ges/
├── README-DEV.md                          <-- Esta guía técnica completa
├── DOCUMENTACION-KRAKENGES.txt                <-- Manual de usuario y arquitectura general
├── plan-seguridad-krakenges.txt              <-- Protocolos de seguridad y anti-fugas
├── KrakenGes-Design-Previews.html            <-- Galería interactiva de conceptos de interfaz
├── credenciales/                          <-- MOVIDO (30/09): ya no está aquí, ver nota abajo
├── design-concepts/                       <-- Mockups y prototipos HTML de la interfaz
│
├── app-client-desktop-and-mobile/         <-- APP PRINCIPAL (Desktop Tauri + Mobile Capacitor)
│   ├── src/                               <-- Frontend React 18 + Vite + Tailwind/CSS
│   │   ├── components/                    <-- Vistas (Perfiles, Sesiones, Planes, etc.)
│   │   ├── config/branding.ts             <-- 🎨 ARCHIVO MAESTRO DE MARCA BLANCA (Nombre, Logo, Colores)
│   │   ├── services/                      <-- Servicios (stealthInjector, tauri, healthAudit, totp)
│   │   └── services/fingerprint/          <-- Motor de huella digital y realismo de hardware
│   ├── src-tauri/                         <-- MOTOR CORE EN RUST (Tauri v2)
│   │   ├── build.rs                       <-- Cifra el template JS al compilar (XOR+LCG)
│   │   ├── src/launcher.rs                <-- Motor propio, flags de aislamiento, cookies
│   │   ├── src/cdp.rs                     <-- Driver CDP: UA/ClientHints/TZ/locale/geo + workers
│   │   ├── src/pools.rs                   <-- Motor de identidades: Chrome, UA y hardware
│   │   ├── src/paths.rs                   <-- Saneado de profile_id (anti path-traversal)
│   │   ├── src/backend.rs                 <-- Base de datos local, usuarios, perfiles, licencias
│   │   ├── src/api.rs                     <-- Cliente del backend remoto
│   │   └── src/injector_template.js       <-- Shim inyectado (se cifra al compilar)
│   ├── android/                           <-- Proyecto nativo Android (Gradle + Capacitor WebView)
│   ├── scripts/obfuscate.js               <-- Motor de ofuscación de código
│   └── package.json                       <-- Dependencias de Node/Vite
│
├── backend-server/                        <-- SERVIDOR API BACKEND
│   ├── src/                               <-- API REST Express en TypeScript
│   │   ├── routes/                        <-- 63 endpoints (auth, perfiles, licencias...)
│   │   ├── models/                        <-- Modelos Mongoose
│   │   ├── services/                      <-- Fingerprint, 2FA, proxy cipher, suscripciones
│   │   └── db.ts                          <-- Conector a MongoDB (Mongoose 7)
│   ├── .env.example                       <-- Variables de entorno documentadas
│   ├── Dockerfile                         <-- Despliegue en contenedor Docker
│   └── package.json                       <-- Dependencias del backend
│
└── releases-instaladores/                 <-- NO VERSIONADO: artefactos locales/CI
    ├── android/                           <-- APK firmado que genere CI
    └── desktop/                           <-- .exe, .deb y .AppImage que genere CI
```

> `releases-instaladores/` está en `.gitignore`. Los binarios que haya en disco son antiguos y no deben entregarse; hay que generarlos de nuevo desde este repositorio.

---

## 🛠️ Cómo Ejecutar y Desarrollar Cada Módulo

### 1. App de Escritorio (Desktop Tauri + React)

**Requisitos previos:**
- Node.js >= 18
- Rust y Cargo (última versión stable)
- En Linux: `libwebkit2gtk-4.1-dev`, `build-essential`, `libssl-dev`

```bash
cd app-client-desktop-and-mobile

# 1. Instalar dependencias
npm install

# 2. Ejecutar en modo desarrollo con ventana Tauri nativa
npm run tauri dev

# 3. O ejecutar únicamente la interfaz web en navegador (Vite)
npm run dev

# 4. Compilar instaladores finales de escritorio
npm run tauri build
```

---

### 2. App Móvil (Android Capacitor)

**Requisitos previos:**
- Android Studio y Android SDK (API 33+)
- Java JDK 17

```bash
cd app-client-desktop-and-mobile

# 1. Compilar el frontend
npm run build

# 2. Sincronizar el bundle con el proyecto Android
npx cap sync android

# 3. Abrir en Android Studio para depurar o generar APK
npx cap open android
```

El APK de producción se genera con `./gradlew assembleRelease` (ver abajo) y no se versiona en el repositorio.

#### Firma del APK de release

La clave de firma **no está en el repo** (está en `.gitignore`). Hasta el 30/09 estaba versionada junto a su contraseña hardcodeada en `build.gradle`: cualquiera que clonara el repositorio podía firmar APKs que se presentaban como la app original. Como la app aún no está en Play Store (`versionCode 1`), la clave se rotó sin coste de migración.

Dónde vive ahora:

```text
~/.config/<tu-app>/release.keystore       clave nueva (RSA 4096, permisos 0600)
~/.config/<tu-app>/keystore-password.txt   su contraseña (0600)
~/.config/<tu-app>/release.keystore.bak    la clave antigua, por si acaso
```

Para compilar un APK firmado en local:

```bash
cd app-client-desktop-and-mobile/android

# 1. Copiar la plantilla y rellenar con los valores de ~/.config/<tu-app>
cp keystore.properties.example keystore.properties

# 2. Compilar
./gradlew assembleRelease
```

Sin `keystore.properties`, `assembleRelease` produce un APK **sin firmar** y avisa por consola. Es intencional: mejor un release sin firmar que uno firmado con una clave filtrada.

El CI de GitHub Actions hace lo mismo pero reconstruyendo la keystore desde secrets (`build-apk.yml`), y verifica con `apksigner` que el APK quedó firmado antes de publicar el artefacto. Secrets requeridos en el repositorio:

| Secret | Valor |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 ~/.config/<tu-app>/release.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | contenido de `keystore-password.txt` |
| `ANDROID_KEY_ALIAS` | `krakenges` |
| `ANDROID_KEY_PASSWORD` | contenido de `keystore-password.txt` |

---

### 3. Servidor Backend (API REST)

**Requisitos previos:**
- Node.js >= 18

```bash
cd backend-server

# 1. Instalar dependencias
npm install

# 2. Iniciar en modo desarrollo con recarga en vivo
npm run dev

# 3. Compilar TypeScript para producción
npm run build
npm start
```

El backend corre por defecto en `http://127.0.0.1:4000` (ver `config.ts`; se cambia con `PORT`). Escucha solo en loopback por defecto: detrás de Apache o nginx no se expone directamente. Configura las variables de `.env.example` antes de arrancar. También incluye su `Dockerfile` para despliegue en contenedor.

**Primer arranque con una base vacía.** El registro público exige una licencia, así que hace falta sembrar el primer Owner:

```bash
cd backend-server
OWNER_USERNAME=owner OWNER_PASSWORD='una-clave-larga-y-unica' npm run seed:owner
```

El script no imprime la contraseña, no hace nada si ya existe un Owner y admite `-- --dry-run` para comprobar los datos sin escribir. Cambia esa contraseña desde el panel tras el primer login.

> **Nota:** la base de datos real es **MongoDB** vía Mongoose. No hay SQLite; el antiguo `users.db` se eliminó.

### Cambios de higiene del 30/09/2026

Cuatro cosas que conviene tener presentes para no buscarlas donde ya no están:

1. **`credenciales/` ya no está en el paquete.** El directorio estaba en `.gitignore`, pero eso solo protege a git: el archivo físico `krakenges-credenciales-produccion.txt` seguía viajando dentro del `.zip` de entrega. Se movió a `~/.config/<tu-app>/krakenges-credenciales-produccion.txt` con permisos `0600`.

2. **Solo hay un backend: `backend-server/`.** Existía una segunda copia en `app-client-desktop-and-mobile/backend/`, congelada en la build del 24/09. Había **divergido**: la copia vieja conservaba el secreto de descifrado de proxies `'krakenges-proxy-dev-secret'` (retirado el 29/09) y carecía del limitador de fuerza bruta en el 2FA y del middleware que descarta proxies del body. Se borró. Lo que solo existía allí ya se integró aquí: `scripts/gen-license-keys.mjs`, los comandos `keys:generate`/`keys:pub`, el script `test:e2e` y `src/__tests__/e2e.license-flow.test.ts`.

3. **`releases-instaladores/` no se versiona en git.** Son 222 MB regenerables. Los binarios siguen en disco, fuera del control de versiones.

4. **El CI de tests de Rust ahora corre también en `main`**, no solo en `dev/*`. Antes los tests de Rust nunca se ejecutaban en la rama principal: un merge a `main` no verificaba nada.

5. **Los workflows se movieron a `.github/workflows/` en la raíz.** Estaban en `app-client-desktop-and-mobile/.github/workflows/`, y GitHub **ignora los workflows en subcarpetas**: los cuatro nunca se ejecutaron. Además, `deploy-backend.yml` apuntaba a `backend/` (ya inexistente, ahora es `backend-server/`) y habría fallado en el primer push.

6. **La clave de firma de Android se rotó** y salió de git. Ver § App Móvil → *Firma del APK de release*.

> **No hay despliegue automático del backend.** El antiguo `deploy-backend.yml` apuntaba al VPS del proyecto anterior y se eliminó de este repositorio. El backend de Kraken Ges se despliega a mano en el VPS del comprador según `backend-server-pg/ops/README.md`. Los workflows de escritorio y APK se lanzan a mano hasta configurar las claves de firma en el repositorio nuevo.

---

## 🛡️ Arquitectura del Motor Antidetect (Stealth Engine)

Kraken Ges aplica la identidad en dos capas complementarias: **CDP** a nivel de motor (UA, Client Hints, timezone, locale, geolocalización) y un **shim JS** inyectado en cada documento (navigator, Intl, canvas, WebGL, fuentes).

1. **Coherencia geográfica en tres ejes (IP ⟷ Timezone ⟷ Idioma):**
   El catálogo real está en `backend-server/src/services/fingerprintService.ts`: **38 kits y 5 familias**. La coherencia geográfica usa 24 regiones (24 zonas horarias) y 76 países mapeados. La receta base elige una región y saca timezone e idioma de la misma fila, así que la pareja es plausible aunque no haya país de salida. Cuando hay país (`CF-IPCountry` o `country`), `countryGeo` sustituye ambos campos juntos. `tools/fingerprint-lab/validate.mjs` comprueba el catálogo y el major de Chrome.

2. **Workers:**
   CDP se adjunta a targets `worker`, `service_worker` y `shared_worker`, les aplica el User-Agent y les evalúa el shim en su propio ámbito. El shim cubre `Navigator` y `WorkerNavigator`, y también `Intl` y `measureText`, que antes sólo se corregían en páginas.

3. **Versión de Chromium coherente con el binario real:**
   La app **usa siempre su propio motor** (Chrome for Testing, major fijado en `ENGINE_MAJOR`; ver `launcher.rs`). No se recurre al Chrome del sistema. La versión que se anuncia en la UA y en los Client Hints la impone el binario instalado, no una constante en el código. Esto importa: la firma TLS/JA3 y el HTTP/2 fingerprint **no se pueden falsificar desde JavaScript**, así que la única forma de que todo cuadre es que la UA describa al binario que realmente se ejecuta.

4. **Enumeración de fuentes:**
   `measureText` y `document.fonts.check` simulan el comportamiento del motor cuando la familia pedida no está en la lista del perfil, de forma que un perfil Windows emulado sobre un host Linux no expone las fuentes de Linux. La lista depende de `ensure_fontconfig_aliases()`: sin los alias, el host no puede medir fuentes de Windows.

5. **Fallo explícito en vez de fuga silenciosa:**
   Si alguna orden CDP no se puede enviar, el perfil **no arranca**. Antes, un fallo de inyección lanzaba el perfil con la huella real del host sin avisar.

> **Límites conocidos y aceptados** están documentados en `DOCUMENTACION-KRAKENGES.txt` §7.3. En resumen: `AudioWorklet` no está parcheado, la enumeración de fuentes no puede fabricar métricas de fuentes ausentes en el host, e `Intl` corrige el timezone que se *reporta* pero no desplaza la hora *renderizada*.

---

## 🎨 Marca Blanca (White-Label)

Para cambiar el nombre, logotipos o esquema de color en **toda la aplicación** en un solo lugar:

1. Edita el archivo:  
   `app-client-desktop-and-mobile/src/config/branding.ts`
2. Modifica:
   - `appName`: Nombre de tu software.
   - `companyName`: Nombre de tu empresa.
   - `logoUrl`: Ruta del logotipo.
   - `colors`: Paleta hexadecimal (`primary`, `primaryHover`, `background`, `accent`).
3. Recompila con `npm run build`.
