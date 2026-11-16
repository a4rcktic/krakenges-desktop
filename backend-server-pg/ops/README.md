# Operación de Kraken Ges (backend PostgreSQL)

Esta carpeta contiene lo necesario para desplegar el backend nuevo en un VPS
con systemd, nginx y PostgreSQL. El backend antiguo (`../backend-server/`) se
mantiene intacto para rollback.

## Contenido

```
ops/
├── postgres/roles.sql              roles y base de datos
├── systemd/                        servicios y timers
├── nginx/krakenges.conf            reverse proxy TLS
├── backup/                         copia y restauración
└── cleanup/                        limpieza de datos caducados
```

## Requisitos

- Linux con systemd.
- Node.js 22 LTS (o 20.19+).
- PostgreSQL 15 o superior (probado con el dialecto de PostgreSQL 16).
- nginx y certbot si vas a servir por HTTPS.
- `pg_dump`, `pg_restore`, `psql` del mismo major que el servidor.

No hace falta Docker. Si el VPS ya tiene PostgreSQL, usa ese; no instales un
segundo servidor solo por este proyecto.

## 1. Usuario y directorios

```bash
sudo useradd --system --home /opt/krakenges --shell /usr/sbin/nologin krakenges
sudo mkdir -p /opt/krakenges/backend /etc/krakenges /var/backups/krakenges
sudo install -d -m 700 -o krakenges -g krakenges /opt/krakenges/backend/.keys
sudo chown -R krakenges:krakenges /opt/krakenges /var/backups/krakenges
sudo chmod 700 /var/backups/krakenges
```

La carpeta `.keys` debe existir aunque uses `KRAKENGES_LICENSE_PRIVATE_KEY`:
el servicio systemd la declara como única ruta escribible.

Copia el contenido de `backend-server-pg/` a `/opt/krakenges/backend/` (sin
`node_modules/`, `dist/` ni `.env`). Ajusta el propietario:

```bash
sudo chown -R krakenges:krakenges /opt/krakenges/backend
```

## 2. Base de datos

Edita `ops/postgres/roles.sql` y cambia **las dos contraseñas** antes de
ejecutarlo. No es idempotente: si los roles ya existen, fallará y no habrá
tocado nada.

```bash
sudo -u postgres psql -f /opt/krakenges/backend/ops/postgres/roles.sql
```

Crea `/etc/krakenges/backend.env` a partir de `.env.example`. Como mínimo:

```dotenv
NODE_ENV=production
PORT=4000
HOST=127.0.0.1
DATABASE_URL=postgres://krakenges_app:CLAVE_REAL@127.0.0.1:5432/krakenges?sslmode=disable
JWT_SECRET=...                 # npm run generate:secret
CORS_ORIGIN=https://TU_DOMINIO
PUBLIC_BASE_URL=https://TU_DOMINIO
KRAKENGES_LICENSE_KEYS_DIR=/opt/krakenges/backend/.keys
```

Permisos:

```bash
sudo chown root:krakenges /etc/krakenges/backend.env
sudo chmod 640 /etc/krakenges/backend.env
```

El usuario `krakenges_app` no puede hacer DDL. Las migraciones se ejecutan con
`krakenges_migrator`.

## 3. Instalar, migrar y compilar

```bash
cd /opt/krakenges/backend
sudo -u krakenges npm ci
sudo -u krakenges npm run build
```

Migraciones (con el rol migrador; `dotenv` no pisa variables ya definidas):

```bash
sudo -u krakenges env \
  DATABASE_URL='postgres://krakenges_migrator:CLAVE@127.0.0.1:5432/krakenges?sslmode=disable' \
  npm run db:migrate
```

Crea el Owner inicial:

```bash
sudo -u krakenges env OWNER_PASSWORD='...' npm run seed:owner
```

Si vas a migrar datos de MongoDB, hazlo **antes** de abrir el servicio al
público. El importador está en `npm run migrate:mongo`.

### Claves de licencia

Los tickets existentes solo siguen siendo válidos si conservas el mismo par
Ed25519 que usaba el backend antiguo. Copia el directorio `.keys/` del backend
viejo:

```bash
sudo install -d -m 700 -o krakenges -g krakenges /opt/krakenges/backend/.keys
sudo install -m 600 -o krakenges -g krakenges \
  /ruta/al/backend-server/.keys/license_ed25519.pem \
  /opt/krakenges/backend/.keys/license_ed25519.pem
sudo install -m 644 -o krakenges -g krakenges \
  /ruta/al/backend-server/.keys/license_ed25519_pub.pem \
  /opt/krakenges/backend/.keys/license_ed25519_pub.pem
```

Comprueba que la clave pública coincide con la incrustada en el cliente:

```bash
cd /opt/krakenges/backend
sudo -u krakenges npm run keys:pub
```

Si no copias las claves, el backend genera un par nuevo y **todos los tickets
emitidos hasta ese momento dejan de verificar**. No hay recuperación posible
salvo restaurar la clave privada.

## 4. Servicio systemd

```bash
sudo cp ops/systemd/krakenges-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now krakenges-backend
sudo systemctl status krakenges-backend
```

Prueba local:

```bash
curl -fsS http://127.0.0.1:4000/health
```

Debe devolver `{"status":"ok","database":"ok",...}`. Si devuelve 503, el
servicio está vivo pero no llega a PostgreSQL: revisa `DATABASE_URL`, el rol y
`pg_hba.conf`.

Logs:

```bash
sudo journalctl -u krakenges-backend -f
```

## 5. nginx y TLS

Edita `ops/nginx/krakenges.conf` y sustituye `krakenges.example` por el dominio
real. Copia el fichero a `/etc/nginx/sites-available/`, enlázalo en
`sites-enabled/` y valida:

```bash
sudo ln -s /etc/nginx/sites-available/krakenges.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

El certificado se emite con certbot:

```bash
sudo certbot --nginx -d TU_DOMINIO -d www.TU_DOMINIO
```

Si el frontend se sirve desde otro sitio, deja el `location /` como está. Si
vas a servirlo desde este nginx, cambia el `return 404` por un `root` con
`try_files`.

## 6. Copias de seguridad

```bash
sudo cp ops/systemd/krakenges-backup.service ops/systemd/krakenges-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now krakenges-backup.timer
```

Copia manual:

```bash
sudo -u krakenges /opt/krakenges/backend/ops/backup/krakenges-backup.sh
```

Los volcados van a `/var/backups/krakenges/` con permisos `0600`, checksum
SHA-256 y retención de 14 días. **Copia esa carpeta fuera del VPS** (rsync,
restic, S3...). Una copia en el mismo disco no protege de un fallo del disco.

Restauración (destructiva):

```bash
sudo systemctl stop krakenges-backend
sudo -u krakenges /opt/krakenges/backend/ops/backup/krakenges-restore.sh \
  /var/backups/krakenges/krakenges-YYYYMMDDTHHMMSSZ.dump
sudo systemctl start krakenges-backend
```

El script pide escribir `RESTAURAR` salvo que pases `--yes`. Usa
`TARGET_DATABASE_URL` para restaurar en una base de pruebas.

## 7. Limpieza

```bash
sudo cp ops/systemd/krakenges-cleanup.service ops/systemd/krakenges-cleanup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now krakenges-cleanup.timer
```

Borra refresh tokens caducados, API keys caducadas, marca licencias expiradas y
elimina `activity_logs` de más de 90 días. No borra sesiones ni perfiles.

Ejecución manual:

```bash
sudo -u krakenges /opt/krakenges/backend/ops/cleanup/krakenges-cleanup.sh
```

## 8. Actualizaciones

```bash
cd /opt/krakenges/backend
sudo systemctl stop krakenges-backend
sudo -u krakenges npm ci
sudo -u krakenges npm run build
sudo -u krakenges env DATABASE_URL='...migrator...' npm run db:migrate
sudo systemctl start krakenges-backend
curl -fsS http://127.0.0.1:4000/health
```

Haz una copia antes de migrar. Si la migración falla, no arranques el servicio:
restaura el volcado anterior.

## 9. Rollback al backend MongoDB

El backend viejo sigue en `../backend-server/`. Para volver atrás:

1. Para `krakenges-backend`.
2. Arranca el servicio antiguo (su propio systemd o `npm start`).
3. Devuelve el proxy/dominio al puerto antiguo.
4. **No borres** la base PostgreSQL ni el directorio `.keys` hasta validar que
   el rollback funciona.

Los datos escritos en PostgreSQL durante la ventana de corte no existen en
Mongo. Si el corte dura horas, el rollback pierde esos cambios. Planifica una
ventana corta y congela escrituras.

## 10. Checklist de seguridad

- [ ] Contraseñas de `krakenges_app` y `krakenges_migrator` distintas y fuertes.
- [ ] `JWT_SECRET` generado con `npm run generate:secret`, no el de ejemplo.
- [ ] `.env` con permisos `640 root:krakenges`; nunca en el repositorio.
- [ ] PostgreSQL escuchando solo en loopback o firewall cerrado.
- [ ] `sslmode=disable` solo si la conexión es por loopback. Para remoto, TLS.
- [ ] `.keys/` con permisos `700`, privada `600`, y copia segura fuera del VPS.
- [ ] `CORS_ORIGIN` con el dominio real, sin `*`.
- [ ] HTTPS con HSTS y renovación automática de certbot.
- [ ] Copias probadas con una restauración real en una base de pruebas.
- [ ] `krakenges-backup.timer` y `krakenges-cleanup.timer` activos.
- [ ] Logs revisados: `journalctl -u krakenges-backend --since today`.

## 11. Valores pendientes antes de producción

Estos placeholders siguen en el proyecto y deben sustituirse:

- Dominio real (`krakenges.example`) en `brand.config.json`, `.env`,
  `ops/nginx/krakenges.conf` y la configuración del cliente.
- `licensePublicKey`, `updaterPublicKey` y `androidReleaseSha256` en la
  configuración de la app.
- Claves de licencia del backend antiguo (ver sección 3).
- `RESEND_API_KEY` y `MAIL_FROM` si quieres recuperación de contraseña.
- Contraseñas reales en `ops/postgres/roles.sql` (no las de ejemplo).
