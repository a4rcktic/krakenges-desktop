# Mediciones de huella

Aquí van las evidencias del protocolo `docs/MEDICION-HUELLA.md`.

## Nombre de archivo

```
AAAA-MM-DD-<dispositivo>-<perfil>.json
AAAA-MM-DD-baseline-host.json
```

## Contenido mínimo

- Fecha y hora.
- Commit y versión de la app.
- Dispositivo y versión de Android.
- Perfil: id o nombre, SO declarado, zona horaria, idioma.
- Proxy: país y ASN, sin usuario ni contraseña.
- Salida del laboratorio (`FingerprintLab.run()`).
- Notas de browserleaks/CreepJS.
- Campos `SE ESCAPA` y `sin control`, con una frase de explicación.

## Prohibido

- Tokens, cookies, contraseñas, claves de licencia o API keys.
- Correos, nombres reales o IPs privadas sin redactar.
- Editar el JSON para que parezca coherente.
- Presentar una medición del host como si fuera una sesión de Kraken Ges.

## Estado

Todavía no hay ninguna medición. El primer archivo se creará cuando el móvil
esté conectado y se ejecute el protocolo.
