use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_API_BASE: &str = "https://app.krakenchk.com/api";

pub fn api_base() -> String {
    match std::env::var("KRAKENGES_API_BASE") {
        Ok(v) if !v.is_empty() => v,
        _ => option_env!("KRAKENGES_API_BASE").unwrap_or(DEFAULT_API_BASE).to_string(),
    }
}

fn shared_client() -> &'static reqwest::Client {
    static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
        reqwest::Client::builder()
            .pool_max_idle_per_host(8)
            .tcp_keepalive(std::time::Duration::from_secs(60))
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("cliente HTTP")
    });
    &CLIENT
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ServerSession {
    access_token: String,
    refresh_token: String,
    // Cache del payload de login/register (incluye el ticket firmado).
    user: Option<Value>,
    ticket: Option<String>,
    // Última validación online correcta (epoch ms) para la ventana de gracia.
    last_online_check_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TicketPayloadView {
    pub tickets: u32,
}

fn session_path() -> PathBuf {
    let proj_dirs = directories::ProjectDirs::from("com", crate::brand::SLUG, "desktop")
        .expect("No se pudo determinar el directorio de usuario");
    proj_dirs.data_dir().join("server_session.json")
}

fn load_session() -> ServerSession {
    if let Ok(text) = std::fs::read_to_string(session_path()) {
        if let Ok(s) = serde_json::from_str::<ServerSession>(&text) {
            return s;
        }
    }
    ServerSession::default()
}

fn save_session(s: &ServerSession) -> Result<(), String> {
    let path = session_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("No se pudo crear dir de datos: {}", e))?;
    }
    let tmp = path.with_extension("json.tmp");
    let text =
        serde_json::to_string_pretty(s).map_err(|e| format!("No se pudo serializar sesión: {}", e))?;
    std::fs::write(&tmp, text).map_err(|e| format!("No se pudo escribir sesión: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("No se pudo guardar sesión: {}", e))
}

fn with_session<R>(f: impl FnOnce(&mut ServerSession) -> Result<R, String>) -> Result<R, String> {
    static SESSION: LazyLock<Mutex<ServerSession>> =
        LazyLock::new(|| Mutex::new(load_session()));
    let mut s = SESSION.lock().unwrap();
    let before = serde_json::to_string(&*s).ok();
    let result = f(&mut s);
    if result.is_ok() {
        // Solo persistir si la sesión cambió: las lecturas (p.ej. get token) ya no
        // reescriben server_session.json en cada comando.
        if serde_json::to_string(&*s).ok() != before {
            let _ = save_session(&s);
        }
    }
    result
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Ventana de gracia offline (días) antes de exigir volver a validar online.
const OFFLINE_GRACE_DAYS: u64 = 1;

pub fn offline_grace_ms() -> u64 {
    OFFLINE_GRACE_DAYS * 24 * 60 * 60 * 1000
}

fn http(client: &reqwest::Client, method: &str, url: &str, body: Option<&Value>, token: Option<&str>) -> reqwest::RequestBuilder {
    let mut b = client.request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), url);
    if let Some(t) = token {
        b = b.header("Authorization", format!("Bearer {}", t));
    }
    b = b.header("Content-Type", "application/json");
    if let Some(v) = body {
        b = b.json(v);
    }
    b
}

async fn call_api(
    client: &reqwest::Client,
    method: &str,
    path: &str,
    body: Option<&Value>,
    token: Option<&str>,
) -> Result<Value, String> {
    let url = format!("{}{}", api_base(), path);
    let resp = http(client, method, &url, body, token)
        .send()
        .await
        .map_err(|e| format!("No se pudo conectar con el servidor: {}", e))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Respuesta ilegible del servidor: {}", e))?;

    if !status.is_success() {
        let msg: Value = serde_json::from_str(&text).unwrap_or(Value::String(text.clone()));
        let error = msg
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or_else(|| &text);
        return Err(format!("{} (HTTP {})", error, status.as_u16()));
    }

    serde_json::from_str(&text).map_err(|_| format!("JSON inválido del servidor: {}", status))
}

fn store_session_from_payload(payload: &Value) -> Result<(), String> {
    let access = payload
        .get("accessToken")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Falta accessToken en la respuesta del servidor".to_string())?;
    let refresh = payload
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Falta refreshToken en la respuesta del servidor".to_string())?;
    let user = payload.get("user").cloned().unwrap_or(Value::Null);
    let ticket = user
        .get("ticket")
        .and_then(|t| t.as_str())
        .map(|t| t.to_string());

    with_session(|s| {
        s.access_token = access.to_string();
        s.refresh_token = refresh.to_string();
        if !user.is_null() {
            s.user = Some(user);
        }
        s.ticket = ticket;
        s.last_online_check_ms = Some(now_ms());
        Ok(())
    })
}

/// Renueva el par de tokens con el refresh token (POST /auth/refresh).
async fn refresh_tokens(client: &reqwest::Client) -> Result<(), String> {
    let refresh = with_session(|s| Ok(s.refresh_token.clone()))?;
    if refresh.is_empty() {
        return Err("Sesión expirada: vuelve a iniciar sesión.".to_string());
    }
    let payload = call_api(
        client,
        "POST",
        "/auth/refresh",
        Some(&json!({ "refreshToken": refresh })),
        None,
    )
    .await?;
    store_session_from_payload(&payload)
}

/// Llamada autenticada que renueva el access token automáticamente ante un 401.
async fn call_authed(
    client: &reqwest::Client,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, String> {
    let token = with_session(|s| Ok(s.access_token.clone()))?;
    match call_api(client, method, path, body, Some(&token)).await {
        Ok(v) => Ok(v),
        Err(e) if e.contains("HTTP 401") => {
            refresh_tokens(client).await?;
            let token2 = with_session(|s| Ok(s.access_token.clone()))?;
            call_api(client, method, path, body, Some(&token2)).await
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn server_login(username: String, password: String) -> Result<Value, String> {
    let client = shared_client().clone();
    let payload = call_api(
        &client,
        "POST",
        "/auth/login",
        Some(&json!({ "username": username, "password": password })),
        None,
    )
    .await?;
    store_session_from_payload(&payload)?;
    Ok(payload.get("user").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn server_register(
    name: String,
    username: String,
    email: Option<String>,
    password: String,
    key: Option<String>,
) -> Result<Value, String> {
    let client = shared_client().clone();
    let payload = call_api(
        &client,
        "POST",
        "/auth/register",
        Some(&json!({
            "name": name,
            "username": username,
            "email": email.unwrap_or_default(),
            "password": password,
            "key": key.unwrap_or_default(),
        })),
        None,
    )
    .await?;
    store_session_from_payload(&payload)?;
    Ok(payload.get("user").cloned().unwrap_or(Value::Null))
}

/// Devuelve el usuario en caché verificando el ticket offline; si el ticket no
/// es válido o pasó la ventana de gracia, intenta revalidar online.
#[tauri::command]
pub fn server_get_current_user() -> Result<Value, String> {
    let (user, ticket, online_check) = with_session(|s| {
        Ok((
            s.user.clone(),
            s.ticket.clone(),
            s.last_online_check_ms,
        ))
    })?;

    let user = user.ok_or_else(|| "No hay sesión activa".to_string())?;
    let ticket = ticket.ok_or_else(|| "No hay ticket de licencia en la sesión".to_string())?;

    // 1) Verificación offline de la firma del ticket (sin red).
    let verified = crate::license::verify_ticket_strict(&ticket)
        .map_err(|e| format!("Ticket de licencia inválido localmente: {}", e))?;

    // 2) Ventana de gracia offline.
    let plan_expired = verified
        .plan_expires_at_ms
        .map(|exp| exp <= now_ms() as i64)
        .unwrap_or(false);
    let grace_exceeded = online_check
        .map(|last| now_ms().saturating_sub(last) >= offline_grace_ms())
        .unwrap_or(true);

    if plan_expired {
        return Err("Tu suscripción ha expirado. Renueva tu licencia.".to_string());
    }
    if grace_exceeded {
        // Exige reconexión tras 24h para revalidar con el servidor
        return Err("La sesión requiere revalidación online. Conecta a internet para continuar.".to_string());
    }

    Ok(user)
}

/// Revalidación online: renueva el ticket (revocaciones/baneos/downgrades).
#[tauri::command]
pub async fn server_refresh_ticket() -> Result<Value, String> {
    let client = shared_client().clone();
    let res = call_authed(&client, "GET", "/auth/ticket", None).await;
    match res {
        Ok(payload) => {
            let user = payload.get("user").cloned().ok_or("Respuesta sin user")?;
            with_session(|s| {
                s.user = Some(user.clone());
                s.ticket = user.get("ticket").and_then(|t| t.as_str()).map(|t| t.to_string());
                s.last_online_check_ms = Some(now_ms());
                Ok(())
            })?;
            Ok(user)
        }
        Err(e) => {
            if e.contains("401") || e.contains("403") || e.contains("expirada") || e.contains("suspended") {
                let _ = with_session(|s| {
                    *s = ServerSession::default();
                    Ok(())
                });
            }
            Err(e)
        }
    }
}

/// Canje de clave de licencia en el servidor.
#[tauri::command]
pub async fn server_redeem_key(key: String) -> Result<Value, String> {
    let client = shared_client().clone();
    let token = with_session(|s| Ok(s.access_token.clone()))?;
    let payload = call_api(
        &client,
        "POST",
        "/membership/redeem",
        Some(&json!({ "key": key })),
        Some(&token),
    )
    .await?;
    // Recargar el ticket para reflejar el upgrade.
    server_refresh_ticket().await?;
    Ok(payload)
}

#[tauri::command]
pub async fn server_logout() -> Result<(), String> {
    let client = shared_client().clone();
    let refresh = with_session(|s| Ok(s.refresh_token.clone())).unwrap_or_default();
    if !refresh.is_empty() {
        let _ = call_api(
            &client,
            "POST",
            "/auth/logout",
            Some(&json!({ "refreshToken": refresh })),
            None,
        )
        .await;
    }
    with_session(|s| {
        *s = ServerSession::default();
        Ok(())
    })?;
    Ok(())
}

/// Lista de usuarios con sus stats/planes (requiere admin).
#[tauri::command]
pub async fn server_users_list() -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "GET", "/users", None).await
}

/// Banea / desbanea a un usuario (requiere admin).
#[tauri::command]
pub async fn server_ban_user(user_id: String, banned: bool) -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "PATCH", &format!("/users/{}/ban", user_id), Some(&json!({ "banned": banned })))
        .await
}

/// Elimina permanentemente un usuario y sus datos (requiere admin).
#[tauri::command]
pub async fn server_delete_user(user_id: String) -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "DELETE", &format!("/users/{}", user_id), None).await
}

/// Asigna rol y créditos de revendedor (requiere owner).
#[tauri::command]
pub async fn server_assign_role(
    user_id: String,
    role: String,
    seller_credits: Option<i64>,
) -> Result<Value, String> {
    let client = shared_client().clone();
    let mut body = json!({ "role": role });
    if let Some(c) = seller_credits {
        body["sellerCredits"] = json!(c);
    }
    call_authed(&client, "PATCH", &format!("/users/{}/role", user_id), Some(&body)).await
}

/// Cambia el plan de un usuario (requiere admin).
#[tauri::command]
pub async fn server_change_plan(
    user_id: String,
    plan: String,
    duration_days: Option<i64>,
    is_lifetime: Option<bool>,
) -> Result<Value, String> {
    let client = shared_client().clone();
    let mut body = json!({ "plan": plan });
    if let Some(d) = duration_days {
        body["durationDays"] = json!(d);
    }
    if let Some(l) = is_lifetime {
        body["isLifetime"] = json!(l);
    }
    call_authed(&client, "PATCH", &format!("/users/{}/plan", user_id), Some(&body)).await
}

/// Resetea la password de un usuario (requiere admin).
#[tauri::command]
pub async fn server_reset_password(user_id: String, password: String) -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(
        &client,
        "POST",
        &format!("/users/{}/reset-password", user_id),
        Some(&json!({ "password": password })),
    )
    .await
}

/// Resetea el HWID vinculado a una cuenta (requiere admin).
#[tauri::command]
pub async fn server_reset_hwid(user_id: String) -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "POST", &format!("/users/{}/reset-hwid", user_id), None).await
}

/// Lista de claves de licencia (seller: solo las propias; admin todos).
#[tauri::command]
pub async fn server_keys_list() -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "GET", "/keys", None).await
}

/// Acuña N claves en el servidor (descuenta créditos si es seller).
#[tauri::command]
pub async fn server_mint_keys(
    plan: String,
    duration_days: i64,
    count: i64,
    role: Option<String>,
    tag: Option<String>,
) -> Result<Value, String> {
    let client = shared_client().clone();
    let mut body = json!({
        "plan": plan,
        "durationDays": duration_days,
        "count": count,
        "tag": tag.unwrap_or_default(),
    });
    if let Some(r) = role {
        body["role"] = json!(r);
    }
    call_authed(
        &client,
        "POST",
        "/keys",
        Some(&body),
    )
    .await
}

/// Métricas globales de la plataforma (requiere admin).
#[tauri::command]
pub async fn server_get_analytics() -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "GET", "/users/admin/analytics", None).await
}

/// Exportación parcial de usuarios, claves y perfiles (requiere admin).
#[tauri::command]
pub async fn server_export_backup() -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "GET", "/users/admin/backup", None).await
}

/// Borra las sesiones detenidas hace más de 30 días (requiere admin).
#[tauri::command]
pub async fn server_purge_sessions() -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "POST", "/users/admin/purge-sessions", None).await
}

/// Uso y vigencia del plan de la cuenta propia (perfiles, sesiones, API keys).
#[tauri::command]
pub async fn server_membership_usage() -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "GET", "/membership/usage", None).await
}

/// Feed de actividad. Admin/Owner: global; resto: solo la propia.
#[tauri::command]
pub async fn server_get_activity() -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "GET", "/activity", None).await
}

/// Actualiza datos propios (hoy: nombre).
#[tauri::command]
pub async fn server_update_profile(name: String) -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "PATCH", "/users/me", Some(&json!({ "name": name }))).await
}

/// Cambia la contraseña de la cuenta propia.
#[tauri::command]
pub async fn server_change_password(current_password: String, new_password: String) -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(
        &client,
        "POST",
        "/users/me/change-password",
        Some(&json!({ "currentPassword": current_password, "newPassword": new_password })),
    )
    .await
}

/// Revoca una clave (estado active -> revoked).
#[tauri::command]
pub async fn server_revoke_key(key_id: String) -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(
        &client,
        "PATCH",
        &format!("/keys/{}", key_id),
        Some(&json!({ "status": "revoked" })),
    )
    .await
}

/// Elimina una clave definitivamente (requiere admin/owner o seller propietario).
#[tauri::command]
pub async fn server_delete_key(key_id: String) -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "DELETE", &format!("/keys/{}", key_id), None).await
}

/// Perfiles de navegación del usuario autenticado.
#[tauri::command]
pub async fn server_profiles_list() -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "GET", "/profiles", None).await
}

/// Tags únicos existentes entre los perfiles del usuario.
#[tauri::command]
pub async fn server_profiles_tags() -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "GET", "/profiles/tags", None).await
}

/// Receta de huella dictada por el servidor para un perfil del usuario.
/// POST /api/fingerprint { profileId } -> { seed, os, identity }.
#[tauri::command]
pub async fn server_fingerprint(profile_id: String) -> Result<Value, String> {
    let client = shared_client().clone();
    let body = json!({ "profileId": profile_id });
    call_authed(&client, "POST", "/fingerprint", Some(&body)).await
}

/// Crea un perfil de navegación en el servidor.
#[tauri::command]
pub async fn server_create_profile(
    name: String,
    start_url: Option<String>,
    tags: Option<Vec<String>>,
    notes: Option<String>,
    os: Option<String>,
) -> Result<Value, String> {
    let client = shared_client().clone();
    let mut body = json!({ "name": name });
    if let Some(s) = start_url { body["startUrl"] = json!(s); }
    if let Some(t) = tags { body["tags"] = json!(t); }
    if let Some(n) = notes { body["notes"] = json!(n); }
    if let Some(o) = os { body["os"] = json!(o); }
    call_authed(&client, "POST", "/profiles", Some(&body)).await
}

/// Actualiza un perfil en el servidor.
#[tauri::command]
pub async fn server_update_profile_by_id(
    profile_id: String,
    name: Option<String>,
    start_url: Option<String>,
    tags: Option<Vec<String>>,
    notes: Option<String>,
    os: Option<String>,
) -> Result<Value, String> {
    let client = shared_client().clone();
    let mut body = json!({});
    if let Some(n) = name { body["name"] = json!(n); }
    if let Some(s) = start_url { body["startUrl"] = json!(s); }
    if let Some(t) = tags { body["tags"] = json!(t); }
    if let Some(n) = notes { body["notes"] = json!(n); }
    if let Some(o) = os { body["os"] = json!(o); }
    call_authed(&client, "PATCH", &format!("/profiles/{}", profile_id), Some(&body)).await
}

/// Elimina un perfil en el servidor.
#[tauri::command]
pub async fn server_delete_profile(profile_id: String) -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "DELETE", &format!("/profiles/{}", profile_id), None).await
}

/// Sesiones del usuario autenticado (opcionalmente filtradas por estado).
#[tauri::command]
pub async fn server_sessions_list(status: Option<String>) -> Result<Value, String> {
    let client = shared_client().clone();
    let path = match status {
        Some(s) => format!("/sessions?status={}", s),
        None => "/sessions".to_string(),
    };
    call_authed(&client, "GET", &path, None).await
}

/// Inicia una sesión con un perfil (limita por plan: max sessions activas).
#[tauri::command]
pub async fn server_start_session(profile_id: String) -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "POST", "/sessions/start", Some(&json!({ "profileId": profile_id }))).await
}

/// Alias de server_start_session para compatibilidad con invocaciones de creación de sesión.
#[tauri::command]
pub async fn server_create_session(profile_id: String) -> Result<Value, String> {
    server_start_session(profile_id).await
}

/// Detiene una sesión activa.
#[tauri::command]
pub async fn server_stop_session(session_id: String) -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "POST", &format!("/sessions/{}/stop", session_id), Some(&json!({}))).await
}

/// Reactiva una sesión detenida.
#[tauri::command]
pub async fn server_reactivate_session(session_id: String) -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "POST", &format!("/sessions/{}/reactivate", session_id), Some(&json!({}))).await
}

/// Elimina una sesión.
#[tauri::command]
pub async fn server_delete_session(session_id: String) -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "DELETE", &format!("/sessions/{}", session_id), None).await
}

/// Métricas del dashboard del usuario autenticado (conteos, límites por plan, actividad).
#[tauri::command]
pub async fn server_get_dashboard() -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "GET", "/dashboard", None).await
}

/// Contenido público versionado (precios, textos y tema activo).
///
/// Es una lectura pública: no envía el token del usuario ni necesita sesión.
/// El cliente la usa con caché y cae a sus valores locales si falla.
#[tauri::command]
pub async fn server_get_public_content() -> Result<Value, String> {
    let client = shared_client().clone();
    call_api(&client, "GET", "/content", None, None).await
}

/// Contenido editable actual (requiere owner/admin).
#[tauri::command]
pub async fn server_content_admin_get() -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "GET", "/content/admin", None).await
}

/// Valida el contenido sin publicarlo (requiere owner/admin).
#[tauri::command]
pub async fn server_content_preview(content: Value) -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "POST", "/content/preview", Some(&content)).await
}

/// Publica una nueva versión del contenido (requiere owner/admin).
#[tauri::command]
pub async fn server_content_publish(content: Value) -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "PUT", "/content", Some(&content)).await
}

/// Lista las versiones archivadas del contenido (requiere owner/admin).
#[tauri::command]
pub async fn server_content_history() -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "GET", "/content/history", None).await
}

/// Restaura una versión archivada como publicación nueva (requiere owner/admin).
#[tauri::command]
pub async fn server_content_revert(id: String) -> Result<Value, String> {
    let client = shared_client().clone();
    call_authed(&client, "POST", "/content/revert", Some(&json!({ "id": id }))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_base_allows_runtime_override() {
        // Sin var seteada usa el default compilado (dev).
        if std::env::var("KRAKENGES_API_BASE").is_err() {
            assert!(!api_base().is_empty());
        }
    }

    /// El test afirmaba 7 días mientras la constante vale 1: `cargo test --lib`
    /// fallaba. Ahora se deriva de la constante para que no vuelva a divergir.
    /// Si la política de producto es otra, cambia `OFFLINE_GRACE_DAYS`.
    #[test]
    fn offline_grace_matches_constant() {
        assert_eq!(offline_grace_ms(), OFFLINE_GRACE_DAYS * 24 * 60 * 60 * 1000);
        assert_eq!(offline_grace_ms(), 24 * 60 * 60 * 1000);
    }
}