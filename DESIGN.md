# Sistema de Mapeo Nexus: diseño "Retícula"

Cartografía digital universal y tecnológica. Versiones anteriores en tags de git: `version-quebrada` (ciruela/Jujuy), `version-carta-topografica` (azul petróleo), `backup-pre-diseno-20261018` (original con globo).

## Fondos y movimiento
- `assets/reticula.svg` / `assets/reticula-dark.svg`: meridianos y paralelos de un globo en proyección ortográfica, 16 nodos que laten y 10 rutas (arcos de círculo máximo) que se dibujan en secuencia. La animación vive dentro del SVG y se apaga con `prefers-reduced-motion`.
- Arriba de cada pestaña (`#app-shell::before`, se desvanece hacia abajo; al 50% en celular) y a pantalla completa en el ingreso.
- Malla de puntos de 22px en todo el fondo de la aplicación.
- Ingreso: barrido de radar (haz cónico con anillos) que gira detrás del formulario, cada 7 s.
- Barra superior: una señal aguamarina recorre el borde inferior cada 6 s.

## Colores (tokens en `css/style.css`, claro / oscuro)
- `--paper` #F3F5FB / #0A0F24 · `--surface` #FFFFFF / #111936 · `--ink` #10152E / #E8EBFA · `--muted` #4F5775 / #A3AACB
- `--accent` violeta eléctrico #5B3DF5 / #9C90FF: pestaña activa, botones, foco
- `--signal` aguamarina #13B9A6 / #2EE6C8: rutas, radar, indicador de datos en vivo
- Datos (iguales en ambos temas; los mapas los leen con `cssVar`): `--c-general` #1E8A4F, `--c-b` #D2423A, `--c-inst` #2F6FE0

## Tipografía
- Sora (500 a 700): títulos, cifras y "Nexus". IBM Plex Sans: interfaz. IBM Plex Mono: chips de código.

## Reglas
- Cifras de Inicio en una sola lámina dividida por líneas finas. Radios 14px láminas / 10px controles; pestañas en píldora.
- Movimiento solo en el fondo, el radar y la señal de la barra; los controles usan transiciones de estado de 150 a 250 ms.
