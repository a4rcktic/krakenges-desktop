//! Guardia anti-integridad y anti-debug para entornos de producción.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

#[tauri::command]
pub fn get_guard_status() -> serde_json::Value {
    serde_json::json!({
        "debugger_detected": is_debugger_detected(),
        "detection_count": detection_count(),
        "tamper_flag": tamper_flag(),
        "debug_build": cfg!(debug_assertions),
    })
}

static DEBUGGER_DETECTED: AtomicBool = AtomicBool::new(false);
/// Contador de detecciones para diagnóstico.
static DETECTION_COUNT: AtomicU8 = AtomicU8::new(0);
/// 0 = no hard, 1 = hard tamper (requiere KRAKEN_HARD_TAMPER=1 o binary patch).
static TAMPER_FLAG: AtomicU8 = AtomicU8::new(0);

pub fn is_debugger_detected() -> bool {
    DEBUGGER_DETECTED.load(Ordering::Relaxed)
}

pub fn detection_count() -> u8 {
    DETECTION_COUNT.load(Ordering::Relaxed)
}

pub fn tamper_flag() -> u8 {
    TAMPER_FLAG.load(Ordering::Relaxed)
}

fn safe_mode_enabled() -> bool {
    std::env::var("KRAKEN_SAFE_MODE").as_deref() == Ok("1")
}

fn hard_mode_enabled() -> bool {
    !cfg!(debug_assertions) && std::env::var("KRAKEN_HARD_TAMPER").as_deref() == Ok("1")
}

/// Linux: detecta que un debugger está adherido al proceso leyendo TracerPid
/// del kernel (/proc/self/status). Es un hecho del kernel: un gdb/lldb/strace/
/// ptrace-attach lo deja != 0. Sin debugger es 0 siempre -> sin false positives.
#[cfg(target_os = "linux")]
fn read_tracer_pid() -> Option<u32> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("TracerPid:") {
            return rest.trim().parse::<u32>().ok();
        }
    }
    None
}

/// Linux: detección adicional de self-attach vía ptrace(PTRACE_TRACEME) no se
/// implementa (dependería de libc inline); TracerPid es el equivalente de
/// kernel y más fiable.

#[cfg(target_os = "windows")]
fn is_debugger_present_windows() -> bool {
    const PEB_BEING_DEBUGGED_OFFSET: usize = 0x02;
    #[cfg(target_arch = "x86_64")]
    unsafe {
        let peb: usize;
        std::arch::asm!("mov {0}, gs:[0x60]", out(reg) peb);
        *((peb as *const u8).add(PEB_BEING_DEBUGGED_OFFSET)) != 0
    }
    #[cfg(not(target_arch = "x86_64"))]
    false
}

/// Ejecuta la guardia una vez al arrancar (main + entry, antes de la UI).
/// Devuelve true si detectó algo (log + flag), nunca bloquea salvo con
/// KRAKEN_HARD_TAMPER=1 explícito.
pub fn run_startup_guard() -> bool {
    if safe_mode_enabled() {
        return false;
    }

    let mut detected = false;

    #[cfg(target_os = "linux")]
    {
        if let Some(pid) = read_tracer_pid() {
            if pid != 0 {
                detected = true;
                eprintln!(
                    "[guard] debugger detectado (TracerPid={}). Bandera activada, no se bloquea.",
                    pid
                );
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if is_debugger_present_windows() {
            detected = true;
            eprintln!("[guard] debugger detectado (PEB.BeingDebugged).");
        }
    }

    if detected {
        mark_detection();
        if hard_mode_enabled() {
            eprintln!("[guard] KRAKEN_HARD_TAMPER=1: abortando por detección.");
            std::process::exit(1);
        }
    }

    detected
}

/// Registra una detección (compartida) y sube la bandera de tamper.
pub fn mark_detection() {
    DETECTION_COUNT.fetch_add(1, Ordering::Relaxed);
    DEBUGGER_DETECTED.store(true, Ordering::Relaxed);
    let flag = TAMPER_FLAG.load(Ordering::Relaxed).saturating_add(1);
    TAMPER_FLAG.store(flag, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracer_pid_parser_returns_zero_when_clean() {
        // Sin debugger: leyendo nuestro propio /proc/self/status.
        if cfg!(target_os = "linux") {
            let pid = read_tracer_pid();
            // En entorno de test normal no hay tracer. Permitimos == 0.
            assert!(pid.is_some());
            assert_eq!(pid, Some(0));
        }
    }

    #[test]
    fn mark_detection_increments_and_sets_flags() {
        mark_detection();
        assert!(is_debugger_detected());
        assert!(detection_count() >= 1);
        assert!(tamper_flag() >= 1);
    }

    #[test]
    fn safe_mode_disables_guard() {
        std::env::set_var("KRAKEN_SAFE_MODE", "1");
        assert!(!run_startup_guard());
        std::env::remove_var("KRAKEN_SAFE_MODE");
    }
}