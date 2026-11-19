# Versión anterior (XAMPP: PHP + MySQL)

Esta carpeta conserva el backend PHP y los scripts de MySQL de la primera versión, solo como referencia.
**La app ya no los usa**: desde la versión 2 todo el backend vive en Supabase (`../../supabase/`), para que la
plataforma funcione en GitHub Pages sin tener la computadora encendida.

Si en algún momento necesitas pasar datos de MySQL a Supabase, exporta las tablas de `university_research_platform`
(schema.sql) y adáptalas al esquema `research` de `../../supabase/01_esquema.sql` (mismos nombres de tablas y columnas).
Las contraseñas de PHP (`$2y$…`) son compatibles: la base de Supabase las acepta tal cual.

## Uso local con XAMPP (opcional)

Copia esta carpeta `legado-xampp` a `htdocs` y renombra la copia como `research-university`, así el backend queda en
`http://localhost/research-university/backend`, que es la dirección que usa la app en modo PHP. Este modo solo se
activa si dejas vacíos `supabaseUrl` y `supabaseKey` en `src/environments/`. Los scripts
`tools/install-database.php` y `tests/integration.py` están aquí también.
