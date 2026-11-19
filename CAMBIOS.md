# URPMP · Versión 3 (sin evaluador)

## Cómo actualizar
1. Supabase → SQL Editor → pega **todo** `supabase/instalar_todo.sql` → Run. No borra datos y convierte lo que ya existe.
2. Reemplaza la carpeta `src/` y publica como siempre.

> Las cuentas que eran **evaluador** quedan como **investigador inactivo**. Coordinación decide si las reactiva (Usuarios → Editar).

## Flujo nuevo

**Propuesta**
Estudiante registra → Investigador responsable revisa → Coordinación decide → **se crea el proyecto**.
(Si la registra un investigador, va directo a Coordinación.)

En cada revisión hay 3 opciones: Aprobar · Solicitar cambios · Rechazar.
Con "Cambios solicitados" el autor **corrige y reenvía en un solo paso** y la propuesta regresa a quien pidió los cambios.

**Proyecto** (todo se hace desde su detalle: Resumen, Equipo, Actividades, Hitos, Documentos, Historial)
En proceso → Solicitar cierre → Coordinación aprueba (**Completado**) o pide cambios (**En cambios**, se corrige y se vuelve a solicitar).

**Actividad**
Pendiente → Entregar → En revisión → Aceptar (**Completada**) o Pedir cambios (**Cambios solicitados**) → Entregar…

## Colores de estado (iguales en toda la app)
| Color | Significa | Ejemplos |
|---|---|---|
| Amarillo | En proceso | Proyecto en proceso, cierre solicitado, propuesta en revisión, actividad pendiente / en revisión |
| Azul | En cambios | Proyecto en cambios, propuesta o actividad con cambios solicitados |
| Verde | Completado | Proyecto completado, propuesta aprobada, actividad completada, hito alcanzado |
| Rojo | Cancelado | Proyecto o propuesta cancelados, propuesta rechazada, actividad cancelada |

## Qué se quitó (caminos de más)
- Rol **Evaluador**, sección **Evaluaciones** y "Asignar evaluador".
- "Guardar correcciones" + "Reenviar" → ahora es un solo botón **Corregir y reenviar**.
- "Archivar / desarchivar" → ahora es **Cancelar / Reactivar**.
- "Comenzar actividad" (paso sin valor) y "Reasignar actividad" (ya está en Editar).
- "Marcar hito como alcanzado": el hito se alcanza **solo** al completarse sus actividades.
- Secciones sueltas **Participantes, Actividades, Hitos, Documentos, Seguimiento, Reportes y Cierre**: ahora son pestañas y botones dentro del proyecto.
- "Bloquear documento": ahora solo quien lo subió o el responsable lo pueden eliminar.
- En Usuarios, "Editar datos", "Cambiar rol" y "Cambiar estado" → un solo **Editar**.
- "Accesos rápidos" del inicio (repetía el menú) → el inicio muestra **lo que tienes que hacer**.

## Errores humanos cubiertos
| Situación | Qué hace el sistema |
|---|---|
| Cancelar un proyecto | Solo Coordinación, desde el proyecto, con motivo obligatorio. Queda en solo lectura y se puede **reabrir**. |
| Cerrar un proyecto por error | Coordinación lo **reabre**. |
| Solicitar cierre con trabajo pendiente | Se bloquea y lleva a la pestaña Actividades. |
| Retirar a un integrante | Confirmación; sus actividades abiertas pasan a quien elijas (por defecto, el responsable). Se puede **reincorporar**. |
| Retirar al investigador responsable | Bloqueado: primero Coordinación cambia el responsable (el anterior sigue en el equipo). |
| Desactivar o cambiar de rol a alguien con trabajo | Bloqueado con un mensaje que dice exactamente qué pasar a otra persona. |
| Cancelar una propuesta por error | **Reactivar** la regresa al mismo punto. |
| El estudiante eligió mal al investigador | Lo corrige al "Corregir y reenviar"; el nuevo investigador la revisa. |
| Aceptar una actividad por error | **Reabrir (pedir cambios)**. |
| Actividad creada por error | **Cancelar actividad** (deja de contar en el avance). |
| Evidencia equivocada | Quien la adjuntó la puede **quitar** mientras no se acepte. |
| Entregar sin evidencias | Aviso antes de confirmar. |
| Fecha límite en el pasado / término antes del inicio | Se rechaza. |
| Agregar dos veces a la misma persona / usuario o correo repetido | Se rechaza con mensaje claro. |
| Contraseña mal escrita | Botón de **ojo** para verla, y aviso en vivo de si cumple las reglas. |
| Archivo de más de 5 MB | Se avisa al elegirlo, antes de subir. |
| Cerrar el formulario sin querer | Ya no se cierra al hacer clic fuera; solo con "Volver" o ×. |
| Acciones irreversibles | Diálogo rojo que explica qué pasará y, cuando aplica, pide motivo. |

## Asistente de IA (ChatGPT o Gemini)
- La app ahora sí llama a la función `asistente` (antes siempre respondía en modo local, sin IA). Si la función no está publicada o falla, responde con el modo local.
- Responde tres tipos de preguntas:
  1. **Tus proyectos y documentos**: solo con lo que tu rol puede ver, citando la fuente ([1], [P3]).
  2. **Cómo usar la plataforma**: trae una guía del flujo v3 (cancelar, retirar integrantes, cierre, etc.).
  3. **Dudas generales** (metodología, objetivos, APA, estadística, conceptos): con conocimiento general, marcado con una nota. Nunca inventa datos de tus proyectos.
- Recuerda la conversación (últimos 6 mensajes).

### Cambiar a ChatGPT
1. En https://platform.openai.com → API keys → crea una clave (`sk-…`). La API se paga aparte de ChatGPT Plus: agrega saldo en Billing.
2. Supabase → Edge Functions → Secrets:
   - `AI_API_KEY` = tu clave `sk-…` (reemplaza la de Gemini).
   - Si existe `AI_PROVIDER=gemini`, bórralo o ponlo en `openai`.
   - Opcional: `AI_MODEL` (por defecto prueba `gpt-5-mini`, luego `gpt-4.1-mini` y `gpt-4o-mini`).
   - Opcional: `AI_GENERAL=no` si quieres que solo responda sobre la plataforma.
3. Vuelve a publicar la función: `supabase functions deploy asistente --no-verify-jwt` (o pega `supabase/functions/asistente/index.ts` en el editor de la función y Deploy).
4. Publica la app.

### Gemini (configuración actual)
- Funciona con las claves nuevas de Google AI Studio (`AQ.…`) y con las antiguas (`AIza…`). Se usa la API nativa de Gemini, porque las claves `AQ.` no funcionan en la ruta compatible con OpenAI.
- Solo necesitas el secreto `AI_API_KEY` con tu clave. Modelos que prueba en orden: `gemini-2.5-flash`, `gemini-flash-latest`, `gemini-2.5-flash-lite` (o fija uno con `AI_MODEL`).

## Versión 3.10: chat, perfil y contraseñas
- **Asistente:** el chat tiene altura fija (solo se desplazan los mensajes), sin el selector de "Preguntar/Resumir…", con botón para adjuntar archivos (PDF, Word, Excel, imagen o texto, hasta 5 MB), historial de chats oculto que se abre con "☰ Historial", "Nuevo chat" y eliminar chat con confirmación. Al recargar se recupera el chat del día. Tus mensajes van en verde oscuro y los de la IA en blanco. El texto entre «» se muestra en ***negrita y cursiva*** y sin los símbolos.
- **Mi perfil:** foto, nombre, correo y "Cambiar mi contraseña". Se entra desde el menú o tocando tu nombre arriba a la derecha.
- **Contraseña temporal:** la que pone Coordinación al crear la cuenta o al restablecerla obliga a crear una propia al entrar.
- **¿Olvidaste tu contraseña?:** en el acceso; llega un código de 6 números al correo de la cuenta (vence en 15 minutos).

### Configurar el correo de recuperación (Brevo, gratis 300 correos al día)
1. Crea una cuenta en https://www.brevo.com
2. **Senders, Domains & Dedicated IPs → Senders → Add a sender**: agrega tu correo (por ejemplo tu Gmail) y confírmalo desde el correo que te llega.
3. **SMTP & API → API Keys → Generate a new API key** y cópiala.
4. Supabase → Edge Functions → Secrets, agrega:
   - `BREVO_API_KEY` = la clave de Brevo
   - `MAIL_FROM` = el correo que verificaste en el paso 2
   - `MAIL_FROM_NAME` (opcional) = Research University
5. Vuelve a publicar la función `asistente` con el `index.ts` nuevo.

## Versión 3.11
- **Inicio con gráficas:** donas de proyectos, propuestas y actividades por estado; avance de cada proyecto en curso; propuestas y proyectos de los últimos 6 meses; mis actividades, entregas por revisar y próximas fechas.
- **Buscadores en vivo:** las propuestas se filtran mientras escribes (también proyectos, usuarios, y actividades/documentos dentro del proyecto).
- **Listas con desplazamiento:** las listas largas quedan dentro de su cuadro.
- **Campanita de notificaciones** junto a tu nombre: revisiones, entregas, tareas asignadas, fechas límite (avisa 2 días antes y si se retrasa), cierres, cambios de investigador, documentos nuevos.
- **Coordinación como investigadora:** puede registrar propuestas (con justificación obligatoria) que se vuelven proyecto al instante, y ser investigadora responsable. Solo administra sus propios proyectos; en los demás sigue supervisando.
- **Coordinación cambia al investigador responsable** de propuestas (y de proyectos, como antes).
- **Solicitud de cambio de investigador:** el estudiante la pide con un motivo desde su propuesta o proyecto; Coordinación la aprueba (eligiendo al nuevo) o la rechaza.
- **Archivo opcional en propuestas** al crearlas o corregirlas; al aprobarse pasa a Documentos del proyecto.
- **Eliminar usuarios definitivamente** (con confirmación escribiendo ELIMINAR). Si la persona tenía historial, queda como «Usuario eliminado».
- **Cancelar propuesta** ahora es un botón visible en el detalle de la propuesta.
