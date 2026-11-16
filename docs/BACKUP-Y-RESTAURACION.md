# Backup y restauración de MongoDB

Este runbook cubre la base de datos. **No** incluye el `.env`, la clave privada
de licencias, la clave privada del updater ni ningún otro secreto: esos se
guardan aparte, cifrados y con acceso restringido.

## Qué se respalda

- Una base de MongoDB (`MONGO_DB`, por defecto `krakenges`) con
  `mongodump --archive --gzip`.
- El backup se cifra con `age` o GPG antes de escribirlo en disco.
- Se guarda un `.sha256` y un `.json` con fecha, base, tamaño, cifrado y versión
  de `mongodump`.

No se generan backups en claro. Si `BACKUP_AGE_RECIPIENT` y
`BACKUP_GPG_RECIPIENT` están vacíos, el script falla a propósito.

## Requisitos

En el VPS:

```bash
sudo apt-get install -y mongodb-database-tools age gzip coreutils
# o, si se usa GPG en lugar de age:
sudo apt-get install -y mongodb-database-tools gnupg gzip coreutils
```

El usuario del servicio (`backup`) necesita:

- Leer la base con un usuario de MongoDB de solo lectura.
- Escribir en `/var/backups/krakenges`.
- Leer `/etc/krakenges/backup.env`.
- Usar la clave pública de cifrado. La privada **no** debe estar en el VPS.

No uses el usuario `root` de MongoDB para el backup.

## 1. Crear el usuario de backup en MongoDB

Con un usuario administrador, crea un usuario de solo lectura para la base:

```javascript
use krakenges
db.createUser({
  user: "usuario_backup",
  pwd: passwordPrompt(),
  roles: [{ role: "read", db: "krakenges" }]
})
```

Guarda la contraseña en `/etc/krakenges/backup.env`, no en el repositorio.

## 2. Configurar el entorno

```bash
sudo install -d -m 0750 -o root -g backup /etc/krakenges
sudo install -m 0640 -o root -g backup \
  ops/backup/krakenges-backup.env.example /etc/krakenges/backup.env
sudo editor /etc/krakenges/backup.env
```

Rellena `MONGO_URI`, `MONGO_DB` y **uno** de los destinatarios:

- `BACKUP_AGE_RECIPIENT=age1...`
- `BACKUP_GPG_RECIPIENT=...`

El destinatario es una clave pública. La identidad privada de age, o la clave
privada de GPG, se guarda fuera del VPS y se usa solo para restaurar.

### GPG

El servicio usa `GNUPGHOME=/var/lib/krakenges-backup/gnupg` y corre como `backup`.
Importa ahí la clave pública:

```bash
sudo -u backup GNUPGHOME=/var/lib/krakenges-backup/gnupg \
  gpg --import /ruta/clave-publica.asc
sudo -u backup GNUPGHOME=/var/lib/krakenges-backup/gnupg \
  gpg --list-keys
```

Comprueba que la huella del `BACKUP_GPG_RECIPIENT` coincide.

## 3. Instalar el servicio y el timer

```bash
sudo install -m 0755 -o root -g root \
  ops/backup/krakenges-backup.sh /opt/krakenges/ops/backup/krakenges-backup.sh
sudo install -m 0755 -o root -g root \
  ops/backup/krakenges-restore.sh /opt/krakenges/ops/backup/krakenges-restore.sh
sudo install -m 0644 -o root -g root \
  ops/systemd/krakenges-backup.service /etc/systemd/system/krakenges-backup.service
sudo install -m 0644 -o root -g root \
  ops/systemd/krakenges-backup.timer /etc/systemd/system/krakenges-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now krakenges-backup.timer
```

El timer ejecuta el backup a las 03:15, hora local del VPS, con hasta 15 minutos
de retraso aleatorio. `Persistent=true` recupera la ejecución si el VPS estaba
apagado a esa hora.

Comprueba el calendario:

```bash
systemctl list-timers krakenges-backup.timer
```

## 4. Primera ejecución y verificación

Antes de programar nada, prueba la configuración sin tocar MongoDB:

```bash
sudo -u backup --preserve-env=MONGO_URI,BACKUP_AGE_RECIPIENT \
  /opt/krakenges/ops/backup/krakenges-backup.sh --dry-run
```

Después ejecuta una vez:

```bash
sudo systemctl start krakenges-backup.service
sudo systemctl status krakenges-backup.service --no-pager
sudo journalctl -u krakenges-backup.service -n 50 --no-pager
ls -lh /var/backups/krakenges
```

Debe aparecer un fichero `krakenges-*.dump.gz.age` o `.gpg`, su `.sha256` y su
`.json`. Los permisos deben ser `600` y el directorio `700`.

Verifica el checksum en el VPS:

```bash
cd /var/backups/krakenges
sha256sum -c krakenges-2026....dump.gz.age.sha256
```

La verificación completa se hace en una máquina con la identidad privada:

```bash
BACKUP_AGE_IDENTITY=/ruta/segura/age-identity.txt \
  ./ops/backup/krakenges-restore.sh \
  --file /ruta/copiada/krakenges-2026....dump.gz.age \
  --check-only
```

`--check-only` comprueba checksum, descifrado y gzip. No escribe en MongoDB.

## 5. Simulacro de restauración

No esperes a un incidente para probar el restore. Hazlo primero contra una base
de staging:

```bash
# 1. Elige un backup y una base de staging.
BACKUP_AGE_IDENTITY=/ruta/segura/age-identity.txt \
TARGET_URI='mongodb://usuario:clave@127.0.0.1:27017/?authSource=admin' \
  ./ops/backup/krakenges-restore.sh \
  --file /ruta/backup.age \
  --target-db krakenges-restore \
  --dry-run

# 2. Repite sin --dry-run y confirma.
BACKUP_AGE_IDENTITY=/ruta/segura/age-identity.txt \
TARGET_URI='mongodb://usuario:clave@127.0.0.1:27017/?authSource=admin' \
  ./ops/backup/krakenges-restore.sh \
  --file /ruta/backup.age \
  --target-db krakenges-restore \
  --yes
```

Comprueba en `krakenges-restore` que están las colecciones y documentos
esperados. No apuntes el backend de producción a la base de staging.

### Restauración real

1. Haz un backup nuevo antes de tocar nada.
2. Para el backend:

   ```bash
   sudo systemctl stop krakenges-backend.service
   ```

3. Restaura sobre la base de producción, con confirmación explícita:

   ```bash
   BACKUP_AGE_IDENTITY=/ruta/segura/age-identity.txt \
   TARGET_URI='mongodb://usuario:clave@127.0.0.1:27017/?authSource=admin' \
     ./ops/backup/krakenges-restore.sh \
     --file /ruta/backup.age \
     --target-db krakenges \
     --yes
   ```

   `--drop` solo si sabes que quieres borrar las colecciones destino antes de
   restaurar. Sin `--drop`, `mongorestore` puede duplicar documentos existentes.

4. Arranca el backend:

   ```bash
   sudo systemctl start krakenges-backend.service
   sudo systemctl status krakenges-backend.service --no-pager
   curl -fsS http://127.0.0.1:8010/health
   ```

5. Comprueba login, dashboard, licencias y un par de usuarios reales antes de
   dar la restauración por buena.

### Volver atrás

Si la restauración falla, restaura el backup que hiciste en el paso 1 con el
mismo procedimiento. No borres los backups anteriores hasta que la aplicación
lleve un tiempo funcionando.

## 6. Retención

- `BACKUP_KEEP_DAYS=14`: borra copias con más de 14 días.
- `BACKUP_KEEP_MIN=7`: nunca borra las 7 más recientes, aunque sean antiguas.

La retención solo se aplica después de un backup correcto. Si falla la limpieza,
el backup nuevo queda intacto y el servicio lo anota en el journal.

## 7. Copia fuera del VPS

Un backup en el mismo disco no protege de un fallo del VPS. Copia los ficheros
**cifrados** a otro host o a almacenamiento de objetos:

```bash
rsync -az --delete \
  /var/backups/krakenges/ usuario@otro-host:/backups/krakenges/
```

No copies la identidad privada de age/GPG al mismo host que los backups. Sin
ella, los backups cifrados no se pueden restaurar; con ella en el mismo sitio,
el cifrado no protege de un robo del host.

## 8. Monitorización

Configura una alerta si no aparece un backup nuevo en 26 horas. Ejemplo:

```bash
find /var/backups/krakenges -name 'krakenges-*.dump.gz.*' -mmin -1560 | grep -q . \
  || echo 'ALERTA: no hay backup reciente'
```

No basta con que el timer esté activo: hay que comprobar que el backup terminó
y que el fichero tiene tamaño mayor que cero.

## 9. Estado real y límites

- Los scripts están escritos y se ha validado su sintaxis, pero en este entorno
  **no hay `mongodump`/`mongorestore` ni MongoDB**, así que el backup y el
  restore contra una base real siguen pendientes de ejecutar en el VPS.
- `--check-only` se puede probar con un gzip sintético; no demuestra que los
  datos de MongoDB sean restaurables.
- El script pasa la URI a `mongodump`/`mongorestore` como argumento. En un VPS
  multiusuario, limita quién puede listar procesos (`hidepid=2`) o ejecuta el
  backup en un host dedicado. El usuario de MongoDB debe ser de solo lectura.
- El backup no incluye ficheros del sistema, `.env`, claves privadas ni
  configuraciones de nginx/systemd. Esos elementos necesitan su propio respaldo
  cifrado y un procedimiento de recuperación.
- No hay proveedor de almacenamiento externo configurado todavía.
