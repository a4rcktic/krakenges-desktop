# Medición de huella en sesión real

Este documento es el **protocolo**, no un resultado. La huella de Kraken Ges todavía
no se ha medido en una sesión real; hasta que se ejecute esto y se guarden las
evidencias, no se puede afirmar que el producto sea indetectable.

## Qué se mide y qué no

El laboratorio (`tools/fingerprint-lab`) compara tres cosas:

| Veredicto | Significado |
|---|---|
| `coherente` | El valor observado coincide con la receta del perfil. |
| `SE ESCAPA` | El perfil pretendía un valor, pero el sitio ve otro. Es lo que delata. |
| `sin control` | No se toca desde JavaScript: TLS, HTTP/2, motor real, IP/ASN. |

Desde JavaScript **no se puede medir** TLS/JA3/JA4, la huella HTTP/2, la versión
real del motor ni la IP/ASN. Para eso hace falta una sonda externa. El informe
las lista aparte y no las cuenta como aprobadas.

## Requisitos

- Móvil con depuración USB activada y conectado.
- `adb devices -l` debe mostrar el dispositivo. Si la lista está vacía, no se
  puede medir.
- APK instalado. Anotar versión y commit exactos.
- Un perfil con proxy, zona horaria e idioma coherentes entre sí. Sin proxy, la
  IP será la de la conexión local y la coherencia geográfica no se puede juzgar.
- Un sitio donde alojar el laboratorio. El perfil puede usar proxy, así que la
  URL pública es más fiable que `http://<IP-del-portátil>:8080`. Si se sirve en
  local, hay que excluir la IP del portátil del proxy.

## Servir el laboratorio

En local:

```bash
cd tools/fingerprint-lab
python3 -m http.server 8080 --bind 0.0.0.0
```

Abrir desde el móvil `http://<IP-del-portátil>:8080/`. Si el perfil tiene proxy,
usar una URL pública temporal (por ejemplo, el mismo dominio del backend bajo
una ruta de diagnóstico) para que la petición no se pierda en el proxy.

## Procedimiento

1. **Línea base.** Abrir la misma URL en el Chrome del portátil, sin proxy.
   Pulsar `Medir ahora` y `Copiar informe`. Guardarlo como
   `docs/mediciones/AAAA-MM-DD-baseline-host.json`.
2. **Sesión real.** Abrir la URL dentro de un perfil de Kraken Ges. Pulsar
   `Medir ahora` y `Copiar informe`. Guardarlo con el nombre del perfil.
3. Repetir con **al menos tres perfiles** de familias distintas (por ejemplo
   Windows/Chrome, macOS/Chrome, Linux/Chrome). No vale medir tres veces el
   mismo perfil.
4. Anotar en cada medición:
   - versión y commit de la app;
   - modelo de móvil y versión de Android;
   - id o nombre del perfil;
   - SO declarado, zona horaria, idioma y país del proxy;
   - proxy usado (sin usuario ni contraseña).
5. **Comprobaciones externas.** Abrir en la misma sesión:
   - `https://browserleaks.com/ip` para IP, país y ASN;
   - `https://abrahamjuliot.github.io/creepjs/` para señales de coherencia;
   - `https://browserleaks.com/canvas` para confirmar el hash de canvas.
   Guardar capturas o el texto relevante. No pegar cookies, tokens ni
   credenciales.
6. **Comparar.** La diferencia entre la tabla del host, la del perfil de
   escritorio y la del móvil es el informe. No se compara contra una lista
   estática.

## Criterios de aceptación

- Todos los campos controlados deben salir `coherente`.
- Cualquier `SE ESCAPA` es un fallo: se abre una incidencia con el campo, el
  valor observado, el valor pretendido, el perfil y el commit.
- Los campos `sin control` se documentan como limitación, no como éxito.
- En móvil, las señales de WebView (`window.wv`, `$cdc_`, `Capacitor`, `wv` en
  el User-Agent) son propiedades del contenedor. Retocar el UA no las elimina.
  Si aparecen, el producto móvil no se puede vender como un Chrome de
  escritorio indetectable; se vende por lo que sí hace.
- Si no hay medición, el estado es **no medido**. No se escribe "huella
  validada" en documentación, web ni propuesta comercial.

## Evidencias

- Guardar los JSON en `docs/mediciones/`, sin secretos.
- No editar el JSON a mano.
- Un informe sin fecha, dispositivo, perfil y commit no sirve como evidencia.
- Si se comparte con un cliente, revisar antes que no haya IPs privadas,
  correos, tokens ni datos personales.

## Estado actual

- Móvil `R58R40LKQSM` desconectado (`adb: no devices/emulators found`).
- Medición real: **pendiente**.
- Por tanto, la afirmación de indetectabilidad: **no verificada**.
