# Kraken Ges — backend PostgreSQL

Backend HTTP de Kraken Ges reescrito sobre **PostgreSQL + Drizzle ORM**. Sustituye
al backend MongoDB (`../backend-server/`) manteniendo el contrato REST que ya
consumen la app de escritorio, la web y la app móvil.

El backend antiguo **no se ha tocado**. Puedes volver a él mientras valides el
nuevo.

## Stack

- Node.js 20.20+ / 22 LTS
- TypeScript estricto, CommonJS
- Express 4.21 (no Express 5: se conserva el comportamiento de rutas y
  middleware del backend original)
- PostgreSQL 16 mediante `pg` y Drizzle ORM
- PGlite (PostgreSQL en WASM) para tests, sin necesidad de un servidor local
- Pino a stdout; systemd/journald se encarga de la rotación
- Ed25519 para tickets de licencia, bcrypt para contraseñas, JWT para sesión

## Desarrollo

```bash
npm install
cp .env.example .env
# Rellena DATABASE_URL y JWT_SECRET (npm run generate:secret)
npm run dev
```

Si no tienes PostgreSQL local, puedes ejecutar los tests, que usan PGlite:

```bash
npm test
```

Comprobaciones:

```bash
npm run typecheck       # src/
npm run typecheck:all   # src/ + scripts/
npm run build           # dist/
```

## Scripts

| Script | Qué hace |
| --- | --- |
| `npm run dev` | Servidor con recarga (`tsx watch`) |
| `npm run build` | Compila a `dist/` |
| `npm start` | Ejecuta `dist/index.js` |
| `npm test` | Tests de integración con PGlite |
| `npm run db:generate` | Genera una migración Drizzle desde `schema.ts` |
| `npm run db:migrate` | Aplica migraciones (rol migrador) |
| `npm run db:studio` | Drizzle Studio |
| `npm run seed:owner` | Crea el Owner inicial |
| `npm run keys:pub` | Imprime la clave pública Ed25519 |
| `npm run generate:secret` | Genera un `JWT_SECRET` |
| `npm run migrate:mongo` | Importa un volcado JSON de MongoDB |

## Estructura

```
src/
├── app.ts                 composición de Express
├── index.ts               arranque, health check y apagado ordenado
├── config.ts              variables de entorno
├── config/                planes, marca, URLs públicas, contenido
├── db/
│   ├── schema.ts          esquema canónico
│   ├── client.ts          pool pg / PGlite
│   ├── context.ts         helpers de transacción
│   └── raw.ts             consultas SQL puntuales
├── middleware/            auth, sanitización
├── routes/                auth, users, profiles, sessions, keys, ...
├── services/              licencias, suscripciones, perfiles, tokens, ...
└── utils/                 asyncHandler, JWT
drizzle/                   migraciones SQL generadas
scripts/                   seed, claves, importación Mongo
ops/                       systemd, nginx, backup, limpieza
```

## API

Todas las rutas cuelgan de `/api/`:

| Prefijo | Contenido |
| --- | --- |
| `/api/auth` | registro, login, 2FA, refresh, logout, ticket |
| `/api/users` | perfil propio, administración, analítica, backup |
| `/api/profiles` | perfiles, tags, browser state, proxy |
| `/api/fingerprint` | semilla estable por usuario/perfil |
| `/api/keys` | generación y gestión de licencias, créditos de seller |
| `/api/dashboard` | resumen del usuario |
| `/api/activity` | historial de actividad |
| `/api/apikeys` | API keys personales |
| `/api/membership` | estado de suscripción y canje |
| `/api/content` | contenido público |
| `/api/sessions` | historial de sesiones |
| `/api/updates` | manifiesto del updater |

`GET /health` y `GET /api/health` comprueban la base de datos de verdad. Si
PostgreSQL no responde, devuelven `503`.

## Decisiones de diseño

- **IDs `TEXT`, no `UUID`.** Se conservan los ObjectId de MongoDB como strings
  para que la migración no invalide tickets, huellas ni estados de navegador.
  Las filas nuevas usan `gen_random_uuid()::text` por defecto.
- **Enums como `TEXT` + `CHECK`.** Añadir un valor no requiere una migración
  destructiva de tipo.
- **Tokens hasheados.** `refresh_tokens.token` y `api_keys.key` guardan el alias
  `sha256:<hash>`; la verificación usa `token_hash`/`key_hash`. Los valores en
  claro nunca se persisten.
- **`sessions.profile_id` nullable con `ON DELETE SET NULL`.** Borrar un perfil
  no borra el historial de sesiones.
- **`activity_logs.user_id` nullable con `ON DELETE SET NULL`.** La auditoría
  sobrevive al borrado del usuario.
- **`duration_days` es `double precision`.** Hay claves de 5 horas (0.2083 días).
- **Sin transacciones multi-documento de Mongo.** Las operaciones que lo
  necesitan usan transacciones reales de PostgreSQL.

## Tests

`npm test` ejecuta la suite de integración contra PGlite:

- salud, registro/login, 2FA y refresh
- perfiles, tags y fingerprint estable
- browser state y borrado en cascada
- sesiones, dashboard, membresía y API keys
- administración, analítica y backup
- generación de claves, caducidad de 5 horas y canje
- créditos de seller y débito atómico
- importación Mongo e idempotencia

PGlite es PostgreSQL real compilado a WASM, pero **no sustituye una prueba
contra el PostgreSQL de producción**. Antes del corte, haz un smoke test con
`psql` y el rol real.

## Limitaciones conocidas

- El rate limit de Express usa el store en memoria. Con una sola instancia va
  bien; si escalas horizontalmente, muévelo a Redis.
- Los `browser_states` guardan cookies y localStorage en texto plano en la base
  de datos. Es deuda técnica heredada; cifrarlos requiere una migración de
  datos y un cambio en el cliente.
- No hay worker distribuido. Backup y limpieza se ejecutan por systemd timers
  en una sola máquina.
- El backend no sirve el frontend; el reverse proxy solo hace proxy a `/api/` y
  `/health`.

## Operación

Lee `ops/README.md` para el despliegue completo: roles de PostgreSQL, systemd,
nginx, TLS, backup, restauración, limpieza y rollback.

Para importar datos del backend MongoDB anterior, conserva `../backend-server/`
para rollback y usa `npm run migrate:mongo`.
