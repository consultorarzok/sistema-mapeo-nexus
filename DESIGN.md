# Sistema de Mapeo Nexus: diseño "Quebrada"

Referencia: los estratos del Cerro de los Siete Colores y la guarda de un aguayo. Uso interno de equipos de campo en Jujuy.
Versión anterior ("Carta topográfica", papel gris verdoso y tinta azul petróleo): tag git `version-carta-topografica`.

## Fondos
- `assets/strata.svg` / `assets/strata-dark.svg`: estratos inclinados en tonos minerales. Ocupan la parte de arriba de cada pestaña (`#app-shell::before`, se desvanecen hacia abajo) y toda la pantalla de ingreso.
- `assets/aguayo.svg`: guarda tejida (rombos escalonados en ciruela, ocre, rosa y salvia), como franja de 6px bajo la barra superior.

## Colores (tokens en `css/style.css`, claro / oscuro)
- `--paper` #F4F1F6 / #15111C · `--surface` #FFFFFF / #1E1828 · `--surface-2` #F7F3F8 / #251E31
- `--ink` #24192F / #EEE8F3 · `--muted` #5B5069 / #ADA3BA · `--border` #E0D7E6 / #382D46
- `--accent` ciruela #6A2C5F / #DDA3CF: pestaña activa, botones principales, foco
- Datos (iguales en los dos temas; los mapas los leen con `cssVar`): `--c-general` #1E8A4F, `--c-b` #D2423A, `--c-inst` #2F5FD0. Para texto: `--t-general`, `--t-b`, `--t-inst`

## Tipografía
- Unbounded (500 a 700): títulos, cifras grandes y el nombre "Nexus".
- Figtree (400 a 700): todo el resto de la interfaz.
- JetBrains Mono: solo los chips de código de persona.

## Reglas
- Las cifras de Inicio van en una sola lámina dividida por líneas finas, no en tarjetas sueltas.
- Radios: 14px para láminas, 10px para controles, pestañas en forma de píldora.
- Movimiento: solo transiciones de estado (150 a 250 ms). Se respeta `prefers-reduced-motion`.
- Inicio arranca directo con las cifras (el globo 3D se sacó el 18/10; queda en el historial de git).
