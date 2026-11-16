# Instrucciones para la máquina de Windows (para el amigo que monta el runner)

> Lee esto completo UNA vez. Luego solo repite la sección 4 y 5. Si algo falla, avísame y lo vemos.

## 0. Qué hace tu máquina y por qué

Tu PC se convierte en el **taller de compilación de Windows**: cada vez que se publica una
versión nueva de Kraken Ges, GitHub le envía a tu máquina el *trabajo* de fabricar el archivo
`.exe` (instalador de Windows). Tu máquina compila, y GitHub guarda el resultado.

- Tu PC **debe quedarse encendida** y con internet, sobre todo cuando vayas a publicar una versión.
- No necesitas saber programar: todo queda instalado y corriendo como un servicio de Windows.

## 1. Requisitos

- Windows 10 o Windows 11 (64 bits).
- Al menos 15 GB libres en disco.
- Conexión estable.
- Tu sesión de Windows puede estar cerrada: el servicio corre igual.

## 2. Instalar las 3 herramientas (una vez)

> Alternativa fácil: si descargaste el archivo `windows-runner-setup.ps1`, puedes saltar esta
> sección y ejecutar el Paso 2 del script (hace todo esto solo). Aquí está el detalle manual:

Abre **PowerShell como Administrador** (clic derecho → "Ejecutar como administrador") y ejecuta:

```powershell
winget install --silent --accept-package-agreements --accept-source-agreements Microsoft.VisualStudio.2022.BuildTools
winget install --silent --accept-package-agreements --accept-source-agreements Rustlang.Rustup
winget install --silent --accept-package-agreements --accept-source-agreements OpenJS.NodeJS.LTS
```

Luego instala la parte de C++ del Build Tools (esto usa el instalador gráfico; espera a que termine):

```powershell
Start-Process -Wait "$env:ProgramFiles (x86)\Microsoft Visual Studio\Installer\vs_installer.exe" -ArgumentList "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.Windows10SDK.20348"
```

Y configura Rust para Windows (MSVC):

```powershell
rustup default stable-x86_64-pc-windows-msvc
```

**Comprueba** que funcionan echando estas líneas (deben imprimir versiones, no errores):

```powershell
rustc --version
node --version
```

## 3. Instalar el "runner" (agente) — una vez

1. Crea la carpeta en **C:\\ci-runner\\agent** (sin espacios ni tildes en la ruta).

   ```powershell
   New-Item -ItemType Directory -Force -Path "C:\ci-runner\agent"
   ```

2. Descarga el agente y descomprímelo ahí (copia y pega esta línea):

   ```powershell
   Invoke-WebRequest -Uri "https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-win-x64-2.337.0.zip" -OutFile "$env:TEMP\runner.zip"
   Expand-Archive -Path "$env:TEMP\runner.zip" -DestinationPath "C:\ci-runner\agent" -Force
   ```

3. Abre PowerShell **como Administrador** dentro de la carpeta y registra la máquina:

   ```powershell
   cd C:\ci-runner\agent
   .\config.cmd --unattended --url https://github.com/TU_USUARIO/TU_REPO --token TU_TOKEN_DE_REGISTRO --labels self-hosted,Windows
   ```

   Sustituye `TU_TOKEN_DE_REGISTRO` por el **token** que te pasan (vale solo 1 hora; si caduca,
   pide otro).

## 4. Encenderlo como servicio (así corre aunque cierres sesión)

```powershell
.\svc.cmd install
.\svc.cmd start
```

Para verificar:

```powershell
.\svc.cmd status
```

Debe decir **running**. Y del lado de quien administra el proyecto, tu máquina aparecerá como
**online** en la lista de runners del repositorio.

## 5. Mantenimiento (lo único que harás de vez en cuando)

- **¿Se apagó el servicio?** Abre `services.msc` → busca *GitHub Actions Runner
  (TU_USUARIO-TU_REPO.…) * → clic derecho → **Iniciar**.
- **¿GitHub pide actualizar el runner?** Avisan en el panel; basta avisarme y te doy el paso
  para actualizar (es descomprimir la versión nueva encima y reiniciar el servicio).
- **No borres ni muevas** la carpeta `C:\ci-runner`. Quitar el runner se hace con un comando
  explícito, nunca borrando la carpeta.

## 6. Reglas de seguridad (no negociables)

- **No** ejecutes el agente como administrador ni le des permisos de administrador al usuario
  que use la carpeta `C:\ci-runner`. Se usa con el usuario normal de Windows.
- **No** compartas el token de registro ni la carpeta con nadie.
- Este equipo **solo compila**: no necesitas tener acceso a nada más del proyecto; todos los
  datos sensibles viven fuera de esta máquina.