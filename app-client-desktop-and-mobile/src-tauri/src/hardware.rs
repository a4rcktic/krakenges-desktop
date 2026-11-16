use serde::Serialize;
use std::fs;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct HardwareInfo {
    /// Modelo de CPU, si el sistema lo expone.
    pub cpu: Option<String>,
    /// Núcleos lógicos reales.
    pub cores: Option<usize>,
    /// GPU real del sistema. En Linux se lee del sistema operativo, no de
    /// WebGL: WebKitGTK puede devolver "Apple GPU" en equipos Intel porque el
    /// renderer de WebGL está sandboxeado y no representa el hardware físico.
    pub gpu: Option<String>,
    pub platform: String,
    pub distro: Option<String>,
}

/// Información local del equipo. No abre red, no lee secretos y no modifica
/// nada; solo consulta /proc, /sys, /etc/os-release y, si existe, lspci.
#[tauri::command]
pub fn get_hardware_info() -> HardwareInfo {
    let platform = std::env::consts::OS.to_string();

    HardwareInfo {
        cpu: cpu_model(),
        cores: std::thread::available_parallelism().ok().map(|n| n.get()),
        gpu: gpu_name(),
        platform,
        distro: distro_name(),
    }
}

#[cfg(target_os = "linux")]
fn cpu_model() -> Option<String> {
    let text = fs::read_to_string("/proc/cpuinfo").ok()?;
    text.lines()
        .find_map(|line| line.strip_prefix("model name"))
        .and_then(|rest| rest.split(':').nth(1))
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
}

#[cfg(not(target_os = "linux"))]
fn cpu_model() -> Option<String> {
    None
}

#[cfg(target_os = "linux")]
fn distro_name() -> Option<String> {
    let text = fs::read_to_string("/etc/os-release").ok()?;
    text.lines()
        .find_map(|line| line.strip_prefix("PRETTY_NAME="))
        .map(|v| v.trim_matches('"').to_string())
        .filter(|v| !v.is_empty())
}

#[cfg(not(target_os = "linux"))]
fn distro_name() -> Option<String> {
    None
}

#[cfg(target_os = "linux")]
fn gpu_name() -> Option<String> {
    // lspci da el nombre comercial. Es un binario local y la consulta es
    // instantánea; si no está instalado, se usa el PCI ID de /sys.
    if let Ok(out) = Command::new("lspci").args(["-mm", "-nn"]).output() {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let lower = line.to_ascii_lowercase();
                if !(lower.contains("vga compatible controller")
                    || lower.contains("3d controller")
                    || lower.contains("display controller"))
                {
                    continue;
                }
                let fields: Vec<&str> = line.split('"').collect();
                if fields.len() >= 6 {
                    let vendor = strip_pci_suffix(fields[3]);
                    let device = strip_pci_suffix(fields[5]);
                    let name = format!("{} {}", vendor, device).trim().to_string();
                    if !name.is_empty() {
                        return Some(name);
                    }
                }
            }
        }
    }
    gpu_from_sysfs()
}

#[cfg(not(target_os = "linux"))]
fn gpu_name() -> Option<String> {
    // En Windows/macOS el renderer de WebGL sí suele ser el real; el
    // frontend usa ese valor como respaldo. No se inventa un nombre aquí.
    None
}

#[cfg(target_os = "linux")]
fn gpu_from_sysfs() -> Option<String> {
    let entries = fs::read_dir("/sys/class/drm").ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("card") || name.contains('-') {
            continue;
        }
        let uevent = entry.path().join("device/uevent");
        let text = match fs::read_to_string(&uevent) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let pci_id = text
            .lines()
            .find_map(|line| line.strip_prefix("PCI_ID="))
            .unwrap_or("");
        let vendor_id = pci_id.split(':').next().unwrap_or("");
        let vendor = match vendor_id {
            "8086" => "Intel",
            "1002" => "AMD",
            "10de" => "NVIDIA",
            "1af4" => "Virtio",
            _ => "GPU",
        };
        if pci_id.is_empty() {
            continue;
        }
        return Some(format!("{} ({})", vendor, pci_id));
    }
    None
}

#[cfg(target_os = "linux")]
fn strip_pci_suffix(value: &str) -> &str {
    // lspci -nn añade " [8086]" o " [3185]" al vendor/device. Se muestra el
    // nombre legible, sin IDs entre corchetes.
    if let Some(pos) = value.rfind(" [") {
        if value.ends_with(']') {
            return value[..pos].trim();
        }
    }
    value.trim()
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn pci_suffix_is_removed() {
        assert_eq!(
            strip_pci_suffix("Intel Corporation [8086]"),
            "Intel Corporation"
        );
        assert_eq!(
            strip_pci_suffix("GeminiLake [UHD Graphics 600] [3185]"),
            "GeminiLake [UHD Graphics 600]"
        );
        assert_eq!(strip_pci_suffix("NVIDIA Corporation"), "NVIDIA Corporation");
    }
}
