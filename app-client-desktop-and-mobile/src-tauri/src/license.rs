use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sysinfo::System;

#[derive(Debug, Serialize, Deserialize)]
pub struct HwidInfo {
    pub hwid: String,
    pub os_name: String,
    pub kernel: String,
    pub cpu_count: usize,
}

/// HWID criptográfico (SHA-256) sobre invariantes de hardware estables.
/// NO se usan kernel/OS/uptime en el hash: cambian en cada update del
/// sistema y romperían licencias válidas.
pub fn hwid_hash(identity: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(identity.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Identificador de instalación estable (persiste reinstalaciones de paquetes)
fn machine_id() -> Option<String> {
    for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        if let Ok(id) = std::fs::read_to_string(path) {
            let trimmed = id.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Genera un HWID resistente basado en hardware del sistema
pub fn get_machine_hwid() -> HwidInfo {
    let mut sys = System::new_all();
    sys.refresh_all();

    let host = System::host_name().unwrap_or_else(|| "unknown_host".to_string());
    let os = System::name().unwrap_or_else(|| "unknown_os".to_string());
    let kernel = System::kernel_version().unwrap_or_else(|| "unknown_kernel".to_string());
    let cpu_count = sys.cpus().len();
    let cpu_brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().to_string())
        .unwrap_or_default();

    let machine = machine_id().unwrap_or_else(|| host.clone());
    let raw = format!("{}:{}:{}:{}", machine, host, cpu_brand, cpu_count);

    HwidInfo {
        hwid: hwid_hash(&raw),
        os_name: os,
        kernel,
        cpu_count,
    }
}

#[tauri::command]
pub fn get_hwid() -> HwidInfo {
    get_machine_hwid()
}

// ---------------------------------------------------------------------------
// Verificación del ticket de licencia firmado ed25519 por el backend (VPS).
// El payload va en ASCII antes de firmar -> recomputable sin re-serializar.
// ---------------------------------------------------------------------------

/// Clave PÚBLICA del backend para firmar licencias (base64 de la SPKI DER).
/// La escribe tools/brand/apply.mjs desde `licensePublicKey` de
/// brand.config.json (se obtiene con `npm run keys:pub` en backend-server).
/// Va compilada en el binario, no en un fichero del bundle: rotarla exige
/// publicar una versión nueva.
const LICENSE_PUBLIC_KEY_SPKI_B64: &str =
    "MCowBQYDK2VwAyEAHRf3eLwZ124xnKpku8EzzFX3+Tve+/PvNHP2tIiWb4o=";

pub const TICKET_VERSION: u32 = 1;
pub const KEY_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VerifiedTicket {
    #[serde(rename = "v", default)]
    pub ticket_version: u32,
    #[serde(rename = "kid", default)]
    pub key_version: u32,
    #[serde(rename = "sub")]
    pub user_id: String,
    pub name: String,
    pub username: String,
    pub role: String,
    pub plan: String,
    #[serde(rename = "exp", default)]
    pub plan_expires_at_ms: Option<i64>,
    #[serde(rename = "lt", default)]
    pub lifetime: bool,
    #[serde(rename = "cr", default)]
    pub credits: u32,
    #[serde(rename = "iat", default)]
    pub issued_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TicketError {
    Malformed,
    InvalidSignature,
    UnknownKeyVersion,
    UnknownTicketVersion,
}

impl std::fmt::Display for TicketError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let msg = match self {
            TicketError::Malformed => "ticket malformado",
            TicketError::InvalidSignature => "firma inválida (ticket forjado o alterado)",
            TicketError::UnknownKeyVersion => "versión de clave desconocida",
            TicketError::UnknownTicketVersion => "versión de ticket desconocida",
        };
        f.write_str(msg)
    }
}

/// Extrae la clave raw (32 bytes) de una SPKI DER ed25519.
fn raw_key_from_spki(spki_der: &[u8]) -> Option<[u8; 32]> {
    // SPKI ed25519: 12 bytes de cabecera + 32 bytes de clave raw.
    let tail = spki_der.len().checked_sub(32)?;
    let mut out = [0u8; 32];
    out.copy_from_slice(&spki_der[tail..]);
    Some(out)
}

pub fn verifying_key() -> Result<VerifyingKey, TicketError> {
    let der = STANDARD
        .decode(LICENSE_PUBLIC_KEY_SPKI_B64)
        .map_err(|_| TicketError::Malformed)?;
    let raw = raw_key_from_spki(&der).ok_or(TicketError::Malformed)?;
    VerifyingKey::from_bytes(&raw).map_err(|_| TicketError::Malformed)
}

/// Verifica firma ed25519 + estructura del ticket. NO comprueba expiración del
/// plan: eso lo hace el llamador (server validation / grace offline).
pub fn verify_ticket(ticket: &str) -> Result<VerifiedTicket, TicketError> {
    let (payload_b64, sig_b64) = ticket.split_once('.').ok_or(TicketError::Malformed)?;
    if payload_b64.is_empty() || sig_b64.is_empty() {
        return Err(TicketError::Malformed);
    }

    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|_| TicketError::Malformed)?;
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| TicketError::Malformed)?;

    let signature = Signature::from_slice(&sig_bytes).map_err(|_| TicketError::Malformed)?;
    verifying_key()?
        .verify(&payload_bytes, &signature)
        .map_err(|_| TicketError::InvalidSignature)?;

    let payload: VerifiedTicket = serde_json::from_slice(&payload_bytes).map_err(|_| {
        // Si JSON falla pero la firma es válida, el vector de datos no encaja.
        TicketError::Malformed
    })?;

    Ok(payload)
}

/// Valida además versión de clave/ticket (el vendido en el payload).
pub fn verify_ticket_strict(ticket: &str) -> Result<VerifiedTicket, TicketError> {
    let vt = verify_ticket(ticket)?;
    if vt.ticket_version != TICKET_VERSION {
        return Err(TicketError::UnknownTicketVersion);
    }
    if vt.key_version != KEY_VERSION {
        return Err(TicketError::UnknownKeyVersion);
    }
    Ok(vt)
}

#[cfg(test)]
mod ticket_tests {
    use super::*;

    // Vector de conformidad emitido por el backend Node (esp/backend).
    const VALID: &str = "eyJ2IjoxLCJraWQiOjEsInN1YiI6IjUwN2YxZjc3YmNmODZjZDc5OTQzOTAxMSIsIm5hbWUiOiJUYXVyaSBUZXN0IiwidXNlcm5hbWUiOiJ0YXVyaXRlc3QiLCJyb2xlIjoidXNlciIsInBsYW4iOiJzaGFkb3ciLCJleHAiOjE3OTM0OTEyMDAwMDAsImx0IjpmYWxzZSwiY3IiOjMsImlhdCI6MTc4ODc4MTQxMzM4OH0.jUdWs2NEiKj-Qaa6ybGT3DSh_DlDyg_YkBHpazTat4s9x2O7s-5_OUjXl2XH0xCpfeWe3bRf6GaJk6iEvzB3BA";

    #[test]
    fn verifies_ticket_signed_by_backend() {
        let vt = verify_ticket(VALID).expect("ticket real del backend debe ser válido");
        assert_eq!(vt.user_id, "507f1f77bcf86cd799439011");
        assert_eq!(vt.username, "tauritest");
        assert_eq!(vt.plan, "shadow");
        assert_eq!(vt.role, "user");
        assert_eq!(vt.credits, 3);
        assert!(!vt.lifetime);
    }

    #[test]
    fn rejects_tampered_payload() {
        // Cambiamos plan -> shadow no es lo que firmó el servidor
        let (payload_b64, sig_b64) = VALID.split_once('.').unwrap();
        let mut payload: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload_b64).unwrap()).unwrap();
        payload["plan"] = serde_json::Value::String("phantom".into());
        let cursed = URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes()) + "." + sig_b64;
        assert_eq!(verify_ticket(&cursed), Err(TicketError::InvalidSignature));
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(verify_ticket("no-dot"), Err(TicketError::Malformed));
        assert_eq!(verify_ticket(""), Err(TicketError::Malformed));
        assert_eq!(
            verify_ticket("!!!...@#$"),
            Err(TicketError::Malformed)
        );
    }

    #[test]
    fn public_key_is_blakeable_raw() {
        assert!(
            !LICENSE_PUBLIC_KEY_SPKI_B64.is_empty(),
            "Falta licensePublicKey en brand.config.json: sin ella nadie puede iniciar sesión. \
             Ver docs/PUESTA-EN-MARCHA.md, paso 3.1"
        );
        let raw = raw_key_from_spki(&STANDARD.decode(LICENSE_PUBLIC_KEY_SPKI_B64).unwrap());
        assert!(raw.is_some());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hwid_hash_is_deterministic_and_cryptographic() {
        let a = hwid_hash("fixed-input");
        let b = hwid_hash("fixed-input");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert_ne!(a, hwid_hash("other-input"));
    }

    #[test]
    fn machine_id_is_readable_on_linux() {
        if cfg!(target_os = "linux") {
            assert!(machine_id().is_some(), "machine-id debería existir en Linux");
        }
    }
}