# Kraken Ges · Fingerprint Lab

Herramienta de diagnóstico, **fuera del producto**. No va en el build ni la app
la carga: sirve para responder a una pregunta que los tests no pueden.

## El problema que resuelve

Casi todo lo que se ha arreglado en la huella salió de **leer una
especificación**, no de observar un navegador. Se cambió `deviceMemory` a valores
que Chrome puede devolver porque la spec dice que se recorta a 8 GiB. Acertó,
pero por el método equivocado: no se comprobó que nada lo leyera.

Este laboratorio es el instrumento que faltaba. Mide **en vivo** qué ve un sitio
de ti, qué querías tú, y si las dos cosas coinciden.

## Los tres veredictos

Lo útil no es la lista de campos, es la diferencia entre tres estados:

| veredicto | significa |
|---|---|
| `coherente` | lo inyectas y coincide con la receta |
| `SE ESCAPA` | lo inyectas pero el valor real difiere — **esto es lo que te delata** |
| `sin control` | no lo tocas: TLS, HTTP/2, versión real del motor |

La mayoría de checklists dan una lista estática que envejece en seis meses. Esta
tabla se calcula cada vez.

## Cómo se usa

**1. Como línea base.** Abre `index.html` en Chrome normal. No hay sesión Kraken Ges,
así que la tabla sale en `observado`: son los valores reales de tu máquina.

**2. Dentro de una sesión.** Abre `index.html` en el navegador del motor, con
un perfil. Entonces `window.__krakenges` existe y la tabla compara.

**3. En el teléfono.** Lo mismo, dentro de la sesión de Android. **Esta es la
tabla que interesa**: es donde se ve qué se escapa cuando el motor es un WebView
real y no Chromium de escritorio.

La diferencia entre las tres tablas ES el informe.

## Lo que no puede medir

Desde JavaScript no se ve la capa de red. Estas señales existen, un sitio las
ve, y la tabla las lista aparte en vez de callarlas:

- **TLS / JA3 / JA4** — el servidor lo ve en el handshake. Ningún JS lo cambia.
- **HTTP/2** — SETTINGS, orden de cabeceras, prioridades. Los define el motor.
- **Versión real del motor** — un WebView no se disfraza de Chromium de escritorio.
- **IP, país, ASN** — debe concordar con timezone e idioma.
- **Resolución temporal** — canales laterales de temporizadores.

Para esas hace falta una sonda externa (un endpoint que registre el JA3 del
cliente) y comparar su resultado con lo que el perfil declara. Es el siguiente
paso, y el laboratorio no pretendetaparlo.

## El validador de CI

`validate.mjs` es la red entre el catálogo y la página. Lee el catálogo del
backend y comprueba que lo que declara sea algo que un Chrome real pueda decir:

```
node tools/fingerprint-lab/validate.mjs
```

Falla si un kit declara un `deviceMemory` fuera de la escalera válida, si la
versión de SO del token de la UA no coincide con Client Hints, si el DPR o la
pantalla no pertenecen a la familia, o si dos kits son el mismo con otro nombre.

Está en el workflow de Rust, así que un catálogo incoherente no llega a un build.