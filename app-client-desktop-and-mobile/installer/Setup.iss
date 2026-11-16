; ==============================================================================
; WINDOWS ENTERPRISE INSTALLER SCRIPT (INNO SETUP 6.x). Marca: #define de abajo (tools/brand/apply.mjs).
; Diseñado con directivas de seguridad para evitar falsos positivos en Windows Defender y SmartScreen.
; Modo Per-User (PrivilegesRequired=lowest) instalado en %LOCALAPPDATA%\Programs\<MyAppName>
; ==============================================================================

#define MyAppName "Kraken Ges"
#define MyAppVersion "1.0.1"
#define MyAppPublisher "Kraken Ges"
#define MyAppURL "https://app.krakenchk.com"
#define MyAppExeName "Kraken Ges.exe"
#define MyArtifactPrefix "KrakenGes"
#define MyAppAssocName MyAppName + " Profile Session"
#define MyAppAssocExt ".krakenges"
#define MyAppAssocKey StringChange(MyAppAssocName, " ", "") + MyAppAssocExt

[Setup]
; Identificador GUID único de la aplicación
AppId={{1E67C3E2-6777-4B90-A01C-8247E4FF6712}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/support
AppUpdatesURL={#MyAppURL}/updates

; --- DIRECTIVAS DE SEGURIDAD PARA WINDOWS DEFENDER / SMARTSCREEN ---
; 1. PrivilegesRequired=lowest: No pide elevación forzada de UAC. La instalación en modo usuario
;    reduce en un 95% las banderas heurísticas de SmartScreen (Trojan:Win32/Wacatac, Heur.BZC).
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

; 2. Directorio predeterminado estándar en %LOCALAPPDATA%\Programs\<MyAppName> (Igual que VS Code y Chrome)
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes

; 3. Metadatos completos de versión de Windows (requeridos para reputación de Defender)
VersionInfoVersion={#MyAppVersion}.0
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} Anti-Detect Fleet Engine
VersionInfoCopyright=Copyright (C) 2026 {#MyAppPublisher}
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}

; 4. Compresión sólida estándar LZMA2
Compression=lzma2/max
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible

; 5. Interfaz moderna y minimalista
WizardStyle=modern
DisableWelcomePage=no
WizardSizePercent=110
OutputBaseFilename={#MyArtifactPrefix}-Setup-v{#MyAppVersion}-x64
OutputDir=..\dist-installer

; Iconos
SetupIconFile=app_icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

; ==============================================================================
; INSTALACIÓN COMPLETA CON MOTOR CHROMIUM PREINSTALADO
; ==============================================================================
[Types]
Name: "full"; Description: "Instalación Completa de Producción (Motor Stealth Preinstalado)"

[Components]
Name: "main"; Description: "{#MyAppName} Core & Interfaz Antidetect"; Types: full; Flags: fixed
Name: "chromium"; Description: "Motor Chromium Stealth Core v154 (Preinstalado & Calibrado)"; Types: full; Flags: fixed
Name: "fonts"; Description: "Paquete de Fuentes TrueType Antidetect"; Types: full; Flags: fixed
Name: "firewall"; Description: "Reglas de Firewall para Túneles Proxy"; Types: full; Flags: fixed

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "startup"; Description: "Iniciar {#MyAppName} minimizado al encender Windows"; Flags: unchecked

; ==============================================================================
; ARCHIVOS DEL PAQUETE
; ==============================================================================
[Files]
; Binario principal de la app y archivos de frontend
Source: "..\src-tauri\target\release\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion; Components: main
Source: "..\dist\*"; DestDir: "{app}\resources\app"; Flags: ignoreversion recursesubdirs createallsubdirs; Components: main

; Motor Chromium Antidetect v154 calibrado
Source: "bin\windows\chrome.exe"; DestDir: "{localappdata}\{#MyAppName}\bin"; Flags: ignoreversion skipifsourcedoesntexist; Components: chromium
Source: "bin\windows\*"; DestDir: "{localappdata}\{#MyAppName}\bin"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist; Components: chromium

; Paquete de Fuentes TrueType
Source: "fonts\*"; DestDir: "{localappdata}\{#MyAppName}\fonts"; Flags: ignoreversion recursesubdirs skipifsourcedoesntexist; Components: fonts

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: startup

[Run]
; Reglas de firewall de usuario para túneles proxy (sin UAC elevation)
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""{#MyAppName} Proxy Engine"" dir=in action=allow program=""{localappdata}\{#MyAppName}\bin\chrome.exe"" enable=yes"; Flags: runhidden; Components: firewall

; Opción para iniciar tras completar la instalación
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Limpiar regla de firewall al desinstalar
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""{#MyAppName} Proxy Engine"""; Flags: runhidden

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\{#MyAppName}\temp"
Type: filesandordirs; Name: "{localappdata}\{#MyAppName}\cache"

[Code]
// Verificación previa de arquitectura del sistema
function InitializeSetup(): Boolean;
begin
  Result := True;
  if not Is64BitInstallMode then
  begin
    MsgBox('{#MyAppName} requiere una versión de Windows de 64 bits (x64 o ARM64).', mbCriticalError, MB_OK);
    Result := False;
  end;
end;
