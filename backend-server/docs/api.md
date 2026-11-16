# Kraken Ges API Reference

Base URL: `https://krakenges.example/api`

## Autenticacion

Todas las rutas (excepto `/auth/login` y `/auth/register`) requieren header:

```
Authorization: Bearer <accessToken>
```

Los tokens de acceso expiran según `JWT_EXPIRES_IN` (15m por defecto). Usar `/auth/refresh` para renovar.

---

## Auth

### POST `/auth/register`

Registrar nuevo usuario con license key.

**Body:**
```json
{
  "name": "Sebastian",
  "username": "sebas95",
  "email": "correo@gmail.com",
  "password": "MiPass123!",
  "key": "MSK-SHDW-XXXXXX-XXXXXX"
}
```

**Response 201:**
```json
{
  "accessToken": "eyJ...",
  "refreshToken": "abc123...",
  "user": { "id": "...", "name": "Sebastian", "plan": "basic" }
}
```

### POST `/auth/login`

```json
{ "username": "sebas95", "password": "MiPass123!" }
```

O con email: `{ "email": "correo@gmail.com", "password": "..." }`

**Response 200:**
```json
{
  "accessToken": "eyJ...",
  "refreshToken": "abc123...",
  "user": { "id": "...", "name": "Sebastian", "plan": "basic" }
}
```

### POST `/auth/refresh`

```json
{ "refreshToken": "abc123..." }
```

**Response 200:** `{ "accessToken": "eyJ...", "refreshToken": "nuevo..." }`

### POST `/auth/logout` *(auth)*

Cierra sesion y revoca refresh token.

---

## Users

### GET `/users/me` *(auth)*

Retorna el perfil del usuario actual.

### PATCH `/users/me` *(auth)*

Actualizar nombre o email.

```json
{ "name": "Nuevo Nombre", "email": "nuevo@mail.com" }
```

### POST `/users/me/change-password` *(auth)*

```json
{ "currentPassword": "...", "newPassword": "NuevaPass123!" }
```

### GET `/users` *(admin)*

Lista todos los usuarios.

### PATCH `/users/:id/plan` *(admin)*

Cambiar plan de un usuario.

```json
{ "plan": "pro" }
```

### PATCH `/users/:id/ban` *(admin)*

Banear/desbanear usuario.

### POST `/users/:id/reset-password` *(admin)*

Resetear password de un usuario.

```json
{ "newPassword": "NuevaPass123!" }
```

---

## Profiles

### GET `/profiles` *(auth)*

Lista perfiles del usuario.

**Query:** `?tag=trabajo&search=amazon`

### POST `/profiles` *(auth)*

Crear perfil.

```json
{
  "name": "Shein MX",
  "proxy": "http://user:pass@proxy.com:8080",
  "startUrl": "https://shein.com.mx",
  "tags": ["trabajo", "shein"],
  "notes": "Cuenta principal"
}
```

### GET `/profiles/:id` *(auth)*

Obtener perfil por ID.

### GET `/profiles/:id/fingerprint` *(auth)*

Obtener fingerprint y cookies del perfil.

**Response:**
```json
{
  "fingerprint": {
    "userAgent": "Mozilla/5.0...",
    "platform": "Win32",
    "timezone": "America/Mexico_City",
    "locale": "es-MX",
    "webglVendor": "Google Inc. (NVIDIA)",
    "webglRenderer": "ANGLE (NVIDIA, GTX 1660...)"
  },
  "cookies": "[{...}]"
}
```

### PATCH `/profiles/:id` *(auth)*

Actualizar perfil.

### DELETE `/profiles/:id` *(auth)*

Eliminar perfil y sus datos.

### POST `/profiles/:id/clone` *(auth)*

Clonar perfil con nueva identidad.

### GET `/profiles/export` *(auth)*

Exportar todos los perfiles como JSON.

### POST `/profiles/import` *(auth)*

Importar perfiles desde JSON.

```json
{
  "profiles": [
    { "name": "Perfil 1", "proxy": "...", "tags": ["..."] }
  ]
}
```

### POST `/profiles/bulk` *(auth)*

Crear multiples perfiles de una vez (max 100).

### POST `/profiles/:id/validate-proxy` *(auth)*

Validar que el proxy del perfil funciona.

### POST `/profiles/validate-proxy` *(auth)*

Validar un proxy arbitrario.

```json
{ "proxy": "socks5://user:pass@host:1080" }
```

---

## Sessions

### GET `/sessions` *(auth)*

Lista sesiones. `?status=active|stopped`

### POST `/sessions/start` *(auth)*

Iniciar sesion para un perfil.

```json
{ "profileId": "..." }
```

### POST `/sessions/:id/stop` *(auth)*

Detener sesion.

### POST `/sessions/:id/reactivate` *(auth)*

Reactivar sesion detenida.

### DELETE `/sessions/:id` *(auth)*

Eliminar registro de sesion.

---

## Dashboard

### GET `/dashboard` *(auth)*

Resumen: total perfiles, sesiones activas, usuarios (admin).

---

## Activity Log

### GET `/activity` *(auth)*

Historial de actividades del usuario.

### GET `/activity/actions` *(auth)*

Lista de tipos de accion disponibles.

---

## API Keys

### GET `/apikeys` *(auth)*

Lista API keys del usuario.

### POST `/apikeys` *(auth)*

Crear nueva API key.

```json
{ "name": "Mi App" }
```

### DELETE `/apikeys/:id` *(auth)*

Eliminar API key.

### PATCH `/apikeys/:id/toggle` *(auth)*

Activar/desactivar API key.

---

## Membership

### GET `/membership/plans` *(public)*

Planes disponibles y sus limites.

### GET `/membership/status` *(auth)*

Estado de membresia del usuario.

### POST `/membership/upgrade` *(auth)*

Upgrade de plan.

```json
{ "plan": "pro", "paymentMethodId": "pm_..." }
```

### GET `/membership/usage` *(auth)*

Uso actual vs limites del plan.

---

## License Keys (Admin)

### GET `/keys` *(admin)*

Lista license keys.

### POST `/keys` *(admin)*

Crear license key.

```json
{
  "plan": "basic",
  "maxUses": 1,
  "expiresAt": "2026-12-31"
}
```

### PATCH `/keys/:id` *(admin)*

Actualizar license key.

---

## Rate Limiting

- 120 requests por minuto por IP
- Headers: `RateLimit-Limit`, `RateLimit-Remaining`

## Errores

Todos los errores retornan:

```json
{ "error": "Mensaje de error" }
```

Codigos: 400 (validacion), 401 (no auth), 403 (no admin), 404 (no encontrado), 429 (rate limit), 500 (server).
