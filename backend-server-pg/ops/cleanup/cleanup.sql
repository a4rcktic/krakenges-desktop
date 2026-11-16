-- ---------------------------------------------------------------------------
-- Kraken Ges — limpieza de datos caducados.
--
-- Se ejecuta desde ops/cleanup/krakenges-cleanup.sh, normalmente por el timer
-- systemd krakenges-cleanup.timer. Es idempotente.
--
-- Política:
--   * refresh_tokens: borrar los caducados (no aportan nada y crecen rápido).
--   * api_keys: borrar las claves caducadas.
--   * license_keys: marcar como expired las activas cuya expires_at pasó.
--   * activity_logs: borrar los registros de más de 90 días (equivalente al
--     TTL que tenía MongoDB).
--
-- NO se borran sesiones históricas ni perfiles: son auditoría del usuario.
-- Si necesitas retención para sessions, añade una consulta explícita y
-- documenta el cambio.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

BEGIN;

WITH deleted AS (
  DELETE FROM refresh_tokens
  WHERE expires_at < now()
  RETURNING 1
)
SELECT 'refresh_tokens' AS tabla, count(*) AS borrados FROM deleted;

WITH deleted AS (
  DELETE FROM api_keys
  WHERE expires_at IS NOT NULL AND expires_at < now()
  RETURNING 1
)
SELECT 'api_keys' AS tabla, count(*) AS borrados FROM deleted;

WITH updated AS (
  UPDATE license_keys
  SET status = 'expired', is_active = false
  WHERE status = 'active'
    AND expires_at IS NOT NULL
    AND expires_at < now()
  RETURNING 1
)
SELECT 'license_keys' AS tabla, count(*) AS marcadas_expiradas FROM updated;

WITH deleted AS (
  DELETE FROM activity_logs
  WHERE created_at < now() - interval '90 days'
  RETURNING 1
)
SELECT 'activity_logs' AS tabla, count(*) AS borrados FROM deleted;

COMMIT;
