# Sistema de Mapeo Nexus — diseño "Carta topográfica"

Referencia: cartas del Instituto Geográfico. Papel gris verdoso frío, tinta azul petróleo y curvas de nivel (`assets/contours.svg`) como único ornamento, solo en el login.

## Colores (tokens en `css/style.css`, claro / oscuro)
- `--paper` #E6EBE7 / #0C191D: fondo
- `--surface` #F8FAF8 / #12232A: láminas (tablas, fichas, tarjetas)
- `--ink` #10242B / #E3ECE8: texto · `--muted` #475B61 / #9AAEB0
- `--accent` #0D5A6E / #62B7CD: acciones, pestaña activa, foco
- Datos (iguales en los dos temas, los mapas los leen con `cssVar`): `--c-general` #1E8A4F, `--c-b` #D2423A, `--c-inst` #2F5FD0
- Texto en color de datos: `--t-general`, `--t-b`, `--t-inst` (más claros en oscuro, por contraste)

## Tipografía
- Archivo (variable, de Google Fonts) para todo. Títulos con `font-stretch:112%` y peso 700; cifras con números tabulares.
- JetBrains Mono solo para los chips de código de persona.
- Rótulos en minúscula normal, sin mayúsculas espaciadas ni rótulos encima de los títulos.

## Reglas
- Las cifras van en una sola lámina dividida por líneas finas (como el recuadro de referencias de un mapa), no en tarjetas sueltas iguales.
- Radios: 10px para láminas, 6px para controles. Sombra suave con desplazamiento.
- Movimiento: solo transiciones de estado (150 a 250 ms). Se respeta `prefers-reduced-motion`.
- Inicio arranca directo con las cifras (el globo 3D se sacó el 18/10 a pedido de Zeta; queda en el historial de git).
