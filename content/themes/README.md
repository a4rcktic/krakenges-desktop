# Temas de contenido

`halloween.css` es la copia de referencia del tema publicado en
`/opt/krakenges/content/public-content.json` (`theme.css`).

La app inyecta el CSS que llega con el contenido público y lo activa cuando
`theme.id` no es `default`. No hace falta recompilar ni volver a descargar la
app: el panel **Contenido → Tema → CSS del tema** permite editar y publicar el
CSS, y la app lo recoge en la siguiente consulta (máximo cinco minutos, o al
volver a primer plano).

Reglas:

- El CSS se inyecta con `textContent`, no como HTML. No se ejecuta JavaScript.
- No se permiten fuentes ni imágenes externas obligatorias; el tema debe
  funcionar en escritorio, APK y webview sin otra descarga.
- Paleta base: noche `#07060a`, cripta `#100c16`, panel `#15101f`, naranja
  `#ff7a18`, ámbar `#f5a524`, violeta `#8b5cf6`, hueso `#f5efe6`.
- El selector raíz del tema es `html[data-theme="halloween"]`.
