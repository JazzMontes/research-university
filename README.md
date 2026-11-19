# Research University

Plataforma de investigación universitaria (Ionic/Angular + Supabase), publicada en GitHub Pages.

## Actualización automática (GitHub + Supabase)

Cada `git push` a `main` o `master` actualiza solo lo que cambiaste:

| Cambias…                          | Se ejecuta                       | Resultado                                   |
|-----------------------------------|----------------------------------|---------------------------------------------|
| `src/**` y demás código de la app   | Publicar en GitHub Pages         | Nueva versión de la página (1–3 min)        |
| `supabase/01..07_*.sql`           | Actualizar base de datos         | Tablas/funciones al día en Supabase, sin borrar datos |
| `supabase/functions/**`           | Desplegar asistente de IA        | Función Edge actualizada                    |

Configuración única en el repositorio (Settings → Secrets and variables → Actions):

- **Variables**: `SUPABASE_URL` (`https://xxxx.supabase.co`) y `SUPABASE_KEY` (clave **pública** publishable/anon). Si no existen, se usan los valores de `src/environments/environment.prod.ts`.
- **Secretos**: `SUPABASE_DB_URL` = cadena del **Session pooler** (Supabase → Connect → Session pooler, con tu contraseña de base). Para el asistente: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `AI_API_KEY`.
- **Pages**: Settings → Pages → Source: **GitHub Actions**.

Usar el mismo proyecto de Supabase que otra app es posible: todo vive en el esquema `research` y la única función pública es `public.research_api`. Nota: el instalador sube el `statement_timeout` de los roles `anon` y `authenticated` a 30 s, lo que también aplica a la otra app.

Para cambiar la base, edita los archivos numerados `supabase/01..07`, no `instalar_todo.sql` (ese queda solo para instalar a mano). Regenéralo con `node supabase/generar-instalar-todo.mjs`. Nunca pongas en esos archivos un `drop table` o `delete`: se ejecutan en cada cambio. `datos_demo.sql` no se ejecuta automáticamente.

Esta entrega parte del backend y del src proporcionados y de la versión final de requisitos y reglas de negocio del 29 de septiembre de 2026. Conserva la interfaz verde y los cuatro roles. Sustituye los registros de demostración por consultas y operaciones reales.

## Estructura

```
.github/workflows/   publicación automática (Pages, base de datos, asistente, mantener activo)
herramientas/        versión anterior PHP/MySQL (XAMPP), requisitos y validación; la app no la usa
public/              archivos estáticos que se copian tal cual
scripts/             configurar-supabase.mjs (lo usa GitHub Actions al compilar)
src/                 código de la app Ionic/Angular
supabase/            base de datos (01..07 + instalar_todo.sql) y función "asistente"
www/                 compilación (se genera; no se sube a Git)
```

## Trabajar en tu computadora

```powershell
cd research-university
npm ci
npm start
```

Abre `http://localhost:8100`. Con `supabaseUrl` y `supabaseKey` escritos en `src/environments/` usa la misma base de Supabase que la página publicada. Para compilar: `npm run build` (queda en `www/browser`).

El modo XAMPP (PHP + MySQL) sigue disponible en `herramientas/legado-xampp`; ver su `LEEME.md`.

## Recorrido para comprobar el sistema

1. Estudiante: crea una propuesta y selecciona investigador. Investigador: solicita cambios con observaciones. Estudiante: guarda correcciones y reenvía. Investigador: aprueba la revisión preliminar.
2. Coordinador: abre la propuesta y asigna evaluador. Evaluador: entra en Evaluaciones, abre la propuesta y emite decisión con observaciones. Si aprueba, el proyecto se crea automáticamente, con el investigador responsable y el autor como participantes.
3. Investigador responsable: selecciona el proyecto en Participantes y agrega integrantes. En Actividades crea tareas con responsable y fecha. El participante inicia y envía a revisión; la evidencia es opcional. Solo el responsable del proyecto acepta el trabajo o pide correcciones.
4. Investigador: crea hitos seleccionando actividades. Se pueden alcanzar cuando todas sus actividades estén aceptadas. El avance cuenta únicamente actividades completadas.
5. Participantes: suben documentos y nuevas versiones. El investigador responsable puede bloquear eliminación a estudiantes o restringir la consulta a investigadores participantes. Versiones anteriores permanecen descargables.
6. Investigador: genera reporte de su proyecto. Coordinación: genera reportes individuales o generales. JSON descarga directamente; la opción PDF abre una vista imprimible: usa **Imprimir / Guardar como PDF**.
7. Investigador responsable: solicita cierre. Coordinación lo devuelve con pendientes o aprueba. Un proyecto finalizado permite consulta, pero rechaza modificaciones de equipo, actividades, hitos y archivos.

Los enlaces de las pestañas del proyecto conservan el proyecto seleccionado. Para retirar un participante con pendientes, el campo de reasignaciones recibe un objeto JSON: `{"12": 7, "13": 9}` significa actividad 12 al usuario 7 y actividad 13 al usuario 9. Ambos usuarios deben ser participantes activos. Si quedan tareas sin reasignar, se rechaza toda la operación.

## Activar el asistente

La función Edge `supabase/functions/asistente` usa la clave `AI_API_KEY` guardada en Supabase (Gemini, OpenAI, Groq u OpenRouter). Se despliega sola con el workflow "Desplegar asistente" al cambiar esa carpeta, si existen los secretos `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` y `AI_API_KEY`. Si falta la clave, el asistente avisa sin afectar los demás módulos.

Requisitos y validación detallados: `herramientas/REQUISITOS.md` y `herramientas/VALIDACION.md`.
