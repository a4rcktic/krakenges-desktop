//! Saneado de identificadores que se convierten en rutas del sistema de
//! ficheros.
//!
//! `profile_id` llega desde la UI por IPC y antes se concatenaba tal cual en
//! `data_dir.join(profile_id)`. Un id como `../../../../etc/cron.d/x` escapaba
//! del directorio de datos de la app. Aquí se centraliza la validación.

use std::path::{Path, PathBuf};

/// Límite arbitrario pero holgado: los ids que genera la app son 24 hex.
const MAX_PROFILE_ID_LEN: usize = 64;

/// Valida un `profile_id`. Acepta únicamente `[A-Za-z0-9_-]+`: no separadores
/// de ruta, no `..`, no bytes no-ASCII, ni rutas absolutas de Windows (`C:\`),
/// ni caracteres especiales del sistema.
pub fn validate_profile_id(profile_id: &str) -> Result<(), String> {
    if profile_id.is_empty() {
        return Err("profile_id vacío".to_string());
    }
    if profile_id.len() > MAX_PROFILE_ID_LEN {
        return Err(format!(
            "profile_id demasiado largo ({} > {})",
            profile_id.len(),
            MAX_PROFILE_ID_LEN
        ));
    }
    if let Some(bad) = profile_id.chars().find(|c| !is_safe_id_char(*c)) {
        return Err(format!(
            "profile_id contiene un carácter no permitido: {:?}",
            bad
        ));
    }
    Ok(())
}

/// Valida un `profile_id` y devuelve la ruta del directorio de perfil.
pub fn profile_dir(root: &Path, profile_id: &str) -> Result<PathBuf, String> {
    validate_profile_id(profile_id)
        .map_err(|e| format!("profile_id inválido ({}): {}", profile_id, e))?;
    Ok(root.join(profile_id))
}

fn is_safe_id_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// Directorio de datos de la app. Ojo: en Linux `ProjectDirs` usa solo el
/// nombre de aplicación, así que es `~/.local/share/desktop`.
pub fn data_dir() -> Option<PathBuf> {
    directories::ProjectDirs::from("com", crate::brand::SLUG, "desktop")
        .map(|d| d.data_dir().to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_ids() {
        let root = Path::new("/data");
        assert_eq!(
            profile_dir(root, "a1b2c3d4e5f6a7b8c9d0e1f2").unwrap(),
            Path::new("/data/a1b2c3d4e5f6a7b8c9d0e1f2")
        );
        assert!(profile_dir(root, "perfil_con-guiones_1").is_ok());
    }

    #[test]
    fn rejects_traversal() {
        let root = Path::new("/data");
        for evil in [
            "../../../../etc/cron.d/x",
            "..",
            ".",
            "/etc/passwd",
            "a/b",
            "a\\b",
            "C:\\Windows\\System32",
            "a\0b",
            "perfil ",
            "perfil\n",
            "..%2Fescape",
            "perfil;rm -rf /",
        ] {
            assert!(
                profile_dir(root, evil).is_err(),
                "profile_id {:?} deberia rechazarse",
                evil
            );
        }
    }

    #[test]
    fn rejects_empty_and_oversized() {
        let root = Path::new("/data");
        assert!(profile_dir(root, "").is_err());
        assert!(profile_dir(root, &"a".repeat(MAX_PROFILE_ID_LEN + 1)).is_err());
    }
}
