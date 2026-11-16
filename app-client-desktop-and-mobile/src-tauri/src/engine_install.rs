//! Descarga del motor de navegación, con progreso visible.
//!
//! ANTES esta descarga se delegaba en un subproceso opaco: `Invoke-WebRequest`
//! en Windows y un script con `curl` + `unzip` en Unix. Rust solo veía el
//! resultado al final, asi que una descarga de ~130 MB no daba ninguna senal:
//! la app parecia colgada durante minutos.
//!
//! Aqui se hace en Rust con el stream de reqwest, y se emite un evento por
//! corte de progreso que el frontend pinta como barra. La descarga se hace a
//! un fichero temporal y solo se mueve a su sitio al terminar, para que una
//! interrupcion no deje un motor a medias que luego se lanzaria fallando.

use futures_util::StreamExt;
use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

/// Evento emitido al frontend mientras se descarga.
pub const ENGINE_PROGRESS_EVENT: &str = "engine:progress";

#[derive(Serialize, Clone, Debug)]
pub struct EngineProgress {
    /// Bytes ya escritos en disco.
    pub downloaded: u64,
    /// Total esperado. 0 si el servidor no envía Content-Length.
    pub total: u64,
    /// URL de origen, para que la UI pueda mostrar de dónde viene.
    pub url: String,
    /// Fase: "download" | "extract" | "done"
    pub phase: String,
}

impl EngineProgress {
    /// Porcentaje 0-100. Devuelve None si el servidor no dice el total: es
    /// mejor una barra indeterminado que un porcentaje inventado.
    pub fn percent(&self) -> Option<u8> {
        if self.total == 0 {
            None
        } else {
            Some((((self.downloaded.min(self.total)) * 100) / self.total) as u8)
        }
    }
}

/// Número de bytes entre emisiones de progreso.
///
/// Se agrupa para no inundar el puente de Tauri con miles de eventos: el
/// zip del motor llega en trozos de cientos de KB y el puente va por JSON.
const PROGRESS_CHUNK: u64 = 1 << 20; // 1 MiB

/// Descarga `url` a `dest`, emitiendo progreso.
///
/// Devuelve el total de bytes escritos. Si el servidor no envía Content-Length
/// (`total == 0`), el progreso se emite igualmente con `downloaded` creciendo y
/// la UI lo pinta como indeterminado.
pub async fn download_with_progress(
    app: &AppHandle,
    url: &str,
    dest: &PathBuf,
) -> Result<u64, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("No se pudo crear el cliente HTTP: {}", e))?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("No se pudo conectar para descargar el motor: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "El servidor devolvió {} al descargar el motor",
            response.status()
        ));
    }

    let total = response.content_length().unwrap_or(0);
    let _ = app.emit(
        ENGINE_PROGRESS_EVENT,
        EngineProgress {
            downloaded: 0,
            total,
            url: url.to_string(),
            phase: "download".into(),
        },
    );

    let mut file = std::fs::File::create(dest)
        .map_err(|e| format!("No se pudo crear el fichero de descarga: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut last_report: u64 = 0;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Se cortó la descarga del motor: {}", e))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Error escribiendo el motor en disco: {}", e))?;
        downloaded += chunk.len() as u64;

        // Se agrupan las emisiones para no saturar el puente de Tauri.
        if downloaded - last_report >= PROGRESS_CHUNK {
            last_report = downloaded;
            let _ = app.emit(
                ENGINE_PROGRESS_EVENT,
                EngineProgress {
                    downloaded,
                    total,
                    url: url.to_string(),
                    phase: "download".into(),
                },
            );
        }
    }

    file.flush()
        .map_err(|e| format!("Error al finalizar la escritura del motor: {}", e))?;

    // Última emisión con el total exacto: la UI necesita el 100% para cerrar
    // la barra, y aquí se garantiza aunque el tamaño no fuera múltiplo del chunk.
    let _ = app.emit(
        ENGINE_PROGRESS_EVENT,
        EngineProgress {
            downloaded,
            total: if total == 0 { downloaded } else { total },
            url: url.to_string(),
            phase: "download".into(),
        },
    );

    Ok(downloaded)
}

/// Extrae un zip en `dest`.
///
/// Se hace en Rust y no con `unzip` del sistema para no depender de que esté
/// instalado, que es justo lo que fallaba en la VPS de CI.
pub fn extract_zip(zip_path: &PathBuf, dest: &PathBuf) -> Result<(), String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("No se pudo abrir el zip del motor: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("El fichero del motor no es un zip válido: {}", e))?;

    std::fs::create_dir_all(dest)
        .map_err(|e| format!("No se pudo crear el directorio del motor: {}", e))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("No se pudo leer una entrada del zip: {}", e))?;

        // Path traversal: un zip malicioso podría escribir fuera del directorio
        // con entradas tipo "../../.bashrc". Se descartan las que suben.
        let out_path = dest.join(entry.name());
        if !out_path.canonicalize().is_ok() {
            // canonicalize falla si el destino aún no existe; se compara la
            // ruta normalizada en su lugar.
            let normalized = normalize_lexically(&out_path);
            if !normalized.starts_with(dest) {
                return Err(format!(
                    "El zip del motor contiene una ruta fuera del directorio de instalación: {}",
                    entry.name()
                ));
            }
        }
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)
                .map_err(|e| format!("No se pudo crear {}: {}", out_path.display(), e))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("No se pudo crear {}: {}", parent.display(), e))?;
        }
        let mut outfile = std::fs::File::create(&out_path)
            .map_err(|e| format!("No se pudo crear {}: {}", out_path.display(), e))?;
        std::io::copy(&mut entry, &mut outfile)
            .map_err(|e| format!("Error al extraer {}: {}", out_path.display(), e))?;

        // Los binarios del motor necesitan permiso de ejecución. En el zip el
        // bit Unix puede no venir, y sin él el motor no arranca.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                let _ = std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(mode | 0o111));
            }
        }
    }

    Ok(())
}

/// Normaliza una ruta sin tocar el disco (canonicalize exige que exista).
fn normalize_lexically(p: &std::path::Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Extrae un `tar.xz` en `dest` descartando el primer componente de cada ruta.
///
/// ungoogled-chromium para Linux empaqueta `ungoogled-chromium-<v>-.../chrome`
/// en la raíz del tar, y la app espera el layout `chrome-linux64/chrome` que
/// usa Chrome for Testing. En vez de extraer a un temporal y renombrar el
/// directorio (dos movimientos de ~150 MB), se extrae en una pasada reescribiendo
/// el prefijo a `chrome-linux64/`. Comparte la protección de `extract_zip` contra
/// rutas que escapan del destino.
///
/// Solo Linux usa motores tar.xz (`Cargo.toml` declara `tar`/`xz2` bajo la
/// cfg correspondiente); Windows/macOS reciben zip y enlazan el stub de abajo.
#[cfg(target_os = "linux")]
pub fn extract_tar_xz_stripping_root(tarxz_path: &PathBuf, dest: &PathBuf) -> Result<(), String> {
    let file = std::fs::File::open(tarxz_path)
        .map_err(|e| format!("No se pudo abrir el motor tar.xz: {}", e))?;
    let decompressed = xz2::read::XzDecoder::new(std::io::BufReader::new(file));
    let mut archive = tar::Archive::new(decompressed);

    let entries = archive
        .entries()
        .map_err(|e| format!("El fichero del motor no es un tar.xz válido: {}", e))?;

    for entry in entries {
        let mut entry = entry.map_err(|e| format!("Entrada corrupta en el motor: {}", e))?;

        // Cualquier entrada especial (symlink, hardlink, dispositivo) se
        // descarta: `File::create` seguiria un symlink y escribiriamos fuera
        // del destino aunque la ruta pase la verificacion normalizada. El
        // motor real de ungoogled no publica nada aparte de directorios y
        // ficheros regulares, así que abandonarlos no rompe la instalación.
        match entry.header().entry_type() {
            tar::EntryType::Regular | tar::EntryType::Directory | tar::EntryType::GNULongName => {}
            _ => continue,
        }

        let raw_name = entry
            .path()
            .map_err(|e| format!("Entrada del motor sin ruta legible: {}", e))?
            .into_owned();
        let mut comps = raw_name.components();
        // Descartar el directorio raíz del tar; sin raíz no hay nada que mover.
        let Some(_root) = comps.next() else { continue };
        let stripped: PathBuf = comps.collect();

        if stripped.as_os_str().is_empty() {
            continue;
        }

        let out_path = dest.join("chrome-linux64").join(&stripped);
        let normalized = normalize_lexically(&out_path);
        if !normalized.starts_with(dest.join("chrome-linux64")) {
            return Err(format!(
                "El motor contiene una ruta fuera del directorio de instalación: {}",
                raw_name.display()
            ));
        }
        if raw_name.is_dir() {
            std::fs::create_dir_all(&out_path)
                .map_err(|e| format!("No se pudo crear {}: {}", out_path.display(), e))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("No se pudo crear {}: {}", parent.display(), e))?;
        }
        let mut outfile = std::fs::File::create(&out_path)
            .map_err(|e| format!("Error al extraer {}: {}", out_path.display(), e))?;
        std::io::copy(&mut entry, &mut outfile)
            .map_err(|e| format!("Error al extraer {}: {}", out_path.display(), e))?;

        // Los binarios del motor necesitan bit de ejecución.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(mode) = entry.header().mode() {
                let _ = std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(mode | 0o111));
            }
        }
    }

    Ok(())
}

/// Stub para plataformas que nunca reciben motores tar.xz (Windows/macOS):
/// mantiene la firma disponible para que el launcher compile sin puertas cfg
/// y devuelve un error explícito si una URL .tar.xz llegara por error.
#[cfg(not(target_os = "linux"))]
pub fn extract_tar_xz_stripping_root(_tarxz_path: &PathBuf, _dest: &PathBuf) -> Result<(), String> {
    Err("Los motores tar.xz solo se entregan en Linux".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_is_none_without_content_length() {
        let p = EngineProgress {
            downloaded: 500,
            total: 0,
            url: String::new(),
            phase: "download".into(),
        };
        // Sin total no se inventa el porcentaje: la UI lo pinta indeterminado.
        assert_eq!(p.percent(), None);
    }

    #[test]
    fn percent_computes_and_clamps() {
        let mk = |d: u64, t: u64| EngineProgress {
            downloaded: d,
            total: t,
            url: String::new(),
            phase: "download".into(),
        };
        assert_eq!(mk(0, 100).percent(), Some(0));
        assert_eq!(mk(50, 100).percent(), Some(50));
        assert_eq!(mk(100, 100).percent(), Some(100));
        // Si se recibe mas de lo anunciado, no pasa de 100.
        assert_eq!(mk(150, 100).percent(), Some(100));
    }

    #[test]
    fn normalizer_resolves_parent_segments() {
        let p = normalize_lexically(std::path::Path::new("/tmp/motor/../../etc/passwd"));
        assert_eq!(p, std::path::Path::new("/etc/passwd"));
    }

    #[test]
    fn normalizer_keeps_normal_paths() {
        let p = normalize_lexically(std::path::Path::new("/tmp/motor/chrome-linux64/chrome"));
        assert_eq!(p, std::path::Path::new("/tmp/motor/chrome-linux64/chrome"));
    }

    /// Fixture tar.xz generado con el mismo crate que usa el extractor.
    #[cfg(target_os = "linux")]
    #[test]
    fn tar_xz_extracts_stripping_root_into_chrome_linux64() {
        let dir = std::env::temp_dir().join(format!("engine-tarxz-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("origen")).unwrap();

        // 1. Comprimir un tar de prueba con raíz propia (layout real de ungoogled).
        let tarpath = dir.join("motor.tar.xz");
        let tarfile = std::fs::File::create(&tarpath).unwrap();
        let encoder = xz2::write::XzEncoder::new(tarfile, 1);
        let mut builder = tar::Builder::new(encoder);

        let mut hdr = tar::Header::new_gnu();
        let body: &[u8] = b"#!/bin/sh\n";
        hdr.set_mode(0o755);
        hdr.set_entry_type(tar::EntryType::Regular);
        hdr.set_size(body.len() as u64);
        builder.append_data(&mut hdr, "ungoogled-chromium-156.0.8078.47-1-x86_64_linux/chrome", body).unwrap();

        let mut hdr2 = tar::Header::new_gnu();
        let body2: &[u8] = b"lib\n";
        hdr2.set_mode(0o644);
        hdr2.set_entry_type(tar::EntryType::Regular);
        hdr2.set_size(body2.len() as u64);
        builder.append_data(&mut hdr2, "ungoogled-chromium-156.0.8078.47-1-x86_64_linux/lib/arm.so", body2).unwrap();

        // `into_inner` devuelve el XzEncoder y hay que cerrarlo explicitamente
        // para que se escriba el terminador del stream xz: sin esto el lector
        // se queda en "premature eof".
        let encoder_out = builder.into_inner().unwrap();
        encoder_out.finish().unwrap();

        // 2. Extraer y verificar el layout normalizado.
        let dest = dir.join("destino");
        std::fs::create_dir_all(&dest).unwrap();
        extract_tar_xz_stripping_root(&tarpath, &dest).unwrap();

        let chrome_path = dest.join("chrome-linux64").join("chrome");
        let lib_path = dest.join("chrome-linux64").join("lib").join("arm.so");
        assert_eq!(std::fs::read_to_string(&chrome_path).unwrap(), "#!/bin/sh\n");
        assert_eq!(std::fs::read_to_string(&lib_path).unwrap(), "lib\n");
        // El binario debe quedar ejecutable.
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&chrome_path).unwrap().permissions().mode();
        assert_ne!(mode & 0o100, 0, "chrome debe conservar el bit de ejecucion");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Regresion: el extractor no debe seguir symlinks. `File::create` resuelve
    /// el destino del symlink y habria escrito fuera del directorio de
    /// instalación aunque la ruta normalizada pasara la verificación.
    #[cfg(target_os = "linux")]
    #[test]
    fn tar_xz_skips_symlink_entries() {
        let dir = std::env::temp_dir().join(format!("engine-tarxz-sym-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // 1. Un tar con un fichero regular y un symlink.
        let tarpath = dir.join("con_symlink.tar.xz");
        let tarfile = std::fs::File::create(&tarpath).unwrap();
        let encoder = xz2::write::XzEncoder::new(tarfile, 1);
        let mut builder = tar::Builder::new(encoder);

        let mut hdr = tar::Header::new_gnu();
        let body: &[u8] = b"contenido\n";
        hdr.set_mode(0o644);
        hdr.set_entry_type(tar::EntryType::Regular);
        hdr.set_size(body.len() as u64);
        builder.append_data(&mut hdr, "motor/data.txt", body).unwrap();

        let mut hdr_sym = tar::Header::new_gnu();
        hdr_sym.set_mode(0o777);
        hdr_sym.set_entry_type(tar::EntryType::Symlink);
        hdr_sym.set_size(0);
        let _ = hdr_sym.set_link_name("/etc/passwd");
        builder.append_data(&mut hdr_sym, "motor/enlace", &[][..]).unwrap();

        let encoder_out = builder.into_inner().unwrap();
        encoder_out.finish().unwrap();

        // 2. Extractar y verificar que el symlink se descarta.
        let dest = dir.join("destino");
        std::fs::create_dir_all(&dest).unwrap();
        extract_tar_xz_stripping_root(&tarpath, &dest).unwrap();
        assert!(dest.join("chrome-linux64").join("data.txt").exists(), "el fichero regular debe extraerse");
        assert!(!dest.join("chrome-linux64").join("enlace").exists(), "el symlink debe descartarse");

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
