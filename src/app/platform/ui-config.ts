/* Una sola fuente para roles, secciones del menú, estados y sus colores. */
export type Role = 'student' | 'researcher' | 'coordinator';

export const ROLE_LABELS: Record<Role, string> = {
  student: 'Estudiante',
  researcher: 'Investigador',
  coordinator: 'Coordinador',
};

export interface Section { key: string; title: string; roles: Role[]; menu: boolean; }

const ALL: Role[] = ['student', 'researcher', 'coordinator'];

export const SECTIONS: Section[] = [
  { key: 'dashboard', title: 'Inicio', roles: ALL, menu: true },
  { key: 'proposals', title: 'Propuestas', roles: ALL, menu: true },
  { key: 'projects', title: 'Proyectos', roles: ALL, menu: true },
  { key: 'activities', title: 'Actividad', roles: ALL, menu: false },
  { key: 'users', title: 'Usuarios', roles: ['coordinator'], menu: true },
  { key: 'institutional', title: 'Fuentes institucionales', roles: ALL, menu: true },
  { key: 'assistant', title: 'Asistente de IA', roles: ALL, menu: true },
  { key: 'profile', title: 'Mi perfil', roles: ALL, menu: true },
];

export function sectionAllowed(key: string, role: Role): boolean {
  return SECTIONS.some(section => section.key === key && section.roles.includes(role));
}

/*
 * Colores de estado (iguales en toda la app):
 *   progress  amarillo · en proceso / en revisión
 *   changes   azul     · cambios solicitados / en cambios
 *   done      verde    · completado / aprobado
 *   cancelled rojo     · cancelado / rechazado
 */
export type Tone = 'progress' | 'changes' | 'done' | 'cancelled' | 'neutral';
export interface StatusInfo { label: string; tone: Tone; }
export type StatusKind = 'project' | 'proposal' | 'activity' | 'milestone' | 'user';

const STATUS: Record<StatusKind, Record<string, StatusInfo>> = {
  project: {
    active: { label: 'En proceso', tone: 'progress' },
    changes: { label: 'En cambios', tone: 'changes' },
    closing: { label: 'Cierre solicitado', tone: 'progress' },
    finalized: { label: 'Completado', tone: 'done' },
    cancelled: { label: 'Cancelado', tone: 'cancelled' },
  },
  proposal: {
    pending_researcher_review: { label: 'En revisión del investigador', tone: 'progress' },
    pending_coordinator: { label: 'En revisión de Coordinación', tone: 'progress' },
    changes_requested: { label: 'Cambios solicitados', tone: 'changes' },
    approved: { label: 'Aprobada', tone: 'done' },
    rejected: { label: 'Rechazada', tone: 'cancelled' },
    cancelled: { label: 'Cancelada', tone: 'cancelled' },
  },
  activity: {
    pending: { label: 'Pendiente', tone: 'progress' },
    in_review: { label: 'En revisión', tone: 'progress' },
    changes: { label: 'Cambios solicitados', tone: 'changes' },
    completed: { label: 'Completada', tone: 'done' },
    cancelled: { label: 'Cancelada', tone: 'cancelled' },
  },
  milestone: {
    pending: { label: 'Pendiente', tone: 'progress' },
    achieved: { label: 'Alcanzado', tone: 'done' },
  },
  user: {
    active: { label: 'Activo', tone: 'done' },
    inactive: { label: 'Inactivo', tone: 'cancelled' },
  },
};

export function statusInfo(kind: StatusKind, value: unknown): StatusInfo {
  return STATUS[kind][String(value ?? '')] ?? { label: String(value ?? ''), tone: 'neutral' };
}

/* Filtros de las listas (los mismos valores que manda el tablero de inicio). */
export const PROJECT_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'Todos' },
  { value: 'open', label: 'En curso' },
  { value: 'changes', label: 'En cambios' },
  { value: 'closing', label: 'Cierre solicitado' },
  { value: 'finalized', label: 'Completados' },
  { value: 'cancelled', label: 'Cancelados' },
];

export function proposalFilters(role: Role | null): { value: string; label: string }[] {
  const mine = role === 'coordinator' ? [{ value: 'pending_coordinator', label: 'Esperan mi decisión' }, { value: 'pending_researcher_review', label: 'Por revisar' }]
    : role === 'researcher' ? [{ value: 'pending_researcher_review', label: 'Por revisar' }] : [];
  return [
    { value: '', label: 'Todas' },
    ...mine,
    { value: 'in_review', label: 'En revisión' },
    { value: 'changes_requested', label: 'Cambios solicitados' },
    { value: 'approved', label: 'Aprobadas' },
    { value: 'rejected', label: 'Rechazadas' },
    { value: 'cancelled', label: 'Canceladas' },
  ];
}
