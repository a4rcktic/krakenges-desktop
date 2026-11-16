use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;

use crate::cdp::TrafficStats;

fn base64_encode(data: &[u8]) -> String {
    const TBL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TBL[((n >> 18) & 63) as usize] as char);
        out.push(TBL[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TBL[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TBL[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// Conector local por sesión para túnel upstream autenticado y métricas de tráfico.
pub struct ProxyShield {
    pub port: u16,
    pub stats: Arc<TrafficStats>,
    _shutdown: Arc<std::sync::atomic::AtomicBool>,
}

impl ProxyShield {
    /// Flag que Chromium consume como proxy local (sin auth explícita).
    pub fn local_server(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Verifica el flujo completo auth+sticky a través del conector
    /// consultando ip-api.com (HTTP puro, sin TLS) y devuelve (ip, país).
    pub fn verify(&self) -> Result<(String, String), String> {
        let mut sock = std::net::TcpStream::connect(("127.0.0.1", self.port))
            .map_err(|e| format!("ProxyShield: conector no disponible: {}", e))?;
        sock.set_read_timeout(Some(std::time::Duration::from_secs(20)))
            .map_err(|e| format!("ProxyShield: timeout: {}", e))?;
        use std::io::{Read, Write};
        let req = "GET http://ip-api.com/json/?fields=status,query,country HTTP/1.1\r\n\
                   Host: ip-api.com\r\nUser-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36\r\n\
                   Connection: close\r\n\r\n";
        sock.write_all(req.as_bytes()).map_err(|e| format!("envío: {}", e))?;
        let mut buf = Vec::new();
        sock.read_to_end(&mut buf).map_err(|e| format!("lectura: {}", e))?;
        let body = String::from_utf8_lossy(&buf);
        if let Some(start) = body.find("{\"status\":\"success\"") {
            let end = body[start..].find('}').map(|e| start + e + 1).unwrap_or(body.len());
            #[derive(Deserialize)]
            struct R {
                query: Option<String>,
                country: Option<String>,
            }
            if let Ok(r) = serde_json::from_str::<R>(&body[start..end]) {
                return Ok((
                    r.query.unwrap_or_default(),
                    r.country.unwrap_or_default(),
                ));
            }
        }
        Err(format!("respuesta inesperada del conector: {}", body.chars().take(160).collect::<String>()))
    }
}

/// Levanta el conector local ProxyShield (threads de std, sin dependencia de
/// runtime async) para un proxy con credenciales.
/// Devuelve el puerto local enlazado. La sesión sticky debe venir ya
/// resuelta dentro del `parsed` (sustitución de `{sess}` por el llamador).
pub fn spawn_shield(parsed: &ParsedProxy, stats: Arc<TrafficStats>) -> Result<ProxyShield, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("ProxyShield: error enlazando puerto local: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("ProxyShield: local_addr: {}", e))?
        .port();

    let shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let runn = shutdown.clone();
    let up_host = parsed.host.clone();
    let up_port = parsed.port;
    let auth = if parsed.username.is_some() {
        let u = parsed.username.clone().unwrap_or_default();
        let p = parsed.password.clone().unwrap_or_default();
        Some(base64_encode(format!("{}:{}", u, p).as_bytes()))
    } else {
        None
    };
    let proto_socks = parsed.protocol.starts_with("socks");
    let stats_acc = stats.clone();

    std::thread::spawn(move || {
        while !runn.load(std::sync::atomic::Ordering::Relaxed) {
            let (client, _) = match listener.accept() {
                Ok(c) => c,
                Err(_) => continue,
            };
            let up_host = up_host.clone();
            let up_port = up_port;
            let auth = auth.clone();
            let proto_socks = proto_socks;
            let stats = stats_acc.clone();
            std::thread::spawn(move || {
                let _ = handle_tunnel(client, &up_host, up_port, auth.as_deref(), proto_socks, stats);
            });
        }
    });

    Ok(ProxyShield { port, stats, _shutdown: shutdown })
}

fn handle_tunnel(
    client: std::net::TcpStream,
    up_host: &str,
    up_port: u16,
    auth: Option<&str>,
    socks: bool,
    stats: Arc<TrafficStats>,
) -> Result<(), String> {
    use std::io::{Read, Write};
    client.set_read_timeout(Some(std::time::Duration::from_secs(60))).ok();
    client.set_write_timeout(Some(std::time::Duration::from_secs(60))).ok();
    let mut client = client;
    // Leer cabeceras del cliente hasta \r\n\r\n (máx. 64 KB).
    let mut head = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = client.read(&mut buf).map_err(|e| format!("lectura cliente: {}", e))?;
        if n == 0 {
            return Err("EOF cliente".into());
        }
        head.extend_from_slice(&buf[..n]);
        if head.windows(4).any(|w| w == b"\r\n\r\n") || head.len() > 65536 {
            break;
        }
    }
    let head_str = String::from_utf8_lossy(&head);
    let mut lines = head_str.lines();
    let first = lines.next().unwrap_or("");
    let mut parts = first.split(' ');
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");

    if socks {
        return Err("ProxyShield: flujo SOCKS aún no soportado; usa http/socks vía URI del proveedor".into());
    }

    if method == "CONNECT" {
        let host_port = target.to_string();
        let mut up = std::net::TcpStream::connect((up_host, up_port))
            .map_err(|e| format!("conexión a upstream {}:{}: {}", up_host, up_port, e))?;
        up.set_read_timeout(Some(std::time::Duration::from_secs(60))).ok();
        up.set_write_timeout(Some(std::time::Duration::from_secs(60))).ok();
        let mut connect_req = format!(
            "CONNECT {} HTTP/1.1\r\nHost: {}\r\n",
            host_port, host_port
        );
        if let Some(a) = auth {
            connect_req.push_str(&format!("Proxy-Authorization: Basic {}\r\n", a));
        }
        connect_req.push_str("\r\n");
        up.write_all(connect_req.as_bytes()).map_err(|e| format!("CONNECT upstream: {}", e))?;
        let mut uhead = Vec::new();
        let mut ubuf = [0u8; 4096];
        loop {
            let n = up.read(&mut ubuf).map_err(|e| format!("respuesta upstream: {}", e))?;
            if n == 0 {
                break;
            }
            uhead.extend_from_slice(&ubuf[..n]);
            if uhead.windows(4).any(|w| w == b"\r\n\r\n") || uhead.len() > 8192 {
                break;
            }
        }
        if !uhead.starts_with(b"HTTP/1.1 200") && !uhead.starts_with(b"HTTP/1.0 200") {
            let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
            shield_debug(&format!(
                "CONNECT {} -> upstream rechazó: {}",
                host_port,
                String::from_utf8_lossy(&uhead).replace('\n', " ").chars().take(140).collect::<String>()
            ));
            return Err(format!(
                "upstream rechazó CONNECT: {}",
                String::from_utf8_lossy(&uhead).replace('\n', " ").chars().take(140).collect::<String>()
            ));
        }
        shield_debug(&format!("CONNECT {} -> 200 OK", host_port));
        client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").map_err(|e| format!("respuesta 200: {}", e))?;
        if let Some(i0) = uhead.windows(4).position(|w| w == b"\r\n\r\n") {
            if i0 + 4 < uhead.len() {
                let leftover = &uhead[i0 + 4..];
                client.write_all(leftover).map_err(|e| format!("relleno túnel CONNECT: {}", e))?;
                stats.add_connector(leftover.len() as u64, 1);
                shield_debug(&format!("CONNECT {} -> {} bytes previos del túnel", host_port, leftover.len()));
            }
        }
        relay(client, up, stats);
        return Ok(());
    }

    // Forma absoluta (GET http://host/path): el pool residencial espera
    // forma de origen con cabecera Host explícita, así que convertimos.
    let mut up = std::net::TcpStream::connect((up_host, up_port))
        .map_err(|e| format!("conexión upstream: {}", e))?;
    up.set_read_timeout(Some(std::time::Duration::from_secs(60))).ok();
    up.set_write_timeout(Some(std::time::Duration::from_secs(60))).ok();
    let rest = target.split("://").nth(1).unwrap_or(&target);
    let slash = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..slash];
    let pod = if slash < rest.len() { &rest[slash..] } else { "/" };
    let (hostname, port) = match authority.rsplit_once(':') {
        Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) => (h.to_string(), Some(p.to_string())),
        _ => (authority.to_string(), None),
    };
    let mut out = String::new();
    out.push_str(method);
    out.push(' ');
    out.push_str(pod);
    out.push_str(" HTTP/1.1\r\n");
    for l in lines {
        if l.is_empty() {
            continue;
        }
        let low = l.to_ascii_lowercase();
        if low.starts_with("proxy-authorization:")
            || low.starts_with("proxy-connection:")
            || low.starts_with("connection:")
            || low.starts_with("host:")
            || low.starts_with("user-agent:")
        {
            continue;
        }
        out.push_str(l);
        out.push_str("\r\n");
    }
    out.push_str(&format!("Host: {}", hostname));
    if let Some(p) = port {
        out.push_str(&format!(":{}", p));
    }
    out.push_str("\r\nUser-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36\r\nConnection: close\r\n");
    if let Some(a) = auth {
        out.push_str(&format!("Proxy-Authorization: Basic {}\r\n", a));
    }
    out.push_str("\r\n");
    let mut full = out.into_bytes();
    let mut i0 = None;
    for i in 0..head.len().saturating_sub(3) {
        if &head[i..i + 4] == b"\r\n\r\n" {
            i0 = Some(i);
            break;
        }
    }
    if let Some(i0) = i0 {
        full.extend_from_slice(&head[i0 + 4..]);
    }
    shield_debug(&format!(
        "absoluto -> upstream {}:{} : {} | auth={:?}",
        up_host,
        up_port,
        String::from_utf8_lossy(&full).lines().nth(0).unwrap_or(""),
        auth
    ));
    shield_debug(&format!(
        "FULL_REQUEST_HEX {}",
        full.iter().map(|b| format!("{:02X}", b)).collect::<String>()
    ));
    up.write_all(&full).map_err(|e| format!("envío absoluto: {}", e))?;
    relay(client, up, stats);
    Ok(())
}

/// Relay bidireccional con contabilidad de bytes (2 hilos de copia).
fn pump(r: &mut std::net::TcpStream, w: &mut std::net::TcpStream, stats: &TrafficStats) {
    use std::io::{Read, Write};
    let mut buf = [0u8; 65536];
    loop {
        let n = match r.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if w.write_all(&buf[..n]).is_err() {
            break;
        }
        stats.add_connector(n as u64, 0);
    }
    let _ = w.shutdown(std::net::Shutdown::Write);
}

fn shield_debug(msg: &str) {
    if std::env::var("KRAKENGES_SHIELD_DEBUG").map(|v| v == "1").unwrap_or(false) {
        eprintln!("[shield-debug] {}", msg);
    }
}

fn relay(mut a: std::net::TcpStream, mut b: std::net::TcpStream, stats: Arc<TrafficStats>) {
    let a_rd = a.try_clone().ok();
    let b_rd = b.try_clone().ok();
    let s1 = stats.clone();
    let t1 = std::thread::spawn(move || {
        if let Some(mut ar) = a_rd {
            pump(&mut ar, &mut b, &s1);
        }
    });
    let t2 = std::thread::spawn(move || {
        if let Some(mut br) = b_rd {
            pump(&mut br, &mut a, &stats);
        }
    });
    let _ = t1.join();
    let _ = t2.join();
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParsedProxy {
    pub protocol: String, // "http", "https", "socks5", "socks4"
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

impl ParsedProxy {
    /// Construye una URL completamente compatible y segura para reqwest
    pub fn to_reqwest_url(&self) -> String {
        let proto = match self.protocol.as_str() {
            "socks5" | "socks5h" => "socks5",
            "socks4" => "socks4",
            _ => "http",
        };

        if let (Some(u), Some(p)) = (&self.username, &self.password) {
            format!(
                "{}://{}:{}@{}:{}",
                proto,
                percent_encode(u),
                percent_encode(p),
                self.host,
                self.port
            )
        } else if let Some(u) = &self.username {
            format!("{}://{}@{}:{}", proto, percent_encode(u), self.host, self.port)
        } else {
            format!("{}://{}:{}", proto, self.host, self.port)
        }
    }

    /// Servidor de proxy para Chromium (--proxy-server=...)
    /// En Chromium las credenciales no deben pasarse en este flag sino en la extensión de autenticación
    pub fn to_chromium_server(&self) -> String {
        let proto = match self.protocol.as_str() {
            "socks5" | "socks5h" => "socks5://",
            "socks4" => "socks4://",
            _ => "http://",
        };
        format!("{}{}:{}", proto, self.host, self.port)
    }

    /// URI con credenciales embebidas para `--proxy-server`, como fallback cuando el
    /// navegador no soporta extensiones MV2 (Chrome >= 137). Chromium no acepta
    /// credenciales en el URI para SOCKS, así que ahí devolvemos None.
    pub fn to_chromium_uri_with_creds(&self) -> Option<String> {
        if self.protocol.starts_with("socks") {
            return None;
        }
        match (&self.username, &self.password) {
            (Some(u), Some(p)) => Some(format!(
                "http://{}:{}@{}:{}",
                percent_encode(u),
                percent_encode(p),
                self.host,
                self.port
            )),
            (Some(u), None) => Some(format!("http://{}@{}:{}", percent_encode(u), self.host, self.port)),
            _ => None,
        }
    }

    /// Formato canónico universal: host:port o host:port:user:pass
    pub fn canonical(&self) -> String {
        if let (Some(u), Some(p)) = (&self.username, &self.password) {
            format!("{}:{}:{}:{}", self.host, self.port, u, p)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

/// Extrae host y puerto numérico de una cadena tipo "host:port"
fn extract_host_port(s: &str) -> Option<(String, u16)> {
    let clean = s.trim();
    if let Some(colon) = clean.rfind(':') {
        let h = clean[..colon].trim();
        let port_str = clean[colon + 1..].trim();
        if let Ok(p) = port_str.parse::<u16>() {
            if p > 0 {
                return Some((h.to_string(), p));
            }
        }
    }
    None
}

/// Divide usuario y contraseña considerando caracteres especiales
fn split_user_pass(s: &str) -> (Option<String>, Option<String>) {
    let clean = s.trim();
    if let Some(colon) = clean.find(':') {
        let u = clean[..colon].trim();
        let p = clean[colon + 1..].trim();
        (
            if u.is_empty() { None } else { Some(u.to_string()) },
            if p.is_empty() { None } else { Some(p.to_string()) },
        )
    } else {
        (
            if clean.is_empty() { None } else { Some(clean.to_string()) },
            None,
        )
    }
}

/// Motor universal de reconocimiento de proxies.
/// Soporta absolutamente cualquier formato:
/// - ip:port:user:pass (estándar de la industria)
/// - user:pass:ip:port
/// - user:pass@ip:port
/// - ip:port@user:pass
/// - protocol://user:pass@ip:port
/// - protocol://ip:port:user:pass
/// - Delimitadores: :, ;, |, ,, tab, espacio
/// - Direcciones IPv6: [2001:db8::1]:8080:user:pass
/// - Dominios con subdominios y guiones (ej. pr.oxylabs.io:7777:user:pass)
pub fn parse_proxy(raw: &str) -> Result<ParsedProxy, String> {
    let mut input = raw.trim();
    if input.is_empty() {
        return Err("La cadena de proxy está vacía".to_string());
    }

    // Remover comillas
    if (input.starts_with('"') && input.ends_with('"'))
        || (input.starts_with('\'') && input.ends_with('\''))
    {
        input = &input[1..input.len() - 1].trim();
    }

    // Remover comentarios / tags tipo #proxy-1
    if let Some(hash_pos) = input.find('#') {
        input = input[..hash_pos].trim();
    }

    // Extraer y normalizar protocolo
    let mut protocol = "http".to_string();
    let lower = input.to_lowercase();
    if lower.starts_with("socks5h://") {
        protocol = "socks5".to_string();
        input = &input[10..];
    } else if lower.starts_with("socks5://") {
        protocol = "socks5".to_string();
        input = &input[9..];
    } else if lower.starts_with("socks4://") {
        protocol = "socks4".to_string();
        input = &input[9..];
    } else if lower.starts_with("https://") {
        protocol = "http".to_string();
        input = &input[8..];
    } else if lower.starts_with("http://") {
        protocol = "http".to_string();
        input = &input[7..];
    }

    // Remover slash final si existe
    if input.ends_with('/') {
        input = &input[..input.len() - 1].trim();
    }

    // ESTRATEGIA 1: Formato con '@' (ej. user:pass@host:port o host:port@user:pass)
    if let Some(at_pos) = input.find('@') {
        let left = &input[..at_pos];
        let right = &input[at_pos + 1..];

        // ¿El lado derecho tiene host:port válido?
        if let Some((r_host, r_port)) = extract_host_port(right) {
            let (u, p) = split_user_pass(left);
            return Ok(ParsedProxy {
                protocol,
                host: r_host,
                port: r_port,
                username: u,
                password: p,
            });
        }
        // ¿O el lado izquierdo tiene host:port? (ej. host:port@user:pass)
        else if let Some((l_host, l_port)) = extract_host_port(left) {
            let (u, p) = split_user_pass(right);
            return Ok(ParsedProxy {
                protocol,
                host: l_host,
                port: l_port,
                username: u,
                password: p,
            });
        }
    }

    // ESTRATEGIA 2: IPv6 con corchetes [2001:db8::1]:8080:...
    if input.starts_with('[') {
        if let Some(close_bracket) = input.find(']') {
            let ipv6 = input[1..close_bracket].to_string();
            let after_bracket = &input[close_bracket + 1..];
            let remainder = after_bracket.trim_start_matches(':').trim_start_matches(';');
            let parts: Vec<&str> = remainder
                .split(|c| c == ':' || c == ';' || c == '|' || c == ',' || c == '\t' || c == ' ')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect();

            if parts.is_empty() {
                return Err("No se encontró el puerto para la dirección IPv6".to_string());
            }

            let port = parts[0]
                .parse::<u16>()
                .map_err(|_| format!("Puerto IPv6 inválido: '{}'", parts[0]))?;

            let username = parts.get(1).map(|s| s.to_string());
            let password = if parts.len() > 2 {
                Some(parts[2..].join(":"))
            } else {
                None
            };

            return Ok(ParsedProxy {
                protocol,
                host: ipv6,
                port,
                username,
                password,
            });
        }
    }

    // ESTRATEGIA 3: Delimitadores flexibles (':', ';', '|', ',', tab, espacio)
    let normalized = input
        .replace(';', ":")
        .replace('|', ":")
        .replace(',', ":")
        .replace('\t', ":")
        .replace(' ', ":");

    let tokens: Vec<&str> = normalized
        .split(':')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    match tokens.len() {
        // Formato simple: host:port
        2 => {
            let host = tokens[0].to_string();
            let port = tokens[1]
                .parse::<u16>()
                .map_err(|_| format!("Puerto inválido '{}' en formato host:port", tokens[1]))?;
            Ok(ParsedProxy {
                protocol,
                host,
                port,
                username: None,
                password: None,
            })
        }
        // Formato de 3 partes: host:port:user
        3 => {
            if let Ok(port) = tokens[1].parse::<u16>() {
                Ok(ParsedProxy {
                    protocol,
                    host: tokens[0].to_string(),
                    port,
                    username: Some(tokens[2].to_string()),
                    password: None,
                })
            } else if let Ok(port) = tokens[2].parse::<u16>() {
                Ok(ParsedProxy {
                    protocol,
                    host: tokens[1].to_string(),
                    port,
                    username: Some(tokens[0].to_string()),
                    password: None,
                })
            } else {
                Err(format!("No se encontró un puerto numérico válido en '{}'", input))
            }
        }
        // Formato estándar de 4 o más partes
        len if len >= 4 => {
            let port_at_1 = tokens[1].parse::<u16>();
            let port_at_3 = tokens[3].parse::<u16>();

            if let Ok(port) = port_at_1 {
                // Formato rey de la industria: host:port:user:pass
                let host = tokens[0].to_string();
                let username = Some(tokens[2].to_string());
                let password = Some(tokens[3..].join(":"));
                Ok(ParsedProxy {
                    protocol,
                    host,
                    port,
                    username,
                    password,
                })
            } else if let Ok(port) = port_at_3 {
                // Formato inverso de algunos proveedores: user:pass:host:port
                let username = Some(tokens[0].to_string());
                let password = Some(tokens[1].to_string());
                let host = tokens[2].to_string();
                Ok(ParsedProxy {
                    protocol,
                    host,
                    port,
                    username,
                    password,
                })
            } else {
                Err(format!(
                    "No se pudo determinar el puerto en '{}'. Se esperaba el puerto numérico en la posición 2 o 4.",
                    input
                ))
            }
        }
        _ => Err(format!(
            "Estructura de proxy no reconocida: '{}'. Debe contener al menos host y puerto.",
            input
        )),
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProxyTestResult {
    pub success: bool,
    pub latency_ms: Option<u64>,
    pub ip: Option<String>,
    pub country: Option<String>,
    pub country_code: Option<String>,
    pub city: Option<String>,
    pub isp: Option<String>,
    pub error: Option<String>,
    pub protocol: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub has_auth: bool,
    pub canonical: Option<String>,
    // Campos de Coherencia Geográfica Estricta (Anti-Fraude E-Commerce)
    pub timezone: Option<String>,
    pub tz_offset_minutes: Option<i32>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub suggested_language: Option<String>,
}

pub fn suggest_language_from_country(code: &str) -> String {
    match code.to_uppercase().as_str() {
        "US" => "en-US",
        "GB" | "UK" => "en-GB",
        "CA" => "en-CA",
        "AU" => "en-AU",
        "NZ" => "en-NZ",
        "DE" => "de-DE",
        "AT" => "de-AT",
        "CH" => "de-CH",
        "FR" => "fr-FR",
        "BE" => "nl-BE",
        "ES" => "es-ES",
        "MX" => "es-MX",
        "CO" => "es-CO",
        "AR" => "es-AR",
        "CL" => "es-CL",
        "PE" => "es-PE",
        "BR" => "pt-BR",
        "PT" => "pt-PT",
        "IT" => "it-IT",
        "NL" => "nl-NL",
        "PL" => "pl-PL",
        "TR" => "tr-TR",
        "JP" => "ja-JP",
        "KR" => "ko-KR",
        "CN" => "zh-CN",
        "TW" => "zh-TW",
        "HK" => "zh-HK",
        "RU" => "ru-RU",
        "UA" => "uk-UA",
        "IN" => "en-IN",
        "SG" => "en-SG",
        "AE" => "ar-AE",
        "SA" => "ar-SA",
        "VE" => "es-VE",
        "EC" => "es-EC",
        "GT" => "es-GT",
        "CR" => "es-CR",
        "PA" => "es-PA",
        "DO" => "es-DO",
        "UY" => "es-UY",
        "PY" => "es-PY",
        "BO" => "es-BO",
        "HN" => "es-HN",
        "SV" => "es-SV",
        "NI" => "es-NI",
        "PR" => "es-PR",
        "CU" => "es-CU",
        "IE" => "en-IE",
        "ZA" => "en-ZA",
        "PH" => "en-PH",
        "NG" => "en-NG",
        "SE" => "sv-SE",
        "NO" => "nb-NO",
        "DK" => "da-DK",
        "FI" => "fi-FI",
        "CZ" => "cs-CZ",
        "RO" => "ro-RO",
        "GR" => "el-GR",
        "HU" => "hu-HU",
        "IL" => "he-IL",
        "ID" => "id-ID",
        "TH" => "th-TH",
        "VN" => "vi-VN",
        "MY" => "ms-MY",
        "EG" => "ar-EG",
        _ => "en-US",
    }
    .to_string()
}

#[derive(Debug, Deserialize)]
struct IpApiCheckResponse {
    query: Option<String>,
    country: Option<String>,
    #[serde(rename = "countryCode")]
    country_code: Option<String>,
    city: Option<String>,
    isp: Option<String>,
    status: Option<String>,
    timezone: Option<String>,
    offset: Option<i32>,
    lat: Option<f64>,
    lon: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct IpifyFallbackResponse {
    ip: Option<String>,
}

#[tauri::command]
pub fn parse_proxy_string(proxy: String) -> Result<ParsedProxy, String> {
    parse_proxy(&proxy)
}

#[tauri::command]
pub async fn test_proxy_connection(proxy: String) -> Result<ProxyTestResult, String> {
    let raw = proxy.trim();
    if raw.is_empty() {
        return Ok(ProxyTestResult {
            success: false,
            latency_ms: None,
            ip: None,
            country: None,
            country_code: None,
            city: None,
            isp: None,
            error: Some("La cadena de proxy está vacía".into()),
            protocol: None,
            host: None,
            port: None,
            has_auth: false,
            canonical: None,
            // Los campos de coherencia geográfica (timezone, tz_offset_minutes,
            // latitude, longitude, suggested_language) se heredan del Default
            // en vez de listarse: son None en un fallo de parseo.
            ..Default::default()
        });
    }

    let parsed = match parse_proxy(raw) {
        Ok(p) => p,
        Err(e) => {
            return Ok(ProxyTestResult {
                success: false,
                latency_ms: None,
                ip: None,
                country: None,
                country_code: None,
                city: None,
                isp: None,
                error: Some(format!("Error reconociendo formato: {}", e)),
                protocol: None,
                host: None,
                port: None,
                has_auth: false,
                canonical: None,
                ..Default::default()
            });
        }
    };

    let canonical = parsed.canonical();
    let has_auth = parsed.username.is_some() && parsed.password.is_some();
    let host = parsed.host.clone();
    let port = parsed.port;
    let protocol = parsed.protocol.clone();

    let reqwest_url = parsed.to_reqwest_url();
    let proxy_obj = match reqwest::Proxy::all(&reqwest_url) {
        Ok(p) => p,
        Err(e) => {
            return Ok(ProxyTestResult {
                success: false,
                latency_ms: None,
                ip: None,
                country: None,
                country_code: None,
                city: None,
                isp: None,
                error: Some(format!("Error inicializando socket del proxy: {}", e)),
                protocol: Some(protocol),
                host: Some(host),
                port: Some(port),
                has_auth,
                canonical: Some(canonical),
                ..Default::default()
            });
        }
    };

    let client = match reqwest::Client::builder()
        .proxy(proxy_obj)
        .timeout(std::time::Duration::from_secs(12))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return Ok(ProxyTestResult {
                success: false,
                latency_ms: None,
                ip: None,
                country: None,
                country_code: None,
                city: None,
                isp: None,
                error: Some(format!("Error configurando cliente HTTP: {}", e)),
                protocol: Some(protocol),
                host: Some(host),
                port: Some(port),
                has_auth,
                canonical: Some(canonical),
                ..Default::default()
            });
        }
    };

    let start = Instant::now();

    // 1. Intento primario con ip-api (incluyendo zona horaria, coordenadas e idioma)
    let res = client
        .get("http://ip-api.com/json/?fields=status,query,country,countryCode,city,isp,timezone,offset,lat,lon")
        .send()
        .await;

    let latency = start.elapsed().as_millis() as u64;

    match res {
        Ok(response) => {
            if let Ok(info) = response.json::<IpApiCheckResponse>().await {
                if info.status.as_deref() == Some("success") {
                    let tz = info.timezone.clone();
                    let offset_min = info.offset.map(|sec| sec / 60);
                    let lat = info.lat;
                    let lon = info.lon;
                    let lang = info.country_code.as_deref().map(suggest_language_from_country);

                    return Ok(ProxyTestResult {
                        success: true,
                        latency_ms: Some(latency),
                        ip: info.query,
                        country: info.country,
                        country_code: info.country_code,
                        city: info.city,
                        isp: info.isp,
                        error: None,
                        protocol: Some(protocol),
                        host: Some(host),
                        port: Some(port),
                        has_auth,
                        canonical: Some(canonical),
                        timezone: tz,
                        tz_offset_minutes: offset_min,
                        latitude: lat,
                        longitude: lon,
                        suggested_language: lang,
                    });
                }
            }

            Ok(ProxyTestResult {
                success: true,
                latency_ms: Some(latency),
                ip: None,
                country: Some("Activo / Conectado".into()),
                country_code: None,
                city: None,
                isp: None,
                error: None,
                protocol: Some(protocol),
                host: Some(host),
                port: Some(port),
                has_auth,
                canonical: Some(canonical),
                ..Default::default()
            })
        }
        Err(primary_err) => {
            // 2. Fallback secundario con ipify
            let fallback_start = Instant::now();
            match client.get("https://api.ipify.org?format=json").send().await {
                Ok(resp) => {
                    let fallback_latency = fallback_start.elapsed().as_millis() as u64;
                    if let Ok(ip_data) = resp.json::<IpifyFallbackResponse>().await {
                        Ok(ProxyTestResult {
                            success: true,
                            latency_ms: Some(fallback_latency),
                            ip: ip_data.ip,
                            country: Some("Activo".into()),
                            country_code: None,
                            city: None,
                            isp: None,
                            error: None,
                            protocol: Some(protocol),
                            host: Some(host),
                            port: Some(port),
                            has_auth,
                            canonical: Some(canonical),
                            ..Default::default()
                        })
                    } else {
                        Ok(ProxyTestResult {
                            success: true,
                            latency_ms: Some(fallback_latency),
                            ip: None,
                            country: Some("Activo".into()),
                            country_code: None,
                            city: None,
                            isp: None,
                            error: None,
                            protocol: Some(protocol),
                            host: Some(host),
                            port: Some(port),
                            has_auth,
                            canonical: Some(canonical),
                            ..Default::default()
                        })
                    }
                }
                Err(_) => {
                    let err_msg = primary_err.to_string();
                    let clean_err = if err_msg.contains("timed out") || err_msg.contains("timeout") {
                        "Tiempo de espera agotado (Proxy inalcanzable o muy lento)".into()
                    } else if err_msg.contains("Proxy authentication required") || err_msg.contains("407") {
                        "Error 407: Credenciales de usuario/contraseña incorrectas".into()
                    } else if err_msg.contains("Connection refused") {
                        "Conexión rechazada por el servidor proxy".into()
                    } else {
                        format!("Fallo de conexión: {}", err_msg)
                    };

                    Ok(ProxyTestResult {
                        success: false,
                        latency_ms: None,
                        ip: None,
                        country: None,
                        country_code: None,
                        city: None,
                        isp: None,
                        error: Some(clean_err),
                        protocol: Some(protocol),
                        host: Some(host),
                        port: Some(port),
                        has_auth,
                        canonical: Some(canonical),
                        ..Default::default()
                    })
                }
            }
        }
    }
}

/// Ubicación de la IP con la que el perfil sale realmente a internet.
#[derive(Debug, Clone)]
pub struct EgressGeo {
    pub ip: Option<String>,
    pub country_code: Option<String>,
    pub timezone: String,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    /// Un solo locale BCP 47 (`es-MX`), nunca una lista de Accept-Language.
    pub language: String,
}

#[derive(Debug, Deserialize)]
struct GeoJsResponse {
    ip: Option<String>,
    country_code: Option<String>,
    timezone: Option<String>,
    // geojs devuelve las coordenadas como texto.
    latitude: Option<String>,
    longitude: Option<String>,
}

/// Consulta la ubicación de la IP de salida: a través del proxy si lo hay, o
/// por la conexión directa si no. Es la única fuente de timezone, idioma y
/// coordenadas del perfil: con la zona del sistema o la de la semilla, el
/// perfil podía anunciar un país distinto del de su IP.
///
/// `proxy` debe ser la cadena YA cocinada (con `{sess}` sustituido). Con la
/// cadena cruda el proveedor sticky ve otra sesión y otra IP de salida.
///
/// ip-api primero (incluye offset); geojs como respaldo, porque ip-api limita
/// a ~45 consultas por minuto y algunos proxies bloquean HTTP plano.
pub async fn resolve_egress_geo(proxy: Option<&str>) -> Result<EgressGeo, String> {
    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10));
    if let Some(raw) = proxy.map(str::trim).filter(|p| !p.is_empty()) {
        let parsed = parse_proxy(raw)?;
        let p = reqwest::Proxy::all(parsed.to_reqwest_url())
            .map_err(|e| format!("proxy inválido: {}", e))?;
        builder = builder.proxy(p);
    }
    let client = builder
        .build()
        .map_err(|e| format!("cliente HTTP: {}", e))?;

    let mut errors: Vec<String> = Vec::new();

    match client
        .get("http://ip-api.com/json/?fields=status,query,countryCode,timezone,lat,lon")
        .send()
        .await
    {
        Ok(resp) => match resp.json::<IpApiCheckResponse>().await {
            Ok(info) => {
                let tz = info.timezone.filter(|t| !t.trim().is_empty());
                match (info.status.as_deref(), tz) {
                    (Some("success"), Some(tz)) => {
                        return Ok(EgressGeo {
                            ip: info.query,
                            language: suggest_language_from_country(info.country_code.as_deref().unwrap_or("")),
                            country_code: info.country_code,
                            timezone: tz,
                            latitude: info.lat,
                            longitude: info.lon,
                        });
                    }
                    _ => errors.push("ip-api: respuesta sin ubicación".into()),
                }
            }
            Err(e) => errors.push(format!("ip-api: {}", e)),
        },
        Err(e) => errors.push(format!("ip-api: {}", e)),
    }

    match client.get("https://get.geojs.io/v1/ip/geo.json").send().await {
        Ok(resp) => match resp.json::<GeoJsResponse>().await {
            Ok(info) => {
                if let Some(tz) = info.timezone.filter(|t| !t.trim().is_empty()) {
                    return Ok(EgressGeo {
                        ip: info.ip,
                        language: suggest_language_from_country(info.country_code.as_deref().unwrap_or("")),
                        country_code: info.country_code,
                        timezone: tz,
                        latitude: info.latitude.and_then(|v| v.parse().ok()),
                        longitude: info.longitude.and_then(|v| v.parse().ok()),
                    });
                }
                errors.push("geojs: respuesta sin zona horaria".into());
            }
            Err(e) => errors.push(format!("geojs: {}", e)),
        },
        Err(e) => errors.push(format!("geojs: {}", e)),
    }

    Err(errors.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regresión: devolvía "es-MX,es;q=0.9,en;q=0.8" y eso acababa en
    /// navigator.language y en Emulation.setLocaleOverride tal cual.
    #[test]
    fn suggested_language_es_un_solo_locale() {
        for cc in ["US", "MX", "CH", "BE", "VE", "SE", "JP", "XX", "", "mx"] {
            let l = suggest_language_from_country(cc);
            assert!(!l.contains(',') && !l.contains(';'), "{cc} -> {l}");
            let (lang, region) = l.split_once('-').expect("formato ll-RR");
            assert!(lang.len() >= 2 && region.len() == 2, "{cc} -> {l}");
        }
        assert_eq!(suggest_language_from_country("mx"), "es-MX");
        assert_eq!(suggest_language_from_country("VE"), "es-VE");
    }

    /// Necesita red: `cargo test --lib -- --ignored egress_geo`.
    #[test]
    #[ignore]
    fn egress_geo_directo_en_vivo() {
        let geo = tauri::async_runtime::block_on(resolve_egress_geo(None)).expect("geo");
        eprintln!("{geo:?}");
        assert!(geo.timezone.contains('/'));
        assert!(!geo.language.contains(','));
        assert!(geo.latitude.is_some() && geo.longitude.is_some());
    }

    #[test]
    fn test_various_formats() {
        // 1. host:port:user:pass
        let p1 = parse_proxy("185.199.229.156:7492:user123:pass456").unwrap();
        assert_eq!(p1.host, "185.199.229.156");
        assert_eq!(p1.port, 7492);
        assert_eq!(p1.username.as_deref(), Some("user123"));
        assert_eq!(p1.password.as_deref(), Some("pass456"));

        // 2. user:pass:host:port
        let p2 = parse_proxy("user123:pass456:185.199.229.156:7492").unwrap();
        assert_eq!(p2.host, "185.199.229.156");
        assert_eq!(p2.port, 7492);
        assert_eq!(p2.username.as_deref(), Some("user123"));
        assert_eq!(p2.password.as_deref(), Some("pass456"));

        // 3. user:pass@host:port
        let p3 = parse_proxy("user123:pass456@185.199.229.156:7492").unwrap();
        assert_eq!(p3.host, "185.199.229.156");
        assert_eq!(p3.port, 7492);
        assert_eq!(p3.username.as_deref(), Some("user123"));

        // 4. host:port@user:pass
        let p4 = parse_proxy("185.199.229.156:7492@user123:pass456").unwrap();
        assert_eq!(p4.host, "185.199.229.156");
        assert_eq!(p4.port, 7492);

        // 5. socks5://
        let p5 = parse_proxy("socks5://185.199.229.156:7492:user123:pass456").unwrap();
        assert_eq!(p5.protocol, "socks5");
        assert_eq!(p5.host, "185.199.229.156");
        assert_eq!(p5.port, 7492);

        // 6. pipes
        let p6 = parse_proxy("185.199.229.156|7492|user123|pass456").unwrap();
        assert_eq!(p6.host, "185.199.229.156");
        assert_eq!(p6.port, 7492);

        // 7. semicolon
        let p7 = parse_proxy("185.199.229.156;7492;user123;pass456").unwrap();
        assert_eq!(p7.host, "185.199.229.156");
        assert_eq!(p7.port, 7492);

        // 8. whitespace
        let p8 = parse_proxy("185.199.229.156 7492 user123 pass456").unwrap();
        assert_eq!(p8.host, "185.199.229.156");
        assert_eq!(p8.port, 7492);

        // 9. host:port simple
        let p9 = parse_proxy("185.199.229.156:8080").unwrap();
        assert_eq!(p9.host, "185.199.229.156");
        assert_eq!(p9.port, 8080);
        assert!(p9.username.is_none());

        // 10. domain with subdomains
        let p10 = parse_proxy("pr.oxylabs.io:7777:customer-user:pwd-99").unwrap();
        assert_eq!(p10.host, "pr.oxylabs.io");
        assert_eq!(p10.port, 7777);
    }

    #[test]
    fn test_chromium_uri_with_creds() {
        // HTTP con credenciales => URI embebida para --proxy-server
        let p = parse_proxy("185.199.229.156:7492:user123:pass456").unwrap();
        assert_eq!(
            p.to_chromium_uri_with_creds().as_deref(),
            Some("http://user123:pass456@185.199.229.156:7492")
        );

        // Caracteres especiales escapados
        let p = parse_proxy("185.199.229.156:7492:user@x:p%ss:w/rd").unwrap();
        let uri = p.to_chromium_uri_with_creds().unwrap();
        assert!(!uri.contains(' '));
        assert!(uri.contains("%40") || uri.contains("@x"));

        // Sin credenciales => None (usa el flag sin autenticación)
        let p = parse_proxy("185.199.229.156:8080").unwrap();
        assert!(p.to_chromium_uri_with_creds().is_none());

        // SOCKS nunca lleva credenciales en el URI de Chromium
        let p = parse_proxy("socks5://pr.oxylabs.io:7777:user:pwd").unwrap();
        assert!(p.to_chromium_uri_with_creds().is_none());
    }

    #[test]
    fn test_shield_connect_local() {
        use std::io::{Read, Write};
        let origin = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let op = origin.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut c, _) = origin.accept().unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 1024];
            loop {
                let n = c.read(&mut tmp).unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            eprintln!("[origin-connect] recibió: {}", String::from_utf8_lossy(&buf).lines().next().unwrap_or(""));
            c.write_all(b"HTTP/1.1 200 Connection established\r\n\r\ndemo-tunnel-bytes").unwrap();
            c.shutdown(std::net::Shutdown::Write).unwrap();
        });
        let parsed = ParsedProxy {
            protocol: "http".into(),
            host: "127.0.0.1".into(),
            port: op,
            username: None,
            password: None,
        };
        let stats = Arc::new(TrafficStats::new());
        let shield = spawn_shield(&parsed, stats.clone()).expect("spawn Shield");
        let mut sock = std::net::TcpStream::connect(("127.0.0.1", shield.port)).unwrap();
        sock.write_all(b"CONNECT target.invalid:443 HTTP/1.1\r\nHost: target.invalid:443\r\n\r\n").unwrap();
        let mut out = Vec::new();
        sock.read_to_end(&mut out).expect("lectura respuesta shield");
        let txt = String::from_utf8_lossy(&out).to_string();
        eprintln!("[test] respuesta CONNECT ({} bytes): {}", out.len(), txt.replace('\n', " ").chars().take(120).collect::<String>());
        assert!(txt.starts_with("HTTP/1.1 200 Connection established"), "shield no estableció CONNECT");
        assert!(txt.contains("demo-tunnel-bytes"), "no relayó bytes del túnel CONNECT");
        let (bytes, _) = stats.snapshot();
        assert!(bytes > 0, "no se contaron bytes");
    }

    #[test]
    fn test_shield_tunnel_with_live_proxy() {
        let raw = std::env::var("KRAKENGES_TEST_PROXY").unwrap_or_default();
        if raw.is_empty() {
            eprintln!("[test] SKIP: define KRAKENGES_TEST_PROXY para probar ProxyShield en vivo");
            return;
        }
        let parsed = parse_proxy(&raw).expect("parse proxy ok");
        assert!(parsed.username.is_some(), "necesita credenciales");
        let stats = Arc::new(TrafficStats::new());
        let shield = spawn_shield(&parsed, stats.clone()).expect("spawn Shield");
        eprintln!("[test] ProxyShield local 127.0.0.1:{}", shield.port);

        let (ip, country) = shield.verify().expect("verify through shield");
        eprintln!("[test] IP de salida: {} ({})", ip, country);
        assert!(!ip.is_empty(), "IP vacía a través del conector");
        let (bytes, _) = stats.snapshot();
        assert!(bytes > 0, "deben contarse bytes del túnel");
        eprintln!("[test] bytes contados: {}", bytes);

        use std::io::{Read, Write};
        let mut sock = std::net::TcpStream::connect(("127.0.0.1", shield.port)).expect("conectar al shield");
        sock.write_all(b"CONNECT ip-api.com:80 HTTP/1.1\r\nHost: ip-api.com:80\r\n\r\n").unwrap();
        let mut hand = Vec::new();
        let mut tmp = [0u8; 1024];
        let n = sock.read(&mut tmp).expect("lectura handshake CONNECT");
        hand.extend_from_slice(&tmp[..n]);
        let hs = String::from_utf8_lossy(&hand);
        eprintln!("[test] handshake CONNECT: {}", hs.replace('\n', " ").chars().take(100).collect::<String>());
        assert!(hs.starts_with("HTTP/1.1 200"), "CONNECT a través del shield rechazado: {}", hs);
        sock.write_all(b"GET /json/?fields=status,query,country HTTP/1.1\r\nHost: ip-api.com\r\nConnection: close\r\n\r\n").unwrap();
        let mut out = Vec::new();
        sock.read_to_end(&mut out).expect("lectura túnel CONNECT");
        let txt = String::from_utf8_lossy(&out).to_string();
        eprintln!("[test] respuesta túnel CONNECT ({} bytes): {}", out.len(), txt.replace('\n', " ").chars().take(120).collect::<String>());
        assert!(txt.contains("\"success\"") || txt.contains("\"fail\""), "túnel CONNECT no respondió JSON");
    }

    #[test]
    fn test_shield_relay_local() {
        use std::io::{Read, Write};
        let origin = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let op = origin.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut c, _) = origin.accept().unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 1024];
            loop {
                let n = c.read(&mut tmp).unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            eprintln!("[origin] recibió: {}", String::from_utf8_lossy(&buf).lines().next().unwrap_or(""));
            c.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK").unwrap();
            c.shutdown(std::net::Shutdown::Write).unwrap();
        });
        let parsed = ParsedProxy {
            protocol: "http".into(),
            host: "127.0.0.1".into(),
            port: op,
            username: None,
            password: None,
        };
        let stats = Arc::new(TrafficStats::new());
        let shield = spawn_shield(&parsed, stats.clone()).expect("spawn Shield");
        let mut sock = std::net::TcpStream::connect(("127.0.0.1", shield.port)).unwrap();
        sock.write_all(b"GET http://target.invalid/x HTTP/1.1\r\nHost: target.invalid\r\nConnection: close\r\n\r\n").unwrap();
        let mut out = Vec::new();
        sock.read_to_end(&mut out).expect("lectura respuesta shield");
        let txt = String::from_utf8_lossy(&out).to_string();
        eprintln!("[test] respuesta recibida ({} bytes): {}", out.len(), txt.replace('\n', " ").chars().take(160).collect::<String>());
        assert!(txt.contains("200 OK"), "shield no relayó la respuesta (200 OK ausente)");
        let (bytes, _) = stats.snapshot();
        assert!(bytes > 0, "no se contaron bytes");
    }
}
