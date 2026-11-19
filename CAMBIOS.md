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
