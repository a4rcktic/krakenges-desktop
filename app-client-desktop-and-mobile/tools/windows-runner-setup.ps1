# Windows runner (máquina de confianza) — PowerShell, ejecutar como Administrador
# Uso: .\windows-runner-setup.ps1 -REPO TU_USUARIO/TU_REPO
# Prepara la PC Windows para compilar el binario de la app (jobs { self-hosted, windows }).
param([Parameter(Mandatory = $true)][string]$REPO)  # tu repo: TU_USUARIO/TU_REPO
$ErrorActionPreference = "Stop"

$RUNNER_VER = "2.337.0"  # última release del runner (https://github.com/actions/runner/releases)

# ---------- 0) Herramientas de compilación ----------
Write-Host "== Instalando toolchain (winget)..." -ForegroundColor Cyan
winget install --silent --accept-package-agreements --accept-source-agreements `
  Microsoft.VisualStudio.2022.BuildTools
winget install --silent --accept-package-agreements --accept-source-agreements `
  Rustlang.Rustup
winget install --silent --accept-package-agreements --accept-source-agreements `
  OpenJS.NodeJS.LTS

# Workload MSVC v143 + Windows SDK (Build Tools con interfaz no instalada)
$vsInstaller = "$env:ProgramFiles (x86)\Microsoft Visual Studio\Installer\vs_installer.exe"
if (-not (Test-Path $vsInstaller)) {
  # descargar bootstrapper de vs_installer si falta
  Invoke-WebRequest -Uri "https://aka.ms/vs/17/release/vs_buildtools.exe" -OutFile "$env:TEMP\vs_buildtools.exe"
  $vsInstaller = "$env:TEMP\vs_buildtools.exe"
}
Start-Process -Wait $vsInstaller `
  -ArgumentList "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools " +
  "--add Microsoft.VisualStudio.Component.Windows10SDK.20348 --nocache"

# ---------- 1) Rustup default MSVC ----------
Write-Host "== Configurando Rust..." -ForegroundColor Cyan
rustup default stable-x86_64-pc-windows-msvc
rustup target list --installed

# ---------- 2) Usuario restringido del runner ----------
Write-Host "== Creando usuario 'runner' (sin admin, solo su carpeta)..." -ForegroundColor Cyan
if (-not (Get-LocalUser -Name "runner" -ErrorAction SilentlyContinue)) {
  New-LocalUser -Name "runner" -FullName "CI Builder" -NoPassword
}
$runnerRoot = "C:\ci-runner"
New-Item -ItemType Directory -Force -Path $runnerRoot | Out-Null

# ---------- 3) Instalar el agente de GitHub Actions ----------
$agentDir = "C:\ci-runner\agent"
if (-not (Test-Path "$agentDir\.runner")) {
  New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
  $zip = "$env:TEMP\runner.zip"
  Invoke-WebRequest -Uri "https://github.com/actions/runner/releases/download/v$RUNNER_VER/actions-runner-win-x64-$RUNNER_VER.zip" -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $agentDir -Force

  Write-Host "== Registro del runner (requiere token, se otorga SOLO a la persona de confianza) ==" -ForegroundColor Yellow
  $token = Read-Host "Pega aqui el registration token (se genera desde el repo o CLI)"
  & "$agentDir\config.cmd" --unattended --replace `
    --url "https://github.com/$REPO" `
    --token $token `
    --labels "self-hosted,Windows" `
    --work "_work" `
    --runasservice --windowslogonaccount "runner" 
}

& "$agentDir\svc.cmd" status
Write-Host @"

LISTO. La maquina ya sirve los jobs { self-hosted, windows }.
Recomendacion:
  - No dar 'runner' permisos de admin.
  - Mantener el repo privado.
  - El agente sale SIEMPRE hacia GitHub (nada entra por RDP/SSH).
"@ -ForegroundColor Green