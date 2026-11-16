# Despliegue del backend

> **Documento sustituido.** La guía genérica anterior estaba desactualizada:
> describía nginx (el servidor real usa Apache), el puerto 10000 (hoy 8010),
> rutas del despliegue anterior y credenciales de MongoDB en claro. No la uses.

La guía del backend PostgreSQL está en **[`backend-server-pg/ops/README.md`](../../backend-server-pg/ops/README.md)**; para el backend MongoDB, usa `docs/PUESTA-EN-MARCHA.md` y los scripts de `ops/`.

## Resumen canónico

| Elemento | Valor |
|---|---|
| Servidor | AlmaLinux 9 + Apache (`httpd`) |
| Backend | `/opt/krakenges/backend` |
| Servicio systemd | `krakenges-backend.service` |
| Usuario del servicio | `krakenges:krakenges` |
| Escucha | `127.0.0.1:8010` (solo loopback) |
| Cliente web | `/opt/krakenges/web` |
| Base de datos | `krakenges` (usuario `krakenges_app`) |
| Script de despliegue | `deploy-vps.sh` (raíz del repo) |

## Variables de entorno

Parte de `backend-server/.env.example`. Los valores reales viven **solo** en
`/opt/krakenges/backend/.env` (permisos `0600`) y en `/root/krakenges-secrets/`.
No copies credenciales a documentación ni a este repositorio.

`CORS_ORIGIN` es una lista explícita de orígenes; `*` se ignora a propósito.
