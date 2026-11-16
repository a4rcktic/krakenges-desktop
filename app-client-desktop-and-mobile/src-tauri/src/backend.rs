//! Backend local de datos de Kraken Ges.
//!
//! Reemplaza la capa HTTP contra el SaaS que la UI
//! usaba en el port de Electron: ahora usuarios, planes, licencias, perfiles y
//! sesiones viven en un único archivo JSON dentro del directorio de datos de la
//! app (`~/.local/share/com.krakenges.desktop/krakenges_db.json` en Linux), protegido
//! con contraseñas derivadas con PBKDF2-SHA256 (no se guardan en claro).

use pbkdf2::pbkdf2_hmac_array;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// Nombre de usuario del propietario que se crea automáticamente en el primer
/// arranque (rol owner, plan enterprise, sin límites).
///
/// La contraseña NUNCA vive en el código fuente: quedó expuesta en el binario
/// distribuido con `strings` en una rotación anterior. Ahora se resuelve en
/// este orden:
///   1. Variable de entorno `KRAKENGES_OWNER_PASSWORD` (instalaciones gestionadas).
///   2. Primera ejecución: se genera una clave aleatoria fuerte y se escribe en
///      `<data_dir>/owner_credentials.txt` con permisos 0600, fuera del repo.
const OWNER_USERNAME: &str = "admin";
const OWNER_PASSWORD_ENV: &str = "KRAKENGES_OWNER_PASSWORD";
const OWNER_CREDS_FILE: &str = "owner_credentials.txt";

/// Resuelve la contraseña inicial del propietario local.
/// Devuelve `None` si no hay env var (=> generar una y persistirla).
fn owner_password_from_env() -> Option<String> {
    match std::env::var(OWNER_PASSWORD_ENV) {
        Ok(v) if !v.trim().is_empty() => Some(v),
        _ => None,
    }
}

/// Genera una contraseña fuerte para el propietario (48 hex = 192 bits).
fn generate_owner_password() -> String {
    random_hex(24)
}

/// Contraseña del propietario para el primer arranque. Persiste la generada en
/// un archivo 0600 para que el operador pueda recuperarla, y la devuelve.
fn resolve_owner_password() -> String {
    if let Some(pw) = owner_password_from_env() {
        return pw;
    }
    let pw = generate_owner_password();
    if let Some(dir) = data_dir() {
        // El directorio puede no existir todavia (es el primer arranque), y sin
        // el la clave generada seria irrecuperable para el operador.
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(OWNER_CREDS_FILE);
        let body = format!(
            "Kraken Ges - credenciales del propietario local (generadas en el primer arranque)\n\
             usuario: {}\ncontrasena: {}\n\n\
             Cambia esta contrasena desde Ajustes tras el primer inicio.\n",
            OWNER_USERNAME, pw
        );
        if std::fs::write(&path, body).is_ok() {
            harden_file_permissions(&path);
        } else {
            // Fallar ruidosamente: mejor que arranque que deje al usuario fuera
            // de su propia instalacion sin saber la clave.
            eprintln!(
                "[krakenges] AVISO: no se pudo escribir {} con la contrasena del propietario.\n\
                 [krakenges] Define la variable de entorno {} o crea el directorio manualmente.",
                path.display(),
                OWNER_PASSWORD_ENV
            );
        }
    }
    pw
}

/// Versión del esquema del `krakenges_db.json` local.
///
/// v2 = la contraseña del propietario deja de estar en el código y se rotó.
/// Las bases creadas antes de esta versión (las que se sembraron con la clave
/// que se filtró en el binario) se migran al arrancar.
const SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Db {
    /// `#[serde(default)]` para que un `krakenges_db.json` antiguo (sin el campo)
    /// siga deserializando: se interpreta como v0 y se migra.
    #[serde(default)]
    schema_version: u32,
    current_user_id: Option<String>,
    users: Vec<User>,
    profiles: Vec<Profile>,
    sessions: Vec<Session>,
    license_keys: Vec<LicenseKey>,
    activity: Vec<Activity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct User {
    id: String,
    name: String,
    username: String,
    email: String,
    password_hash: String,
    salt: String,
    role: String, // owner | admin | seller | user
    plan: String, // free | pro | specter | enterprise
    banned: bool,
    hwid: Option<String>,
    seller_credits: u32,
    created_at: u64,
    last_login_at: Option<u64>,
    expires_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Profile {
    id: String,
    name: String,
    proxy: Option<String>,
    start_url: Option<String>,
    tags: Vec<String>,
    notes: Option<String>,
    os: String,
    user_id: String,
    created_at: u64,
    updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Session {
    id: String,
    profile_id: String,
    profile_name: String,
    profile_proxy: Option<String>,
    user_id: String,
    status: String, // active | stopped
    started_at: u64,
    stopped_at: Option<u64>,
    duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LicenseKey {
    id: String,
    key: String,
    plan: String,
    duration_days: i64,
    role: String,
    status: String, // active | redeemed | revoked | expired
    tag: Option<String>,
    created_by: Option<String>,
    redeemed_by: Option<String>,
    redeemed_at: Option<u64>,
    created_at: u64,
    expires_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Activity {
    id: String,
    action: String,
    entity: String,
    details: Option<Value>,
    ip: Option<String>,
    created_at: u64,
}

impl Default for Db {
    fn default() -> Self {
        Self::seeded()
    }
}

impl Db {
    /// Primer arranque: crea el propietario local (owner / enterprise).
    fn seeded() -> Self {
        let salt = random_bytes(16);
        let now = now_ms();
        let owner_password = resolve_owner_password();
        let owner = User {
            id: new_id(),
            name: "Stranger".to_string(),
            username: OWNER_USERNAME.to_string(),
            email: "admin@krakenges.local".to_string(),
            password_hash: hash_password(&owner_password, &salt),
            salt: hex(&salt),
            role: "owner".to_string(),
            plan: "enterprise".to_string(),
            banned: false,
            hwid: None,
            seller_credits: 0,
            created_at: now,
            last_login_at: None,
            expires_at: None,
        };
        let mut db = Db {
            schema_version: SCHEMA_VERSION,
            current_user_id: None,
            users: vec![owner],
            profiles: Vec::new(),
            sessions: Vec::new(),
            license_keys: Vec::new(),
            activity: Vec::new(),
        };
        db.log_activity(
            "system_init",
            "db",
            json!({"message": "Base de datos local inicializada. Propietario creado."}),
        );
        db
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 24 caracteres hexadecimales aleatorios (id local).
fn new_id() -> String {
    hex(&random_bytes(12))
}

/// Bytes aleatorios criptográficos. Falla ruidosamente si el SO no puede
/// aportarlos: devolver un buffer de ceros produciría salts, ids y claves de
/// licencia predecibles sin ningún aviso.
fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    getrandom::getrandom(&mut buf)
        .expect("Fallo del generador de aleatoriedad del sistema (getrandom)");
    buf
}

/// `n` bytes aleatorios en hexadecimal => `2n` caracteres.
fn random_hex(n: usize) -> String {
    hex(&random_bytes(n))
}

fn hash_password(password: &str, salt: &[u8]) -> String {
    const ROUNDS: u32 = 120_000;
    let digest: [u8; 32] = pbkdf2_hmac_array::<Sha256, 32>(password.as_bytes(), salt, ROUNDS);
    hex(&digest)
}

fn verify_password(password: &str, salt_hex: &str, expected: &str) -> bool {
    let salt = hex_to_bytes(salt_hex);
    hash_password(password, &salt) == expected
}

fn hex_to_bytes(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(&s[i..(i + 2).min(s.len())], 16).ok())
        .collect()
}

/// Normaliza un plan aceptando los alias de la UI (Ghost/Shadow/Phantom).
fn canonical_plan(plan: &str) -> String {
    match plan.to_lowercase().as_str() {
        "ghost" => "free".into(),
        "shadow" => "pro".into(),
        "phantom" | "phantom prime" => "enterprise".into(),
        other => other.into(),
    }
}

fn plan_profile_limit(plan: &str) -> Option<u32> {
    match plan {
        "free" => Some(5),
        "pro" => Some(50),
        "specter" => Some(200),
        _ => None, // enterprise / ilimitado
    }
}

fn plan_session_limit(plan: &str) -> Option<u32> {
    match plan {
        "free" => Some(2),
        "pro" => Some(10),
        "specter" => Some(30),
        _ => None,
    }
}

fn plan_price(plan: &str) -> u32 {
    match plan {
        "pro" => 29,
        "specter" => 79,
        "enterprise" => 199,
        _ => 0,
    }
}

fn is_key_format(s: &str) -> bool {
    let t = s.trim().to_uppercase();
    // `MSK-` es el formato que genera el servidor y el que muestra la UI.
    // `MASK-` se acepta por compatibilidad con claves locales antiguas.
    (t.starts_with("MSK-") || t.starts_with("MASK-")) && t.len() >= 19
}

/// Genera una clave de licencia con un alfabeto sin caracteres ambiguos.
fn new_key() -> String {
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let rnd = random_bytes(16);
    let group = |g: usize| -> String {
        (0..4)
            .map(|i| CHARS[(rnd[g * 4 + i] as usize) % CHARS.len()] as char)
            .collect()
    };
    format!("MSK-{}-{}-{}-{}", group(0), group(1), group(2), group(3))
}

/// Directorio de datos local de la app. `None` si el SO no lo determina.
/// Delegado en `paths` para no duplicar la resolución del directorio.
fn data_dir() -> Option<PathBuf> {
    crate::paths::data_dir()
}

fn db_path() -> PathBuf {
    data_dir()
        .expect("No se pudo determinar el directorio de usuario")
        .join("krakenges_db.json")
}

/// Restringe el archivo a lectura/escritura del dueño (0600). No-op fuera de Unix.
fn harden_file_permissions(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn load_db() -> Db {
    let path = db_path();
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(mut db) = serde_json::from_str::<Db>(&text) {
            migrate(&mut db);
            return db;
        }
    }
    Db::default()
}

/// Aplica las migraciones pendientes al cargar la base.
///
/// v0 -> v2: las bases sembradas antes de externalizar la credencial del owner
/// tienen su hash derivado de una clave que estuvo publicada en el binario
/// distribuido. Como PBKDF2 es determinista no se puede "invalidar" el hash:
/// hay que fijar una clave nueva. Se detecta por versión de esquema, sin
/// necesidad de conservar la clave filtrada en el código.
fn migrate(db: &mut Db) {
    migrate_with(db, resolve_owner_password());
}

/// Núcleo de la migración, aislado para poder testearlo sin tocar variables de
/// entorno ni escribir ficheros.
fn migrate_with(db: &mut Db, new_password: String) {
    if db.schema_version >= SCHEMA_VERSION {
        return;
    }
    let from = db.schema_version;
    let rotated = rotate_owner_password(db, &new_password);
    db.schema_version = SCHEMA_VERSION;
    db.log_activity(
        "security_migration",
        "db",
        json!({
            "from": from,
            "to": SCHEMA_VERSION,
            "owners_rotated": rotated,
            "message": "Credencial del propietario rotada por estar expuesta en versiones anteriores."
        }),
    );
    eprintln!(
        "[krakenges] Base de datos migrada de v{} a v{}: se rotó la contraseña de {} propietario(s). \
         Nueva contraseña en {}",
        from,
        SCHEMA_VERSION,
        rotated,
        OWNER_CREDS_FILE
    );
}

/// Rota la clave de todas las cuentas de propietario (la única que pudo
/// sembrarse con la credencial filtrada). El usuario, el rol y el resto de la
/// cuenta se conservan intactos. Devuelve cuántos owners se rotaron.
fn rotate_owner_password(db: &mut Db, new_password: &str) -> usize {
    let ids: Vec<String> = db
        .users
        .iter()
        .filter(|u| u.role == "owner")
        .map(|u| u.id.clone())
        .collect();
    for id in &ids {
        if let Some(u) = db.find_user_mut(id) {
            let salt = random_bytes(16);
            u.salt = hex(&salt);
            u.password_hash = hash_password(new_password, &salt);
        }
    }
    ids.len()
}

fn save_db(db: &Db) -> Result<(), String> {
    let path = db_path();
    if let Some(dir) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            return Err(format!("Error creando directorio de datos: {}", e));
        }
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(db).map_err(|e| format!("Error serializando: {}", e))?;
    std::fs::write(&tmp, text).map_err(|e| format!("Error escribiendo base: {}", e))?;
    // El fichero contiene hashes, tokens de sesión y proxys: 0600, nunca 0644.
    harden_file_permissions(&tmp);
    std::fs::rename(&tmp, &path).map_err(|e| format!("Error guardando base: {}", e))
}

fn with_db<R>(f: impl FnOnce(&mut Db) -> Result<R, String>) -> Result<R, String> {
    static DB: LazyLock<Mutex<Db>> = LazyLock::new(|| Mutex::new(load_db()));
    let mut db = DB.lock().unwrap();
    let result = f(&mut db);
    if result.is_ok() {
        save_db(&db)?;
    }
    result
}

impl Db {
    fn current(&self) -> Option<&User> {
        self.current_user_id
            .as_ref()
            .and_then(|id| self.users.iter().find(|u| &u.id == id))
    }

    fn find_user(&self, id: &str) -> Option<&User> {
        self.users.iter().find(|u| u.id == id)
    }

    fn find_user_mut(&mut self, id: &str) -> Option<&mut User> {
        self.users.iter_mut().find(|u| u.id == id)
    }

    fn is_admin(&self) -> bool {
        self.current()
            .map(|u| matches!(u.role.as_str(), "owner" | "admin"))
            .unwrap_or(false)
    }

    fn require_admin(&self) -> Result<(), String> {
        if self.is_admin() {
            Ok(())
        } else {
            Err("Se requieren privilegios de administrador".to_string())
        }
    }

    fn scope_user_id(&self) -> String {
        self.current()
            .map(|u| u.id.clone())
            .unwrap_or_else(|| "unknown".to_string())
    }

    fn log_activity(&mut self, action: &str, entity: &str, details: Value) {
        self.activity.push(Activity {
            id: new_id(),
            action: action.to_string(),
            entity: entity.to_string(),
            details: Some(details),
            ip: None,
            created_at: now_ms(),
        });
        if self.activity.len() > 400 {
            self.activity.drain(..(self.activity.len() - 400));
        }
    }

    fn add_user(
        &mut self,
        name: &str,
        username: &str,
        email: &str,
        password: &str,
        role: &str,
        plan: &str,
    ) -> Result<User, String> {
        let uname = username.trim().to_lowercase();
        if uname.is_empty() {
            return Err("El nombre de usuario es obligatorio".into());
        }
        if self.users.iter().any(|u| u.username.to_lowercase() == uname) {
            return Err("Ese nombre de usuario ya está en uso".into());
        }
        if password.len() < 4 {
            return Err("La contraseña debe tener al menos 4 caracteres".into());
        }
        let salt = random_bytes(16);
        let user = User {
            id: new_id(),
            name: if name.trim().is_empty() {
                username.to_string()
            } else {
                name.to_string()
            },
            username: username.to_string(),
            email: email.trim().to_string(),
            password_hash: hash_password(password, &salt),
            salt: hex(&salt),
            role: role.to_string(),
            plan: plan.to_string(),
            banned: false,
            hwid: None,
            seller_credits: 0,
            created_at: now_ms(),
            last_login_at: None,
            expires_at: None,
        };
        self.users.push(user.clone());
        Ok(user)
    }
}

fn public_user(u: &User) -> Value {
    json!({
        "id": u.id,
        "name": u.name,
        "username": u.username,
        "email": u.email,
        "isAdmin": matches!(u.role.as_str(), "owner" | "admin"),
        "role": u.role,
        "plan": u.plan,
        "sellerCredits": u.seller_credits,
        "banned": u.banned,
    })
}

fn admin_user(u: &User, db: &Db) -> Value {
    let prof_current = db.profiles.iter().filter(|p| p.user_id == u.id).count();
    let sess_current = db
        .sessions
        .iter()
        .filter(|s| s.user_id == u.id && s.status == "active")
        .count();
    let keys_current = db
        .license_keys
        .iter()
        .filter(|k| k.redeemed_by.as_deref() == Some(u.id.as_str()))
        .count();
    let max_p = plan_profile_limit(&u.plan).unwrap_or(999999);
    let max_s = plan_session_limit(&u.plan).unwrap_or(999);
    let max_k = if u.plan == "enterprise" { 999999 } else { 10 };
    json!({
        "id": u.id,
        "name": u.name,
        "username": u.username,
        "email": u.email,
        "isAdmin": matches!(u.role.as_str(), "owner" | "admin"),
        "role": u.role,
        "sellerCredits": u.seller_credits,
        "banned": u.banned,
        "plan": u.plan,
        "hwid": u.hwid,
        "createdAt": u.created_at,
        "lastLoginAt": u.last_login_at,
        "stats": {
            "profiles": { "current": prof_current, "max": max_p },
            "activeSessions": { "current": sess_current, "max": max_s },
            "apiKeys": { "current": keys_current, "max": max_k }
        }
    })
}

fn profile_json(p: &Profile) -> Value {
    json!({
        "id": p.id,
        "_id": p.id,
        "name": p.name,
        "proxy": p.proxy,
        "start_url": p.start_url,
        "startUrl": p.start_url,
        "tags": p.tags,
        "notes": p.notes,
        "os": p.os,
        "createdAt": p.created_at,
        "updatedAt": p.updated_at,
    })
}

fn session_json(s: &Session, db: &Db) -> Value {
    let profile = db
        .profiles
        .iter()
        .find(|p| p.id == s.profile_id)
        .map(profile_json)
        .unwrap_or(Value::Null);
    json!({
        "id": s.id,
        "_id": s.id,
        "status": s.status,
        "profile_id": s.profile_id,
        "profileId": {
            "id": s.profile_id,
            "_id": s.profile_id,
            "name": s.profile_name,
            "proxy": s.profile_proxy,
            "start_url": profile.get("start_url").cloned().unwrap_or(Value::Null),
            "os": profile.get("os").cloned().unwrap_or_else(|| json!("windows")),
        },
        "profile_name": s.profile_name,
        "profileName": s.profile_name,
        "started_at": s.started_at,
        "startedAt": s.started_at,
        "createdAt": s.started_at,
        "stopped_at": s.stopped_at,
        "stoppedAt": s.stopped_at,
        "duration": s.duration_ms,
        "duration_ms": s.duration_ms,
    })
}

fn key_json(k: &LicenseKey, db: &Db) -> Value {
    let by = |uid: &Option<String>| -> Value {
        match uid.as_deref().and_then(|id| db.find_user(id)) {
            Some(u) => json!({
                "name": u.name,
                "username": u.username,
                "email": u.email,
            }),
            None => Value::Null,
        }
    };
    json!({
        "_id": k.id,
        "id": k.id,
        "key": k.key,
        "plan": k.plan,
        "durationDays": k.duration_days,
        "role": k.role,
        "status": k.status,
        "tag": k.tag,
        "createdBy": by(&k.created_by),
        "redeemedBy": by(&k.redeemed_by),
        "redeemedAt": k.redeemed_at,
        "createdAt": k.created_at,
        "expiresAt": k.expires_at,
    })
}

fn user_belongs(db: &Db, user_id: &str) -> bool {
    db.current()
        .map(|u| matches!(u.role.as_str(), "owner" | "admin") || u.id == user_id)
        .unwrap_or(false)
}

#[tauri::command]
pub fn login(username: String, password: String) -> Result<Value, String> {
    with_db(|db| {
        let uname = username.trim().to_lowercase();
        let user = db
            .users
            .iter()
            .find(|u| u.username.to_lowercase() == uname || u.email.to_lowercase() == uname)
            .ok_or_else(|| "Credenciales inválidas".to_string())?
            .clone();
        if user.banned {
            return Err("Esta cuenta está suspendida. Contacta al administrador.".into());
        }
        if let Some(exp) = user.expires_at {
            if exp < now_ms() {
                return Err(
                    "Tu suscripción ha expirado. Contacta al administrador para renovarla.".into(),
                );
            }
        }
        if !verify_password(&password, &user.salt, &user.password_hash) {
            return Err("Credenciales inválidas".into());
        }
        if let Some(u) = db.find_user_mut(&user.id) {
            u.last_login_at = Some(now_ms());
        }
        db.current_user_id = Some(user.id.clone());
        db.log_activity("login", "auth", json!({"username": user.username}));
        Ok(public_user(&user))
    })
}

#[tauri::command]
pub fn register(
    name: String,
    username: String,
    email: Option<String>,
    password: String,
    key: Option<String>,
) -> Result<Value, String> {
    with_db(|db| {
        let mut user = db.add_user(
            &name,
            &username,
            email.as_deref().unwrap_or(""),
            &password,
            "user",
            "free",
        )?;
        let redeem = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
        if let Some(license) = redeem {
            let (plan, role) = redeem_key(db, &user.id, &license)?;
            if let Some(u) = db.find_user_mut(&user.id) {
                if u.role != "owner" && role != "user" {
                    u.role = role;
                }
                u.plan = plan;
            }
            user.plan = db.find_user(&user.id).map(|u| u.plan.clone()).unwrap_or_default();
        }
        db.current_user_id = Some(user.id.clone());
        db.log_activity("register", "auth", json!({"username": user.username, "plan": user.plan}));
        Ok(public_user(&user))
    })
}

#[tauri::command]
pub fn logout() -> Result<(), String> {
    with_db(|db| {
        db.current_user_id = None;
        Ok(())
    })
}

#[tauri::command]
pub fn get_current_user() -> Result<Option<Value>, String> {
    with_db(|db| Ok(db.current().map(public_user)))
}

fn redeem_key(db: &mut Db, user_id: &str, license: &str) -> Result<(String, String), String> {
    let body = license.trim().to_uppercase();
    let key = db
        .license_keys
        .iter_mut()
        .find(|k| k.key == body)
        .ok_or_else(|| "Clave de licencia inválida".to_string())?;
    if key.status != "active" {
        return Err("La clave ya fue utilizada o está revocada".into());
    }
    let now = now_ms();
    if let Some(exp) = key.expires_at {
        if exp < now {
            key.status = "expired".to_string();
            return Err("La clave ha expirado".into());
        }
    }
    key.status = "redeemed".to_string();
    key.redeemed_by = Some(user_id.to_string());
    key.redeemed_at = Some(now);
    Ok((canonical_plan(&key.plan), key.role.clone()))
}

#[tauri::command]
pub fn get_profiles() -> Result<Vec<Value>, String> {
    with_db(|db| {
        let admin = db.is_admin();
        let uid = db.scope_user_id();
        Ok(db
            .profiles
            .iter()
            .filter(|p| admin || p.user_id == uid)
            .map(profile_json)
            .collect())
    })
}

/// OS auto-rotado por perfil: si el usuario no elige OS, se asigna de forma
/// determinista a partir del id para que cada perfil tenga su propio "mundo"
/// de emulación (Windows 60% / macOS 25% / Linux 15%) sin que nadie lo fije.
fn auto_os(id: &str) -> &'static str {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in id.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    match h % 100 {
        0..=59 => "windows",
        60..=84 => "macos",
        _ => "linux",
    }
}

#[tauri::command]
pub fn create_profile(
    name: String,
    proxy: Option<String>,
    start_url: Option<String>,
    tags: Option<Vec<String>>,
    notes: Option<String>,
    os: Option<String>,
) -> Result<Value, String> {
    with_db(|db| {
        db.require_admin_scope()?;
        let uid = db.scope_user_id();
        let user_plan = db.current().map(|u| u.plan.clone()).unwrap_or_default();
        if let Some(limit) = plan_profile_limit(&user_plan) {
            let count = db.profiles.iter().filter(|p| p.user_id == uid).count() as u32;
            if count >= limit {
                return Err(format!(
                    "Límite de perfiles alcanzado para tu plan ({}). Mejora de plan o canjea una licencia para ampliarlo.",
                    limit
                ));
            }
        }
        let now = now_ms();
        let id = new_id();
        let profile = Profile {
            id: id.clone(),
            name: name.trim().to_string(),
            proxy: proxy.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()),
            start_url: start_url.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            tags: tags.unwrap_or_default(),
            notes: notes.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()),
            os: os.unwrap_or_else(|| auto_os(&id).to_string()),
            user_id: uid,
            created_at: now,
            updated_at: now,
        };
        let json = profile_json(&profile);
        db.profiles.push(profile);
        db.log_activity("create_profile", "profile", json!({"name": json.get("name").cloned()}));
        Ok(json)
    })
}

#[derive(Deserialize)]
pub struct ProfileUpdate {
    name: Option<String>,
    proxy: Option<String>,
    #[serde(alias = "startUrl")]
    start_url: Option<String>,
    tags: Option<Vec<String>>,
    notes: Option<String>,
    os: Option<String>,
}

#[tauri::command]
pub fn update_profile_by_id(
    profile_id: String,
    data: Option<ProfileUpdate>,
) -> Result<Value, String> {
    with_db(|db| {
        let idx = db
            .profiles
            .iter()
            .position(|p| p.id == profile_id)
            .ok_or_else(|| "Perfil no encontrado".to_string())?;
        if !user_belongs(db, &db.profiles[idx].user_id) {
            return Err("No tienes permisos sobre este perfil".into());
        }
        let profile = &mut db.profiles[idx];
        if let Some(d) = data {
            if let Some(name) = d.name {
                if !name.trim().is_empty() {
                    profile.name = name.trim().to_string();
                }
            }
            if let Some(proxy) = d.proxy.as_deref() {
                let t = proxy.trim();
                profile.proxy = if t.is_empty() { None } else { Some(t.to_string()) };
            }
            if let Some(url) = d.start_url {
                let t = url.trim();
                profile.start_url = if t.is_empty() { None } else { Some(t.to_string()) };
            }
            if let Some(tags) = d.tags {
                profile.tags = tags;
            }
            if let Some(notes) = d.notes {
                let t = notes.trim();
                profile.notes = if t.is_empty() { None } else { Some(t.to_string()) };
            }
            if let Some(os) = d.os {
                profile.os = os;
            }
            profile.updated_at = now_ms();
        }
        Ok(profile_json(profile))
    })
}

#[tauri::command]
pub fn delete_profile(profile_id: String) -> Result<(), String> {
    with_db(|db| {
        let idx = db
            .profiles
            .iter()
            .position(|p| p.id == profile_id)
            .ok_or_else(|| "Perfil no encontrado".to_string())?;
        if !user_belongs(db, &db.profiles[idx].user_id) {
            return Err("No tienes permisos sobre este perfil".into());
        }
        db.profiles.remove(idx);
        Ok(())
    })
}

#[tauri::command]
pub fn update_profile(name: String) -> Result<Value, String> {
    with_db(|db| {
        let uid = db.scope_user_id();
        let user = db
            .find_user_mut(&uid)
            .ok_or_else(|| "Usuario no encontrado".to_string())?;
        if !name.trim().is_empty() {
            user.name = name.trim().to_string();
        }
        Ok(public_user(user))
    })
}

#[tauri::command]
pub fn change_password(current_password: String, new_password: String) -> Result<(), String> {
    with_db(|db| {
        let uid = db.scope_user_id();
        let user = db
            .find_user(&uid)
            .ok_or_else(|| "Usuario no encontrado".to_string())?
            .clone();
        if !verify_password(&current_password, &user.salt, &user.password_hash) {
            return Err("La contraseña actual no es correcta".into());
        }
        if new_password.len() < 8 {
            return Err("La nueva contraseña debe tener al menos 8 caracteres".into());
        }
        if let Some(u) = db.find_user_mut(&uid) {
            let salt = random_bytes(16);
            u.salt = hex(&salt);
            u.password_hash = hash_password(&new_password, &salt);
        }
        db.log_activity("change_password", "auth", json!({"username": user.username}));
        Ok(())
    })
}

#[tauri::command]
pub fn get_sessions() -> Result<Vec<Value>, String> {
    with_db(|db| {
        let admin = db.is_admin();
        let uid = db.scope_user_id();
        let mut list: Vec<Value> = db
            .sessions
            .iter()
            .filter(|s| admin || s.user_id == uid)
            .map(|s| session_json(s, db))
            .collect();
        list.sort_by(|a, b| {
            b.get("started_at")
                .and_then(|v| v.as_u64())
                .cmp(&a.get("started_at").and_then(|v| v.as_u64()))
        });
        Ok(list)
    })
}

#[tauri::command]
pub fn start_session(profile_id: String) -> Result<Value, String> {
    with_db(|db| {
        let profile = db
            .profiles
            .iter()
            .find(|p| p.id == profile_id)
            .ok_or_else(|| "Perfil no encontrado".to_string())?;
        let uid = profile.user_id.clone();
        let user_plan = db
            .find_user(&uid)
            .map(|u| u.plan.clone())
            .unwrap_or_default();
        if let Some(limit) = plan_session_limit(&user_plan) {
            let active = db
                .sessions
                .iter()
                .filter(|s| s.user_id == uid && s.status == "active")
                .count() as u32;
            if active >= limit {
                return Err(format!(
                    "Límite de sesiones simultáneas alcanzado ({}). Cierra una sesión activa.",
                    limit
                ));
            }
        }
        let session = Session {
            id: new_id(),
            profile_id: profile.id.clone(),
            profile_name: profile.name.clone(),
            profile_proxy: profile.proxy.clone(),
            user_id: uid,
            status: "active".to_string(),
            started_at: now_ms(),
            stopped_at: None,
            duration_ms: None,
        };
        let json = session_json(&session, db);
        db.sessions.push(session);
        db.log_activity("start_session", "session", json!({"profile_id": profile_id}));
        Ok(json)
    })
}

#[tauri::command]
pub fn stop_session(session_id: String) -> Result<Value, String> {
    with_db(|db| {
        let idx = db
            .sessions
            .iter()
            .position(|s| s.id == session_id)
            .ok_or_else(|| "Sesión no encontrada".to_string())?;
        if !user_belongs(db, &db.sessions[idx].user_id) {
            return Err("No tienes permisos sobre esta sesión".into());
        }
        let session = &mut db.sessions[idx];
        if session.status == "active" {
            let now = now_ms();
            session.status = "stopped".to_string();
            session.stopped_at = Some(now);
            session.duration_ms = Some(now.saturating_sub(session.started_at));
        }
        let snapshot = db.sessions[idx].clone();
        Ok(session_json(&snapshot, db))
    })
}

#[tauri::command]
pub fn reactivate_session(session_id: String) -> Result<Value, String> {
    with_db(|db| {
        let idx = db
            .sessions
            .iter()
            .position(|s| s.id == session_id)
            .ok_or_else(|| "Sesión no encontrada".to_string())?;
        if !user_belongs(db, &db.sessions[idx].user_id) {
            return Err("No tienes permisos sobre esta sesión".into());
        }
        let session = &mut db.sessions[idx];
        session.status = "active".to_string();
        session.started_at = now_ms();
        session.stopped_at = None;
        session.duration_ms = None;
        let snapshot = db.sessions[idx].clone();
        Ok(session_json(&snapshot, db))
    })
}

#[tauri::command]
pub fn delete_session(session_id: String) -> Result<(), String> {
    with_db(|db| {
        let idx = db
            .sessions
            .iter()
            .position(|s| s.id == session_id)
            .ok_or_else(|| "Sesión no encontrada".to_string())?;
        if !user_belongs(db, &db.sessions[idx].user_id) {
            return Err("No tienes permisos sobre esta sesión".into());
        }
        db.sessions.remove(idx);
        Ok(())
    })
}

#[tauri::command]
pub fn get_users() -> Result<Vec<Value>, String> {
    with_db(|db| {
        db.require_admin()?;
        Ok(db.users.iter().map(|u| admin_user(u, db)).collect())
    })
}

#[tauri::command]
pub fn ban_user(user_id: String, banned: bool) -> Result<(), String> {
    with_db(|db| {
        db.require_admin()?;
        let user = db
            .find_user_mut(&user_id)
            .ok_or_else(|| "Usuario no encontrado".to_string())?;
        if user.role == "owner" {
            return Err("No puedes bloquear al propietario".into());
        }
        let username = user.username.clone();
        user.banned = banned;
        db.log_activity(
            if banned { "ban_user" } else { "unban_user" },
            "user",
            json!({"user_id": user_id, "username": username}),
        );
        Ok(())
    })
}

#[tauri::command]
pub fn delete_user(user_id: String) -> Result<(), String> {
    with_db(|db| {
        db.require_admin()?;
        let target = db
            .users
            .iter()
            .find(|u| u.id == user_id)
            .cloned()
            .ok_or_else(|| "Usuario no encontrado".to_string())?;
        if target.role == "owner" {
            return Err("No puedes eliminar al propietario".into());
        }
        // Liberar créditos? No: si el usuario tenía créditos reservados no los devolvemos
        // (ya se gastaron al mintear). Limpiar sus sesiones y claves creadas por él.
        db.sessions.retain(|s| s.user_id != user_id);
        db.license_keys
            .retain(|k| k.created_by.as_deref() != Some(user_id.as_str()));
        let username = target.username.clone();
        db.users.retain(|u| u.id != user_id);
        if db.current_user_id.as_deref() == Some(user_id.as_str()) {
            db.current_user_id = None;
        }
        db.log_activity(
            "delete_user",
            "user",
            json!({"user_id": user_id, "username": username}),
        );
        Ok(())
    })
}

#[tauri::command]
pub fn change_plan(user_id: String, plan: String) -> Result<(), String> {
    with_db(|db| {
        // Canje de clave de licencia: el propio usuario lo hace desde "Planes &
        // Licencias" sin necesidad de ser admin; un admin puede canjear por otro.
        if is_key_format(&plan) {
            let is_self = db.scope_user_id() == user_id;
            if !is_self {
                db.require_admin()?;
            }
            let (resolved, key_role) = redeem_key(db, &user_id, &plan)?;
            let (plan_label, username) = {
                let u = db
                    .find_user_mut(&user_id)
                    .ok_or_else(|| "Usuario no encontrado".to_string())?;
                let username = u.username.clone();
                if u.role != "owner" && key_role != "user" {
                    u.role = key_role;
                }
                u.plan = resolved.clone();
                (resolved, username)
            };
            db.log_activity(
                "redeem_key",
                "license",
                json!({"user_id": user_id, "username": username, "plan": plan_label}),
            );
            return Ok(());
        }
        db.require_admin()?;
        let canonical = canonical_plan(&plan);
        let username = {
            let user = db
                .find_user_mut(&user_id)
                .ok_or_else(|| "Usuario no encontrado".to_string())?;
            user.plan = canonical.clone();
            user.username.clone()
        };
        db.log_activity(
            "change_plan",
            "user",
            json!({"user_id": user_id, "username": username, "plan": canonical}),
        );
        Ok(())
    })
}

#[tauri::command]
pub fn reset_password(user_id: String, password: String) -> Result<(), String> {
    with_db(|db| {
        db.require_admin()?;
        let user = db
            .find_user_mut(&user_id)
            .ok_or_else(|| "Usuario no encontrado".to_string())?;
        if password.trim().len() < 4 {
            return Err("La contraseña debe tener al menos 4 caracteres".into());
        }
        let username = user.username.clone();
        let salt = random_bytes(16);
        user.salt = hex(&salt);
        user.password_hash = hash_password(&password, &salt);
        db.log_activity("reset_password", "user", json!({"user_id": user_id, "username": username}));
        Ok(())
    })
}

#[tauri::command]
pub fn reset_hwid(user_id: String) -> Result<(), String> {
    with_db(|db| {
        db.require_admin()?;
        let user = db
            .find_user_mut(&user_id)
            .ok_or_else(|| "Usuario no encontrado".to_string())?;
        let username = user.username.clone();
        user.hwid = None;
        db.log_activity("reset_hwid", "user", json!({"user_id": user_id, "username": username}));
        Ok(())
    })
}

#[tauri::command]
pub fn assign_role(
    user_id: String,
    role: String,
    seller_credits: Option<u32>,
) -> Result<(), String> {
    with_db(|db| {
        db.require_admin()?;
        let user = db
            .find_user_mut(&user_id)
            .ok_or_else(|| "Usuario no encontrado".to_string())?;
        if user.role == "owner" {
            return Err("No puedes cambiar el rol del propietario".into());
        }
        let valid = ["user", "seller", "admin"];
        if !valid.contains(&role.as_str()) {
            return Err("Rol inválido".into());
        }
        user.role = role;
        if let Some(credits) = seller_credits {
            user.seller_credits = credits;
        }
        let (role_label, credits_label) = (user.role.clone(), user.seller_credits);
        db.log_activity(
            "assign_role",
            "user",
            json!({"user_id": user_id, "role": role_label, "seller_credits": credits_label}),
        );
        Ok(())
    })
}

#[tauri::command]
pub fn get_keys() -> Result<Vec<Value>, String> {
    with_db(|db| {
        db.require_admin()?;
        Ok(db.license_keys.iter().map(|k| key_json(k, db)).collect())
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateKeyInput {
    pub plan: String,
    pub duration_days: Option<i64>,
    pub role: Option<String>,
    pub count: Option<u32>,
    pub tag: Option<String>,
}

#[tauri::command]
pub fn create_key(data: Option<CreateKeyInput>) -> Result<Vec<Value>, String> {
    with_db(|db| {
        let data = data.ok_or_else(|| "Faltan datos de la licencia".to_string())?;
        let is_admin = db.is_admin();
        let is_seller = db
            .current()
            .map(|u| u.role == "seller" && u.seller_credits > 0)
            .unwrap_or(false);
        if !is_admin && !is_seller {
            return Err("Se requieren privilegios de administrador o vendedor".to_string());
        }
        let plan = canonical_plan(&data.plan);
        let count = data.count.unwrap_or(1).min(200);
        let duration = data.duration_days.unwrap_or(30).max(1);
        if !is_admin {
            let role = data.role.as_deref().unwrap_or("user");
            if role != "user" {
                return Err("Como vendedor solo puedes generar claves con rol de usuario".to_string());
            }
            let credits = db.current().map(|u| u.seller_credits).unwrap_or(0);
            if credits < count {
                return Err(format!(
                    "Créditos insuficientes: tienes {} y necesitas {}",
                    credits, count
                ));
            }
        }
        let role = if is_admin {
            data.role.unwrap_or_else(|| "user".into())
        } else {
            "user".to_string()
        };
        let tag = data.tag.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
        let creator = db.scope_user_id();
        let mut created = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..count {
            let mut body = new_key();
            while seen.contains(&body) {
                body = new_key();
            }
            seen.insert(body.clone());
            let key = LicenseKey {
                id: new_id(),
                key: body,
                plan: plan.clone(),
                duration_days: duration,
                role: role.clone(),
                status: "active".to_string(),
                tag: tag.clone(),
                created_by: Some(creator.clone()),
                redeemed_by: None,
                redeemed_at: None,
                created_at: now_ms(),
                expires_at: Some(now_ms() + (duration as u64) * 86_400_000),
            };
            created.push(key_json(&key, db));
            db.license_keys.push(key);
        }
        if !is_admin {
            if let Some(uid) = db.current_user_id.clone() {
                if let Some(u) = db.find_user_mut(&uid) {
                    u.seller_credits = u.seller_credits.saturating_sub(count);
                }
            }
        }
        db.log_activity(
            "create_key",
            "license",
            json!({"count": count, "plan": plan, "role": role}),
        );
        Ok(created)
    })
}

#[tauri::command]
pub fn revoke_key(key_id: String) -> Result<(), String> {
    with_db(|db| {
        db.require_admin()?;
        let key = db
            .license_keys
            .iter_mut()
            .find(|k| k.id == key_id || k.key == key_id)
            .ok_or_else(|| "Clave no encontrada".to_string())?;
        if key.status != "redeemed" {
            key.status = "revoked".to_string();
        } else {
            return Err("No se puede revocar una clave ya redenmida".into());
        }
        Ok(())
    })
}

#[tauri::command]
pub fn delete_key(key_id: String) -> Result<(), String> {
    with_db(|db| {
        let is_admin = db.is_admin();
        let uid = db.scope_user_id();
        if !is_admin {
            // Permite a un seller borrar SOLO las claves que él mismo creó.
            let mine = db
                .license_keys
                .iter()
                .find(|k| k.id == key_id || k.key == key_id)
                .map(|k| k.created_by.as_deref())
                .flatten();
            if mine != Some(uid.as_str()) {
                return Err(
                    "Se requieren privilegios de administrador o la clave debe haber sido creada por ti"
                        .to_string(),
                );
            }
        }
        let idx = db
            .license_keys
            .iter()
            .position(|k| k.id == key_id || k.key == key_id)
            .ok_or_else(|| "Clave no encontrada".to_string())?;
        db.license_keys.remove(idx);
        Ok(())
    })
}

#[tauri::command]
pub fn get_analytics() -> Result<Value, String> {
    with_db(|db| {
        db.require_admin()?;
        let total_users = db.users.len() as u32;
        let count_plan = |p: &str| db.users.iter().filter(|u| u.plan == p).count() as u32;
        let mrr: u32 = db.users.iter().map(|u| plan_price(&u.plan)).sum();
        let active_sessions = db.sessions.iter().filter(|s| s.status == "active").count();
        let k = |st: &str| db.license_keys.iter().filter(|x| x.status == st).count() as u32;
        Ok(json!({
            "totalUsers": total_users,
            "usersByPlan": {
                "ghost": count_plan("free"),
                "shadow": count_plan("pro"),
                "specter": count_plan("specter"),
                "phantom": count_plan("enterprise")
            },
            "mrr": mrr,
            "totalProfiles": db.profiles.len(),
            "activeSessions": active_sessions,
            "keys": { "total": db.license_keys.len(), "active": k("active"), "redeemed": k("redeemed"), "revoked": k("revoked") }
        }))
    })
}

#[tauri::command]
pub fn get_activity() -> Result<Vec<Value>, String> {
    with_db(|db| {
        db.require_admin()?;
        Ok(db
            .activity
            .iter()
            .rev()
            .map(|a| {
                json!({
                    "id": a.id,
                    "action": a.action,
                    "entity": a.entity,
                    "details": a.details,
                    "ip": a.ip,
                    "createdAt": a.created_at,
                })
            })
            .collect())
    })
}

#[tauri::command]
pub fn export_backup() -> Result<Value, String> {
    with_db(|db| {
        db.require_admin()?;
        let users: Vec<Value> = db
            .users
            .iter()
            .map(|u| {
                json!({
                    "id": u.id,
                    "name": u.name,
                    "username": u.username,
                    "email": u.email,
                    "role": u.role,
                    "plan": u.plan,
                    "banned": u.banned,
                    "seller_credits": u.seller_credits,
                    "created_at": u.created_at,
                    "last_login_at": u.last_login_at,
                    "hwid": u.hwid,
                })
            })
            .collect();
        Ok(json!({
            "exportedAt": now_ms(),
            "app": "krakenges-desktop",
            "users": users,
            "profiles": db.profiles.iter().map(profile_json).collect::<Vec<_>>(),
            "sessions": db.sessions.iter().map(|s| session_json(s, db)).collect::<Vec<_>>(),
            "licenseKeys": db.license_keys.iter().map(|k| key_json(k, db)).collect::<Vec<_>>(),
        }))
    })
}

#[tauri::command]
pub fn purge_sessions() -> Result<Value, String> {
    with_db(|db| {
        db.require_admin()?;
        let cutoff = now_ms().saturating_sub(30 * 86_400_000);
        let before = db.sessions.len();
        db.sessions.retain(|s| {
            if s.status == "stopped" && s.stopped_at.unwrap_or(0) < cutoff {
                false
            } else {
                true
            }
        });
        let deleted = (before - db.sessions.len()) as u32;
        db.log_activity("purge_sessions", "session", json!({"deletedCount": deleted}));
        Ok(json!({ "deletedCount": deleted }))
    })
}

impl Db {
    // Guard pequeño: create_profile es de uso general (también de vendedores);
    // solo hay que verificar que el usuario existe y no está baneado.
    fn require_admin_scope(&self) -> Result<(), String> {
        if self.current().map(|u| u.banned).unwrap_or(true) {
            return Err("Sesión inválida o cuenta suspendida".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_format_detection() {
        assert!(is_key_format("MSK-ABCD-EFGH-JKLM-NPQR"));
        assert!(is_key_format("msk-aaaa-bbbb-cccc-dddd"));
        // Compatibilidad con claves locales antiguas.
        assert!(is_key_format("MASK-ABCD-EFGH-JKLM-NPQR"));
        assert!(is_key_format("mask-aaaa-bbbb-cccc-dddd"));
        assert!(!is_key_format(""));
        assert!(!is_key_format("not-a-key"));
        assert!(!is_key_format("ABCD-EFGH-1234-5678"));
    }

    #[test]
    fn generated_key_shape() {
        let k = new_key();
        assert!(k.starts_with("MSK-"));
        assert_eq!(k.len(), 23);
        assert!(k.chars().all(|c| c == '-' || c.is_ascii_uppercase() || c.is_ascii_digit()));
    }

    #[test]
    fn canonical_and_limits() {
        assert_eq!(canonical_plan("Ghost"), "free");
        assert_eq!(canonical_plan("shadow"), "pro");
        assert_eq!(canonical_plan("specter"), "specter");
        assert_eq!(canonical_plan("phantom prime"), "enterprise");
        assert_eq!(plan_profile_limit("free"), Some(5));
        assert_eq!(plan_profile_limit("pro"), Some(50));
        assert_eq!(plan_profile_limit("specter"), Some(200));
        assert_eq!(plan_profile_limit("enterprise"), None);
        assert_eq!(plan_session_limit("free"), Some(2));
        assert_eq!(plan_session_limit("pro"), Some(10));
        assert_eq!(plan_session_limit("enterprise"), None);
    }

    #[test]
    fn password_hashing_roundtrip() {
        let salt = random_bytes(16);
        let hex_salt = hex(&salt);
        let pw = "clave-de-prueba-no-real";
        let hash = hash_password(pw, &salt);
        assert_ne!(hash, "admin123");
        assert!(verify_password(pw, &hex_salt, &hash));
        assert!(!verify_password("otra-clave", &hex_salt, &hash));
    }

    /// Regresión: la clave del owner se genera, no se compila en el binario
    /// (antes era recuperable con `strings`).
    #[test]
    fn owner_password_is_generated_not_hardcoded() {
        let pw = generate_owner_password();
        assert!(pw.len() >= 24, "la clave generada debe ser fuerte");
        assert_ne!(pw, "admin123");
        assert_ne!(pw, generate_owner_password(), "dos generaciones distintas deben diferir");
    }

    /// Regresión: `getrandom` nunca debe degradar a un buffer de ceros.
    #[test]
    fn random_bytes_are_not_zeroed() {
        let a = random_bytes(32);
        let b = random_bytes(32);
        assert_eq!(a.len(), 32);
        assert_ne!(a, vec![0u8; 32], "getrandom fallo en silencio");
        assert_ne!(a, b, "dos generaciones consecutivas devolvieron lo mismo");
    }

    /// Regresión: una base sembrada con la credencial filtrada debe rotar la
    /// clave del propietario, sin conservar esa credencial en el código.
    #[test]
    fn migration_rotates_owner_password() {
        let mut db = Db::seeded();
        // Simula una base antigua: esquema v0 y hash heredado de la credencial
        // que estuvo publicada en el binario distribuido.
        db.schema_version = 0;
        let leaked = "Clave-que-estuvo-publicada-en-el-binario";
        let before_salt = {
            let owner = db.users.first_mut().unwrap();
            let salt = random_bytes(16);
            owner.salt = hex(&salt);
            owner.password_hash = hash_password(leaked, &salt);
            owner.salt.clone()
        };

        migrate_with(&mut db, "clave-nueva-de-migracion".to_string());

        assert_eq!(db.schema_version, SCHEMA_VERSION);
        let owner = &db.users[0];
        assert_ne!(owner.salt, before_salt, "el salt debe rotar también");
        assert!(verify_password(
            "clave-nueva-de-migracion",
            &owner.salt,
            &owner.password_hash
        ));
        assert!(!verify_password(leaked, &owner.salt, &owner.password_hash));
        // La cuenta se conserva intacta.
        assert_eq!(owner.role, "owner");
        assert_eq!(owner.username, OWNER_USERNAME);
    }

    /// Una base ya migrada no debe volver a rotar (sería molesto en cada arranque).
    #[test]
    fn migration_is_idempotent() {
        let mut db = Db::seeded();
        db.schema_version = 0;
        migrate_with(&mut db, "primera".to_string());
        let salt_after_first = db.users[0].salt.clone();
        migrate_with(&mut db, "segunda-distinta".to_string());
        assert_eq!(db.users[0].salt, salt_after_first);
        assert!(verify_password("primera", &db.users[0].salt, &db.users[0].password_hash));
    }

    /// Un `krakenges_db.json` antiguo (sin el campo) debe seguir deserializando.
    #[test]
    fn old_db_without_schema_version_deserializes_as_v0() {
        let json = r#"{
            "current_user_id": null,
            "users": [],
            "profiles": [],
            "sessions": [],
            "license_keys": [],
            "activity": []
        }"#;
        let db: Db = serde_json::from_str(json).expect("una base sin schema_version debe cargar");
        assert_eq!(db.schema_version, 0);
    }
}