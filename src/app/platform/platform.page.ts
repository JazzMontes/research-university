/*
 * Plataforma URPMP (versión 3, sin evaluador).
 * Secciones: Inicio · Propuestas · Proyectos (el proyecto concentra equipo, actividades,
 * hitos, documentos, cierre y reporte) · Usuarios · Fuentes institucionales · Asistente.
 * Todas las acciones pasan por un único diálogo que valida, confirma lo irreversible
 * y explica qué va a pasar antes de guardar.
 */
import { ChangeDetectorRef, Component, ElementRef, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { IonicModule } from '@ionic/angular';
import {
  PROJECT_FILTERS, ROLE_LABELS, Role, SECTIONS, Section, StatusKind, StatusInfo, proposalFilters, statusInfo,
} from './ui-config';
import { ApiService } from '../services/api.service';
import { BackendService } from '../services/backend.service';
import { extractOfficeText } from '../services/file-text';
import { IconComponent } from './icon.component';
import { downloadReportPdf } from '../services/pdf-report';
import { AuthService } from '../auth/auth.service';
import { AppNotification, NotificationsService } from '../services/notifications.service';

// Los datos llegan como JSON del servidor; se tratan como objetos libres para leerlos igual en código y plantilla.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;
interface Option { value: string; label: string; }

export type FieldType = 'text' | 'textarea' | 'date' | 'email' | 'password' | 'select' | 'choice' | 'checks' | 'file';
export interface DialogField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** Obligatorio solo en ciertos casos (p. ej. observaciones al pedir cambios). */
  requiredWhen?: (values: Row) => boolean;
  options?: Option[];
  hint?: string;
  /** Texto gris dentro de la caja que desaparece al escribir. */
  placeholder?: string;
  min?: string;
}
export interface Dialog {
  title: string;
  intro?: string;
  /** Texto en rojo que explica lo que no se puede deshacer fácilmente. */
  warning?: string;
  danger?: boolean;
  confirmLabel: string;
  fields: DialogField[];
  values: Row;
  /** Devuelve el mensaje de éxito que se muestra al cerrar. */
  submit: (values: Row, file?: File) => Promise<string>;
}

interface ChatMessage { author: string; text: string; html?: string; pending?: boolean; attachment?: string; }
interface FilePreview { name: string; size: string; ext: string; kind: 'image' | 'pdf' | 'text' | 'other'; url?: SafeResourceUrl; src?: string; text?: string; }
interface ChatAttachment { name: string; mime: string; size: number; data?: string; text?: string; }

const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,72}$/;

@Component({
  selector: 'app-platform',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, IonicModule, IconComponent],
  templateUrl: './platform.page.html',
  styleUrls: ['./platform.page.scss'],
})
export class PlatformPage implements OnInit {
  // ---------- sesión y navegación ----------
  section = 'dashboard';
  recordId = 0;
  menuOpen = false;
  loading = false;
  loadError = '';
  notice = '';
  noticeTone: 'ok' | 'error' = 'ok';
  private revision = 0;
  private entered = false;

  username = '';
  password = '';
  showLoginPassword = false;
  loginBusy = false;
  loginError = '';
  logoutBusy = false;

  // ---------- datos por sección ----------
  dash: Row = {};
  proposals: Row[] = [];
  proposalTotal = 0;
  page = 1;
  search = '';
  filter = '';
  proposal?: Row;
  proposalHistory: Row[] = [];

  projects: Row[] = [];
  project?: Row;
  tab = 'Resumen';
  // Hitos y actividades van juntos en la pestaña Actividades (plan de trabajo).
  readonly tabs = ['Resumen', 'Equipo', 'Actividades', 'Documentos', 'Historial'];
  activities: Row[] = [];
  milestones: Row[] = [];
  documents: Row[] = [];
  history: Row[] = [];
  versionsOf = 0;
  versions: Row[] = [];

  activity?: Row;
  evidence: Row[] = [];

  users: Row[] = [];
  userFilter = 'active';
  sources: Row[] = [];

  question = '';
  messages: ChatMessage[] = [];
  asking = false;
  /** Chat abierto (0 = chat nuevo sin guardar). */
  chatId = 0;
  chats: Row[] = [];
  historyOpen = false;
  attachment?: ChatAttachment;
  attachBusy = false;
  @ViewChild('chatScroll') chatScroll?: ElementRef<HTMLElement>;

  // ---------- buscadores y campanita ----------
  activityFilter = '';
  documentFilter = '';
  notifOpen = false;
  private searchTimer?: ReturnType<typeof setTimeout>;

  // ---------- Mi perfil ----------
  profileName = '';
  profileEmail = '';
  profileAvatar = '';
  profileSaving = false;

  // ---------- primer inicio (contraseña temporal) ----------
  firstPassword = { current: '', next: '', confirm: '' };
  firstShown: Record<string, boolean> = {};
  firstBusy = false;
  firstError = '';

  // ---------- recuperar contraseña desde el acceso ----------
  loginMode: 'login' | 'forgot' | 'code' = 'login';
  recoverId = '';
  recoverCode = '';
  recoverPassword = '';
  showRecoverPassword = false;
  recoverBusy = false;
  recoverInfo = '';
  loginInfo = '';

  // ---------- diálogo único ----------
  dialog?: Dialog;
  dialogError = '';
  dialogFile?: File;
  saving = false;
  shown: Record<string, boolean> = {};

  readonly projectFilters = PROJECT_FILTERS;
  readonly todayIso = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  constructor(private route: ActivatedRoute, private router: Router, public auth: AuthService, private sanitizer: DomSanitizer,
    private api: ApiService, private backend: BackendService, private changeDetector: ChangeDetectorRef,
    public notifications: NotificationsService) {}

  // =====================================================================
  // Datos de la sesión
  // =====================================================================
  get me(): number { return this.auth.user()?.id ?? 0; }
  get role(): Role | null { return this.auth.user()?.role ?? null; }
  get userName(): string { return this.auth.user()?.name || ''; }
  get firstName(): string { return this.userName.trim().split(/\s+/)[0] || ''; }
  get initials(): string { return this.userName.trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase(); }
  get roleLabel(): string { return this.role ? ROLE_LABELS[this.role] : ''; }
  get today(): string { return new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' }); }
  get menu(): Section[] { return SECTIONS.filter(item => item.menu && this.role !== null && item.roles.includes(this.role)); }
  get sectionTitle(): string { return SECTIONS.find(item => item.key === this.section)?.title || 'Inicio'; }
  get proposalFilterList(): Option[] { return proposalFilters(this.role); }

  status(kind: StatusKind, value: unknown): StatusInfo { return statusInfo(kind, value); }
  tabIcon(tab: string): string {
    return ({ Resumen: 'info', Equipo: 'users', Actividades: 'tasks', Hitos: 'flag', Documentos: 'file', Historial: 'clock' } as Record<string, string>)[tab] || 'info';
  }
  statIcon(label: string): string { return /completad/i.test(label) ? 'check' : /propuesta/i.test(label) ? 'proposal' : 'folder'; }
  roleName(role: unknown): string { return ROLE_LABELS[role as Role] || String(role ?? ''); }
  date(value: unknown): string {
    if (!value) return 'Sin definir';
    const text = String(value);
    const parsed = new Date(text.length === 10 ? text + 'T12:00:00' : text);
    return isNaN(parsed.getTime()) ? text : parsed.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  percent(item?: Row): number {
    const total = Number(item?.['total_activities'] || 0);
    return total ? Math.round(100 * Number(item?.['completed_activities'] || 0) / total) : 0;
  }
  deadlineTone(label: unknown): string { return label === 'Retrasada' ? 'cancelled' : label === 'Próxima a vencer' ? 'progress' : 'neutral'; }

  // =====================================================================
  // Ciclo de vida
  // =====================================================================
  ngOnInit(): void {
    this.route.paramMap.subscribe(params => {
      const query = this.route.snapshot.queryParamMap;
      this.section = this.route.snapshot.routeConfig?.path === 'login' ? 'login' : (params.get('section') || 'dashboard');
      this.recordId = Number(params.get('id')) || 0;
      this.readQuery();
      this.search = '';
      this.page = 1;
      this.menuOpen = false;
      this.dialog = undefined;
      this.clearData();
      this.notice = query.get('denied') === '1' ? 'Tu rol no tiene acceso a esa sección.' : '';
      this.noticeTone = this.notice ? 'error' : 'ok';
      if (this.section === 'login') { this.password = ''; void this.skipLoginIfActive(); }
      else void this.load();
    });
  }

  // Ionic conserva las páginas visitadas: al volver a una se recargan sus datos.
  ionViewWillEnter(): void {
    if (this.entered && this.section !== 'login') { this.readQuery(); void this.load(true); }
    this.entered = true;
  }

  /** Filtro (?status=) y pestaña (?tab=) vienen en la dirección para que los enlaces del inicio abran la vista exacta. */
  private readQuery(): void {
    const query = this.route.snapshot.queryParamMap;
    this.filter = query.get('status') || '';
    const tab = query.get('tab') || '';
    this.tab = this.tabs.includes(tab) ? tab : 'Resumen';
  }

  private clearData(): void {
    ++this.revision;
    this.loading = false;
    this.loadError = '';
    this.proposal = undefined; this.proposalHistory = [];
    this.project = undefined; this.activities = []; this.milestones = []; this.documents = []; this.history = [];
    this.versionsOf = 0; this.versions = [];
    this.activity = undefined; this.evidence = [];
    this.activityFilter = ''; this.documentFilter = ''; this.notifOpen = false;
  }

  private async skipLoginIfActive(): Promise<void> {
    try {
      if (this.backend.mode === 'supabase' && !this.backend.token) return;
      if (await this.auth.checkSession()) await this.router.navigate(['/app/dashboard'], { replaceUrl: true });
    } catch { /* Se queda en el acceso. */ }
  }

  /** Carga la sección actual. soft = sin mostrar "Cargando" (después de guardar). */
  async load(soft = false): Promise<void> {
    if (this.auth.user() && !this.auth.user()!.must_change_password) this.notifications.start();
    const revision = ++this.revision;
    const fresh = () => revision === this.revision;
    if (!soft) this.loading = true;
    this.loadError = '';
    try {
      switch (this.section) {
        case 'dashboard': {
          const result = await this.api.request<Row>('dashboard/summary.php');
          if (fresh()) this.dash = result;
          break;
        }
        case 'proposals':
          if (this.recordId) {
            const [detail, history] = await Promise.all([
              this.api.request<Row>('proposals/detail.php', { proposal_id: this.recordId }),
              this.api.request<Row>('proposals/history.php', { proposal_id: this.recordId }),
            ]);
            if (fresh()) { this.proposal = detail['proposal']; this.proposalHistory = history['items']; }
          } else {
            const result = await this.api.request<Row>('proposals/list.php', {
              page: this.page, limit: 20, search: this.search.trim(), status: this.filter });
            if (fresh()) { this.proposals = result['items']; this.proposalTotal = result['total']; }
          }
          break;
        case 'projects':
          if (this.recordId) await this.loadProject(this.recordId, fresh);
          else {
            const result = await this.api.request<Row>('projects/list.php');
            if (fresh()) this.projects = result['items'];
          }
          break;
        case 'activities': {
          const result = await this.api.request<Row>('activities/detail.php', { activity_id: this.recordId });
          const item = result['item'];
          const files = await this.api.request<Row>('evidence/list.php', { project_id: item['project_id'], activity_id: item['id'] });
          if (fresh()) { this.activity = item; this.evidence = files['items']; }
          break;
        }
        case 'users': {
          const result = await this.api.request<Row>('users/list.php');
          if (fresh()) this.users = result['items'];
          break;
        }
        case 'assistant':
          // Despierta la función de IA mientras la persona escribe su pregunta.
          void this.backend.callFunction('asistente', { ping: true }, 15000);
          await this.loadChats();
          // Al recargar se recupera el chat del día; con "Nuevo chat" se empieza de cero.
          if (fresh() && !this.messages.length) {
            const saved = this.savedChat();
            if (saved && this.chats.some(c => Number(c['id']) === saved)) await this.openChat(saved, false);
          }
          break;
        case 'profile': {
          const user = this.auth.user();
          this.profileName = user?.name || '';
          this.profileEmail = user?.email || '';
          this.profileAvatar = user?.avatar || '';
          break;
        }
        case 'institutional': {
          const result = await this.api.request<Row>('institutional-documents/list.php');
          if (fresh()) this.sources = result['items'];
          break;
        }
      }
    } catch (error) {
      if (fresh()) this.loadError = this.message(error, 'No se pudo cargar la información.');
    } finally {
      if (fresh()) { this.loading = false; this.changeDetector.markForCheck(); }
    }
  }

  private async loadProject(id: number, fresh: () => boolean): Promise<void> {
    const [detail, activities, milestones, documents] = await Promise.all([
      this.api.request<Row>('projects/detail.php', { project_id: id }),
      this.api.request<Row>('activities/list.php', { project_id: id }),
      this.api.request<Row>('milestones/list.php', { project_id: id }),
      this.api.request<Row>('documents/list.php', { project_id: id }),
    ]);
    if (!fresh()) return;
    this.project = detail['item'];
    this.activities = activities['items'];
    this.milestones = milestones['items'];
    this.documents = documents['items'];
    if (this.tab === 'Historial') await this.loadHistory();
    if (this.versionsOf) await this.showVersions(this.versionsOf, true);
  }

  private message(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }
  private say(text: string, tone: 'ok' | 'error' = 'ok'): void { this.notice = text; this.noticeTone = tone; this.changeDetector.markForCheck(); }

  // =====================================================================
  // Acceso
  // =====================================================================
  async login(): Promise<void> {
    if (this.loginBusy) return;
    this.loginError = '';
    this.loginInfo = '';
    this.auth.sessionMessage = '';
    if (!this.username.trim() || !this.password) { this.loginError = 'Escribe tu usuario y contraseña.'; return; }
    this.loginBusy = true;
    try {
      await this.auth.login(this.username, this.password);
      this.password = '';
      this.showLoginPassword = false;
      const destination = this.route.snapshot.queryParamMap.get('returnUrl');
      const safeUrl = destination && /^\/app\/[a-z-]+(?:\/\d+)?(?:\?[\w=&%-]*)?$/.test(destination) ? destination : '/app/dashboard';
      await this.router.navigateByUrl(safeUrl, { replaceUrl: true });
    } catch (error) {
      this.password = '';
      this.loginError = this.message(error, 'No se pudo iniciar sesión.');
    } finally {
      this.loginBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  async logout(): Promise<void> {
    if (this.logoutBusy) return;
    if (this.dialog && !confirm('Tienes un formulario abierto. ¿Cerrar sesión de todos modos?')) return;
    this.logoutBusy = true;
    try {
      await this.auth.logout();
      this.notifications.stop();
      this.password = ''; this.username = ''; this.messages = []; this.dialog = undefined;
      await this.router.navigate(['/login'], { replaceUrl: true });
    } catch (error) {
      this.say(this.message(error, 'No se pudo cerrar sesión. Inténtalo de nuevo.'), 'error');
    } finally {
      this.logoutBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  // =====================================================================
  // Filtros y navegación dentro de una sección
  // =====================================================================
  setProposalFilter(value: string): void { this.filter = value; this.page = 1; void this.load(); }
  searchProposals(): void { this.page = 1; void this.load(); }
  /** Busca mientras escribes (espera un instante para no consultar con cada tecla). */
  liveSearchProposals(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => { this.page = 1; void this.load(true); }, 250);
  }
  private matches(text: string, term: string): boolean {
    const norm = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
    return norm(text).includes(norm(term.trim()));
  }
  get visibleActivities(): Row[] {
    return this.activityFilter.trim() ? this.activities.filter(a => this.matches(`${a['description']} ${a['participant_name']}`, this.activityFilter)) : this.activities;
  }
  get visibleDocuments(): Row[] {
    return this.documentFilter.trim() ? this.documents.filter(d => this.matches(`${d['title']} ${d['filename'] || ''} ${d['uploaded_by_name'] || ''}`, this.documentFilter)) : this.documents;
  }

  // ---------- campanita ----------
  toggleNotifications(): void {
    this.notifOpen = !this.notifOpen;
    if (this.notifOpen) void this.notifications.refresh();
  }
  async openNotification(n: AppNotification): Promise<void> {
    this.notifOpen = false;
    if (!n.read_at) void this.notifications.markRead(n.id);
    if (!n.link) return;
    const [path, query] = n.link.split('?');
    const queryParams: Row = {};
    for (const part of (query || '').split('&').filter(Boolean)) { const [k, v] = part.split('='); queryParams[k] = decodeURIComponent(v || ''); }
    await this.router.navigate(['/app', ...path.split('/')], { queryParams });
  }
  timeAgo(value: unknown): string {
    const ms = Date.now() - new Date(String(value)).getTime();
    if (isNaN(ms)) return '';
    const min = Math.round(ms / 60000);
    if (min < 1) return 'ahora';
    if (min < 60) return `hace ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `hace ${h} h`;
    const d = Math.round(h / 24);
    return d === 1 ? 'ayer' : `hace ${d} días`;
  }

  // ---------- gráficas del inicio ----------
  private readonly chartColors: Record<string, Record<string, string>> = {
    project: { active: '#e0b229', changes: '#3c7fd9', closing: '#f2d98b', finalized: '#2f9a5b', cancelled: '#d24f4f' },
    proposal: { pending_researcher_review: '#e0b229', pending_coordinator: '#f2d98b', changes_requested: '#3c7fd9',
      approved: '#2f9a5b', rejected: '#d24f4f', cancelled: '#eba3a3' },
    activity: { pending: '#e0b229', in_review: '#f2d98b', changes: '#3c7fd9', completed: '#2f9a5b' },
  };
  /** Segmentos para la gráfica de dona (SVG con círculos: radio 15.915 → perímetro 100). */
  donut(kind: 'project' | 'proposal' | 'activity'): { label: string; value: number; color: string; dash: string; offset: number; percent: number }[] {
    const data: Row = this.dash['charts']?.[kind === 'project' ? 'projects' : kind === 'proposal' ? 'proposals' : 'activities'] || {};
    const order = Object.keys(this.chartColors[kind]);
    const total = order.reduce((sum, k) => sum + Number(data[k] || 0), 0);
    let acc = 0;
    return order.filter(k => Number(data[k] || 0) > 0).map(k => {
      const value = Number(data[k]);
      const percent = total ? value * 100 / total : 0;
      const seg = { label: this.status(kind, k).label, value, color: this.chartColors[kind][k], dash: `${percent} ${100 - percent}`, offset: 25 - acc, percent: Math.round(percent) };
      acc += percent;
      return seg;
    });
  }
  chartTotal(kind: 'project' | 'proposal' | 'activity'): number { return this.donut(kind).reduce((s, x) => s + x.value, 0); }
  get monthly(): { label: string; proposals: number; projects: number; pHeight: number; jHeight: number }[] {
    const rows: Row[] = this.dash['charts']?.['monthly'] || [];
    const max = Math.max(1, ...rows.map(r => Math.max(Number(r['proposals']), Number(r['projects']))));
    return rows.map(r => {
      const [y, m] = String(r['month']).split('-').map(Number);
      return { label: new Date(y, m - 1, 1).toLocaleDateString('es-MX', { month: 'short' }), proposals: Number(r['proposals']), projects: Number(r['projects']),
        pHeight: Math.round(Number(r['proposals']) * 100 / max), jHeight: Math.round(Number(r['projects']) * 100 / max) };
    });
  }
  goPage(page: number): void { this.page = page; void this.load(); }

  get visibleProjects(): Row[] {
    const term = this.search.trim().toLocaleLowerCase();
    return this.projects.filter(p =>
      (!this.filter || p['status'] === this.filter || (this.filter === 'open' && ['active', 'changes', 'closing'].includes(p['status']))) &&
      (!term || `${p['title']} ${p['researcher_name']}`.toLocaleLowerCase().includes(term)));
  }
  get visibleUsers(): Row[] {
    const term = this.search.trim().toLocaleLowerCase();
    return this.users.filter(u => (!this.userFilter || u['status'] === this.userFilter) &&
      (!term || `${u['name']} ${u['username']} ${u['email'] || ''}`.toLocaleLowerCase().includes(term)));
  }

  setTab(tab: string): void {
    this.tab = tab;
    void this.router.navigate([], { relativeTo: this.route, queryParams: { tab }, replaceUrl: true });
    if (tab === 'Historial') void this.loadHistory();
  }
  private async loadHistory(): Promise<void> {
    if (!this.project) return;
    try {
      this.history = (await this.api.request<Row>('projects/history.php', { project_id: this.project['id'] }))['items'];
    } catch (error) { this.say(this.message(error, 'No se pudo cargar el historial.'), 'error'); }
    this.changeDetector.markForCheck();
  }
  async showVersions(documentId: number, keep = false): Promise<void> {
    if (this.versionsOf === documentId && !keep) { this.versionsOf = 0; return; }
    this.versionsOf = documentId;
    try {
      this.versions = (await this.api.request<Row>('documents/versions.php', { document_id: documentId }))['items'];
    } catch (error) { this.say(this.message(error, 'No se pudieron cargar las versiones.'), 'error'); }
    this.changeDetector.markForCheck();
  }

  // =====================================================================
  // Permisos que la interfaz muestra (el servidor vuelve a validarlos)
  // =====================================================================
  get projectEditable(): boolean { return ['active', 'changes'].includes(this.project?.['status']); }
  /** Investigador o Coordinación que actúa como investigadora. */
  get canResearch(): boolean { return this.role === 'researcher' || this.role === 'coordinator'; }
  get isLead(): boolean { return this.canResearch && Number(this.project?.['responsible_researcher_id']) === this.me; }
  get canRequestProjectChange(): boolean {
    return this.isMember && !this.isLead && ['active', 'changes', 'closing'].includes(this.project?.['status']) && !this.project?.['change_request'];
  }
  /** Estudiante autor (mientras sea propuesta) o Coordinación cambian al investigador directamente. */
  get canChangeProposalResearcher(): boolean {
    const p = this.proposal;
    if (!p) return false;
    if (this.role === 'coordinator') return !['approved', 'rejected', 'cancelled'].includes(p['status']);
    return this.isAuthor && this.role === 'student' && ['pending_researcher_review', 'changes_requested'].includes(p['status']);
  }
  /** El autor puede editar mientras nadie la ha revisado. */
  get canEditProposal(): boolean {
    return !!this.proposal && this.isAuthor && ['pending_researcher_review', 'pending_coordinator'].includes(this.proposal['status']);
  }
  /** Responsable o integrante con permiso: crea y revisa actividades e hitos. */
  get canManagePlan(): boolean { return this.isLead || !!this.project?.['i_can_manage']; }
  get isMember(): boolean {
    return (this.project?.['participants'] || []).some((p: Row) => Number(p['user_id']) === this.me && Number(p['is_active']) === 1);
  }
  get activeMembers(): Row[] { return (this.project?.['participants'] || []).filter((p: Row) => Number(p['is_active']) === 1); }
  get formerMembers(): Row[] { return (this.project?.['participants'] || []).filter((p: Row) => Number(p['is_active']) !== 1); }
  get openActivities(): number { return this.activities.filter(a => ['pending', 'in_review', 'changes'].includes(a['status'])).length; }
  isProjectLead(member: Row): boolean { return Number(member['user_id']) === Number(this.project?.['responsible_researcher_id']); }
  canDeleteDocument(doc: Row): boolean { return this.projectEditable && (this.isLead || Number(doc['created_by']) === this.me); }

  get canReviewProposal(): boolean {
    const p = this.proposal;
    if (!p) return false;
    return (p['status'] === 'pending_researcher_review' && this.canResearch && Number(p['responsible_researcher_id']) === this.me) ||
      (p['status'] === 'pending_coordinator' && this.role === 'coordinator');
  }
  get isAuthor(): boolean { return Number(this.proposal?.['author_id']) === this.me; }
  get canCancelProposal(): boolean {
    // También se puede cancelar ya aprobada (cancela su proyecto), salvo que el proyecto ya se haya completado.
    return !!this.proposal && (this.isAuthor || this.role === 'coordinator') &&
      !['rejected', 'cancelled'].includes(this.proposal['status']) && this.proposal['project_status'] !== 'finalized';
  }
  get cancelConsequence(): string {
    const p = this.proposal;
    if (!p) return '';
    if (p['status'] === 'approved') return 'Esta propuesta ya es un proyecto: al cancelarla también se cancela el proyecto y el equipo ya no podrá trabajar en él. Nada se borra y se puede reactivar.';
    return 'Dejará de revisarse. Nada se borra: el autor o Coordinación pueden reactivarla y volverá al punto donde estaba.';
  }
  get proposalWaitingOn(): string {
    const p = this.proposal;
    if (!p) return '';
    if (p['status'] === 'pending_researcher_review') return `Esperando la revisión de ${p['researcher_name']}.`;
    if (p['status'] === 'pending_coordinator') return 'Esperando la decisión de Coordinación.';
    if (p['status'] === 'changes_requested') return `${p['author_name']} debe corregirla y reenviarla.`;
    return '';
  }

  get activityLead(): boolean { return this.canResearch && Number(this.activity?.['lead_id']) === this.me; }
  get activityManage(): boolean { return this.activityLead || !!this.activity?.['i_can_manage']; }
  /** Nadie revisa su propia entrega, salvo el investigador responsable. */
  get activityCanReview(): boolean { return this.activityManage && (this.activityLead || !this.activityMine); }
  get activityMine(): boolean { return Number(this.activity?.['participant_id']) === this.me; }
  get activityEditable(): boolean { return ['active', 'changes'].includes(this.activity?.['project_status']); }
  get activityOpen(): boolean { return ['pending', 'in_review', 'changes'].includes(this.activity?.['status']); }

  // =====================================================================
  // Diálogo único: abrir, validar y guardar
  // =====================================================================
  /** Texto normal con «nombres» resaltados en negrita y cursiva (sin mostrar los símbolos). */
  fmt(text: unknown): string {
    const esc = String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
    return esc.replace(/«([^»\n]+)»/g, '<strong><em>$1</em></strong>');
  }

  /** Ejemplos dentro de las cajas de texto cuando el campo no trae uno propio. */
  private readonly placeholders: Record<string, string> = {
    title: 'Ej.: Calidad del agua en comunidades rurales', description: 'Describe en pocas líneas de qué trata…',
    objectives: 'Ej.: Analizar…, Proponer…, Evaluar…', justification: 'Explica por qué esta propuesta debe aprobarse directamente…',
    reason: 'Escribe el motivo…', observations: 'Escribe tus comentarios para la otra persona…', note: 'Escribe una nota…',
    comment: 'Ej.: Adjunto la versión final del informe', name: 'Nombre y apellidos', username: 'Ej.: ana.lopez',
    email: 'nombre@correo.com', project_role: 'Ej.: Tesista, analista de datos', description_short: 'Ej.: Foto de la toma de muestra',
    version_note: 'Ej.: Corregí la sección de resultados', current_password: 'Tu contraseña actual', new_password: 'Mínimo 8 caracteres',
    password: 'Mínimo 8 caracteres',
  };

  openDialog(dialog: Dialog): void {
    for (const field of dialog.fields) {
      if (!field.placeholder && this.placeholders[field.key]) field.placeholder = this.placeholders[field.key];
    }
    this.dialog = dialog;
    this.dialogError = '';
    this.dialogFile = undefined;
    void this.buildPreview(undefined);
    this.shown = {};
    for (const field of dialog.fields) {
      if (dialog.values[field.key] === undefined) dialog.values[field.key] = field.type === 'checks' ? [] : '';
    }
  }
  closeDialog(): void { if (!this.saving) this.dialog = undefined; }
  isRequired(field: DialogField): boolean { return !!field.required || !!field.requiredWhen?.(this.dialog?.values || {}); }
  toggleCheck(field: DialogField, value: string, checked: boolean): void {
    const list: string[] = this.dialog!.values[field.key];
    this.dialog!.values[field.key] = checked ? [...list, value] : list.filter(item => item !== value);
  }
  isChecked(field: DialogField, value: string): boolean { return (this.dialog?.values[field.key] || []).includes(value); }
  /** En Objetivos, «* » al inicio de una línea se vuelve una viñeta «• ». */
  bulletize(field: DialogField, area: HTMLTextAreaElement): void {
    if (!['objectives'].includes(field.key) || !this.dialog) return;
    const before = area.value;
    const after = before.replace(/(^|\n)([ \t]*)\* /g, '$1$2• ');
    if (after === before) return;
    const cursor = area.selectionStart + (after.length - before.length);
    this.dialog.values[field.key] = after;
    area.value = after;
    area.setSelectionRange(cursor, cursor);
  }
  /** Enter después de una viñeta continúa la lista. */
  bulletEnter(field: DialogField, event: KeyboardEvent): void {
    if (field.key !== 'objectives' || event.shiftKey || !this.dialog) return;
    const area = event.target as HTMLTextAreaElement;
    const start = area.selectionStart;
    const line = area.value.slice(0, start).split('\n').pop() || '';
    const match = /^([ \t]*)• (.*)$/.exec(line);
    if (!match) return;
    event.preventDefault();
    let value: string; let cursor: number;
    if (!match[2].trim()) {
      // Viñeta vacía + Enter: termina la lista.
      value = area.value.slice(0, start - line.length) + area.value.slice(start); cursor = start - line.length;
    } else {
      const insert = '\n' + match[1] + '• ';
      value = area.value.slice(0, start) + insert + area.value.slice(area.selectionEnd); cursor = start + insert.length;
    }
    this.dialog.values[field.key] = value;
    area.value = value;
    area.setSelectionRange(cursor, cursor);
  }

  /** Vista previa del archivo elegido: imagen, PDF, texto o tarjeta con el tipo. */
  filePreview?: FilePreview;
  private previewUrl?: string;
  private async buildPreview(file?: File): Promise<void> {
    if (this.previewUrl) { URL.revokeObjectURL(this.previewUrl); this.previewUrl = undefined; }
    this.filePreview = undefined;
    if (!file) return;
    const made = await this.makePreview(file);
    this.previewUrl = made.objectUrl;
    this.filePreview = made.preview;
    this.changeDetector.markForCheck();
  }
  private async makePreview(file: File): Promise<{ preview: FilePreview; objectUrl?: string }> {
    let objectUrl: string | undefined;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const size = file.size >= 1048576 ? `${(file.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`;
    const preview: FilePreview = { name: file.name, size, ext: ext.toUpperCase() || 'ARCHIVO', kind: 'other' };
    if (/^image\//.test(file.type) || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
      objectUrl = URL.createObjectURL(file); preview.kind = 'image'; preview.src = objectUrl;
    } else if (ext === 'pdf') {
      objectUrl = URL.createObjectURL(new Blob([file], { type: 'application/pdf' })); preview.kind = 'pdf';
      preview.url = this.sanitizer.bypassSecurityTrustResourceUrl(objectUrl + '#navpanes=0&view=FitH');
    } else if (['txt', 'md', 'csv'].includes(ext)) {
      preview.kind = 'text'; preview.text = (await file.slice(0, 20000).text()).slice(0, 8000);
    } else if (['docx', 'xlsx'].includes(ext)) {
      try { const text = await extractOfficeText(file); if (text.trim()) { preview.kind = 'text'; preview.text = text.slice(0, 8000); } } catch { /* solo tarjeta */ }
    }
    return { preview, objectUrl };
  }

  /** Visor de archivos ya guardados (documentos, evidencias, material, propuesta, institucionales). */
  viewer?: { title: string; loading: boolean; preview?: FilePreview; error?: string; download: () => Promise<void> };
  private viewerUrl?: string;
  async view(module: 'documents' | 'evidence' | 'institutional-documents', documentId: number, version?: number, title = ''): Promise<void> {
    const params: Record<string, number> = { document_id: documentId };
    if (version) params['version'] = version;
    await this.openViewer(title, () => this.backend.fetchFile(module, params), () => this.download(module, documentId, version));
  }
  async viewProposalFile(): Promise<void> {
    const p = this.proposal!;
    await this.openViewer(p['file']?.['filename'] || 'Archivo de la propuesta',
      () => this.backend.fetchFile('proposals', { proposal_id: p['id'] }, 'download-file'), () => this.downloadProposalFile());
  }
  private async openViewer(title: string, fetch: () => Promise<File | null>, download: () => Promise<void>): Promise<void> {
    this.closeViewer();
    this.viewer = { title, loading: true, download };
    this.changeDetector.markForCheck();
    try {
      const file = await fetch();
      if (!file) { this.viewer = undefined; await download(); return; }
      const made = await this.makePreview(file);
      if (!this.viewer) { if (made.objectUrl) URL.revokeObjectURL(made.objectUrl); return; }
      this.viewerUrl = made.objectUrl;
      this.viewer = { ...this.viewer, title: title || file.name, loading: false, preview: made.preview };
    } catch (error) {
      if (this.viewer) this.viewer = { ...this.viewer, loading: false, error: this.message(error, 'No se pudo abrir el archivo.') };
    } finally {
      this.changeDetector.markForCheck();
    }
  }
  /** En celulares el PDF a veces no se ve dentro de la ventana: se abre en otra pestaña. */
  openViewerTab(): void { if (this.viewerUrl) window.open(this.viewerUrl, '_blank'); }
  closeViewer(): void {
    if (this.viewerUrl) { URL.revokeObjectURL(this.viewerUrl); this.viewerUrl = undefined; }
    this.viewer = undefined;
  }
  /** Tipo de archivo (PDF, DOCX…) para la etiqueta de color en las listas. */
  extOf(name: unknown): string { const m = /\.([a-z0-9]+)$/i.exec(String(name || '')); return m ? m[1].toUpperCase() : 'ARCH'; }
  fileIcon(ext: string): string {
    return ({ PDF: '#c0392b', DOC: '#2b5797', DOCX: '#2b5797', XLS: '#1e7145', XLSX: '#1e7145', CSV: '#1e7145', PPT: '#d24726', PPTX: '#d24726' } as Record<string, string>)[ext] || '#5b6b68';
  }
  clearDialogFile(input: HTMLInputElement): void {
    input.value = ''; this.dialogFile = undefined; this.dialogError = ''; void this.buildPreview(undefined);
  }

  chooseFile(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    this.dialogFile = file;
    this.dialogError = '';
    void this.buildPreview(file);
    if (file && file.size > this.backend.maxUploadBytes) {
      this.dialogError = `El archivo pesa ${(file.size / 1048576).toFixed(1)} MB; el máximo es ${this.backend.maxUploadBytes / 1048576} MB.`;
    }
  }
  passwordOk(value: unknown): boolean { return PASSWORD_RULE.test(String(value || '')); }

  async submitDialog(): Promise<void> {
    const dialog = this.dialog;
    if (!dialog || this.saving) return;
    const values = dialog.values;
    const missing = dialog.fields.filter(field => {
      if (!this.isRequired(field)) return false;
      if (field.type === 'file') return !this.dialogFile;
      const value = values[field.key];
      return Array.isArray(value) ? value.length === 0 : String(value ?? '').trim() === '';
    });
    if (missing.length) { this.dialogError = 'Completa: ' + missing.map(field => field.label).join(', ') + '.'; return; }
    for (const field of dialog.fields) {
      const value = String(values[field.key] ?? '').trim();
      if (field.type === 'password' && value && !PASSWORD_RULE.test(value)) {
        this.dialogError = 'La contraseña necesita de 8 a 72 caracteres, con mayúscula, minúscula y número.'; return;
      }
      if (field.type === 'email' && value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) { this.dialogError = 'Revisa el correo.'; return; }
      if (field.type === 'date' && value && field.min && value < field.min) { this.dialogError = `${field.label}: la fecha ya pasó.`; return; }
    }
    if (this.dialogFile && this.dialogFile.size > this.backend.maxUploadBytes) return;
    this.saving = true;
    this.dialogError = '';
    try {
      const text = await dialog.submit(values, this.dialogFile);
      this.dialog = undefined;
      this.say(text);
      await this.load(true);
    } catch (error) {
      this.dialogError = this.message(error, 'No se pudo guardar.');
    } finally {
      this.saving = false;
      this.changeDetector.markForCheck();
    }
  }

  private post(path: string, body: Row): Promise<Row> { return this.api.request<Row>(path, {}, body); }
  private async fileBody(file?: File): Promise<Row> {
    if (!file) return {};
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
      reader.readAsDataURL(file);
    });
    const body: Row = { filename: file.name, file_base64: base64 };
    // Supabase no abre archivos ZIP: el texto de DOCX/XLSX para el asistente se extrae aquí.
    if (this.backend.mode === 'supabase' && /\.(docx|xlsx)$/i.test(file.name)) body['text_content'] = await extractOfficeText(file);
    return body;
  }
  private async options(path: string, params: Row): Promise<Option[]> {
    const result = await this.api.request<Row>(path, params);
    return (result['items'] as Row[]).map(item => ({ value: String(item['id']), label: item['role'] ? `${item['name']} · ${this.roleName(item['role'])}` : item['name'] }));
  }
  private async withOptions(build: () => Promise<void>): Promise<void> {
    try { await build(); } catch (error) { this.say(this.message(error, 'No se pudieron cargar las opciones.'), 'error'); }
  }

  // =====================================================================
  // Propuestas
  // =====================================================================
  newProposal(): void {
    void this.withOptions(async () => {
      const fields: DialogField[] = [
        { key: 'title', label: 'Título', type: 'text', required: true },
        { key: 'description', label: 'Descripción', type: 'textarea', required: true },
        { key: 'objectives', label: 'Objetivos', type: 'textarea', required: true },
      ];
      if (this.role === 'student') {
        fields.push({ key: 'responsible_researcher_id', label: 'Investigador responsable', type: 'select', required: true,
          options: await this.options('catalogs/researchers.php', {}), hint: 'Será quien revise tu propuesta y dirija el proyecto.' });
      }
      if (this.role === 'coordinator') {
        fields.push({ key: 'justification', label: 'Justificación', type: 'textarea', required: true,
          hint: 'Explica por qué se aprueba directamente; quedará en el historial de la propuesta.' });
      }
      fields.push({ key: 'file', label: 'Archivo (opcional)', type: 'file', hint: 'PDF, Word, Excel, PowerPoint, imagen o texto. Máximo 5 MB.' });
      this.openDialog({
        title: 'Nueva propuesta', confirmLabel: this.role === 'coordinator' ? 'Crear proyecto' : 'Enviar propuesta', fields, values: {},
        intro: this.role === 'student' ? 'Se enviará al investigador que elijas. Si la aprueba, se convierte en proyecto. Mientras no la revise, puedes editarla.'
          : this.role === 'researcher' ? 'Como investigador, tu propuesta pasa directo a Coordinación.'
          : 'Como Coordinación, tu propuesta se aprueba en ese momento y se convierte en proyecto contigo como responsable.',
        submit: async (values, file) => {
          const body: Row = { ...values, ...(await this.fileBody(file)) };
          delete body['file'];
          const result = await this.post('proposals/create.php', body);
          if (result['project_id']) { void this.router.navigate(['/app/projects', result['project_id']]); return 'Proyecto creado.'; }
          void this.router.navigate(['/app/proposals', result['proposal_id']]);
          return 'Propuesta enviada.';
        },
      });
    });
  }

  changeProposalResearcher(): void {
    const p = this.proposal!;
    void this.withOptions(async () => {
      const options = (await this.options('catalogs/researchers.php', {})).filter(o => o.value !== String(p['responsible_researcher_id']));
      this.openDialog({
        title: 'Cambiar investigador responsable', confirmLabel: 'Cambiar', values: {},
        intro: `Ahora el responsable es «${p['researcher_name']}». ` + (p['status'] === 'pending_researcher_review'
          ? 'La propuesta pasará a la bandeja del nuevo investigador para que la revise.' : 'El nuevo investigador revisará la propuesta cuando la reenvíes.'),
        fields: [
          { key: 'researcher_id', label: 'Nuevo investigador responsable', type: 'select', required: true, options },
          { key: 'reason', label: 'Motivo (opcional)', type: 'textarea' },
        ],
        submit: async values => { await this.post('proposals/change-researcher.php', { proposal_id: p['id'], ...values }); return 'Investigador actualizado.'; },
      });
    });
  }

  /** Integrante de un proyecto en curso: pide a Coordinación otro investigador responsable (lo elige él). */
  requestResearcherChange(): void {
    const item = this.project!;
    void this.withOptions(async () => {
      const options = (await this.options('catalogs/researchers.php', {})).filter(o => o.value !== String(item['responsible_researcher_id']));
      this.openDialog({
        title: 'Solicitar cambio de investigador', confirmLabel: 'Enviar solicitud', values: {},
        intro: `Coordinación aprobará o rechazará el cambio. Mientras tanto, «${item['researcher_name']}» sigue como responsable.`,
        fields: [
          { key: 'proposed_researcher_id', label: 'Nuevo investigador responsable', type: 'select', required: true, options },
          { key: 'reason', label: '¿Por qué quieres cambiar de investigador?', type: 'textarea', required: true },
        ],
        submit: async values => {
          await this.post('changes/request.php', { project_id: item['id'], reason: values['reason'], proposed_researcher_id: values['proposed_researcher_id'] });
          return 'Solicitud enviada a Coordinación.';
        },
      });
    });
  }

  /** Texto de la solicitud: «quiere cambiar a X por Y». */
  changeRequestText(r: Row): string {
    return `${r['requester_name']} quiere cambiar a «${r['current_name']}» por «${r['proposed_name'] || 'otro investigador'}» como responsable.`;
  }
  private changeRequestClosed(r: Row): string {
    const st = r['target_status'];
    if (st === 'cancelled') return r['target_kind'] === 'project' ? 'El proyecto fue cancelado.' : 'La propuesta fue cancelada.';
    if (st === 'finalized') return 'El proyecto ya se completó.';
    if (st === 'rejected') return 'La propuesta fue rechazada.';
    return '';
  }

  /** Coordinación aprueba o rechaza: el nuevo investigador ya lo eligió quien pidió el cambio. */
  reviewChangeRequest(request: Row): void {
    const closed = this.changeRequestClosed(request);
    if (closed) {
      this.openDialog({
        title: 'Esta solicitud ya no aplica', confirmLabel: 'Entendido', values: {}, fields: [],
        intro: `${closed} No hay nada que cambiar; la solicitud se cerró sola.`,
        submit: async () => 'Solicitud cerrada.',
      });
      return;
    }
    const legacy = !request['proposed_researcher_id'];
    void this.withOptions(async () => {
      const options = legacy ? (await this.options('catalogs/researchers.php', {})).filter(o => o.value !== String(request['current_researcher_id'])) : [];
      this.openDialog({
        title: 'Solicitud de cambio de investigador', confirmLabel: 'Guardar decisión', values: {},
        intro: `«${request['target_title']}»: ${this.changeRequestText(request)} Motivo: ${request['reason']}`,
        fields: [
          { key: 'decision', label: 'Decisión', type: 'choice', required: true, options: [
            { value: 'approved', label: legacy ? 'Aprobar el cambio' : `Aprobar: «${request['proposed_name']}» será el nuevo responsable` },
            { value: 'rejected', label: `Rechazar: «${request['current_name']}» sigue como responsable` }] },
          ...(legacy ? [{ key: 'researcher_id', label: 'Nuevo investigador responsable', type: 'select' as const, options,
            requiredWhen: (v: Row) => v['decision'] === 'approved', hint: 'Esta solicitud es anterior y no indica a quién se quiere.' }] : []),
          { key: 'note', label: 'Nota para quien lo pidió', type: 'textarea', requiredWhen: v => v['decision'] === 'rejected' },
        ],
        submit: async values => {
          const body: Row = { request_id: request['id'], decision: values['decision'], note: values['note'] };
          if (legacy && values['decision'] === 'approved') body['researcher_id'] = values['researcher_id'];
          try { await this.post('changes/review.php', body); }
          catch (error) {
            const msg = this.message(error, '');
            // Si ya no aplica (por ejemplo, se canceló), se cierra el aviso en lugar de dejar la ventana abierta.
            if (/ya no aplica|ya se resolvió/i.test(msg)) return msg;
            throw error;
          }
          return values['decision'] === 'approved' ? 'Investigador cambiado.' : 'Solicitud rechazada.';
        },
      });
    });
  }

  async downloadProposalFile(): Promise<void> {
    try { await this.backend.download('proposals', { proposal_id: this.proposal!['id'] }, 'download-file'); }
    catch (error) { this.say(this.message(error, 'No se pudo descargar el archivo.'), 'error'); }
  }

  reviewProposal(): void {
    const p = this.proposal!;
    const byCoordination = p['status'] === 'pending_coordinator';
    this.openDialog({
      title: 'Revisar propuesta', confirmLabel: 'Guardar decisión', values: {},
      intro: 'Si apruebas, el proyecto se crea en ese momento con ' + (byCoordination ? 'el investigador como responsable.' : 'el autor en el equipo y tú como responsable.'),
      fields: [
        { key: 'decision', label: 'Decisión', type: 'choice', required: true, options: [
          { value: 'approved', label: 'Aprobar y crear el proyecto' },
          { value: 'changes_requested', label: 'Solicitar cambios al autor' },
          { value: 'rejected', label: 'Rechazar (definitivo)' },
        ] },
        { key: 'observations', label: 'Observaciones para el autor', type: 'textarea',
          requiredWhen: v => v['decision'] === 'changes_requested' || v['decision'] === 'rejected',
          hint: 'Obligatorias al pedir cambios o rechazar: el autor las verá tal cual.' },
      ],
      submit: async values => {
        const result = await this.post('proposals/review.php', { proposal_id: p['id'], ...values });
        if (result['project_id']) { void this.router.navigate(['/app/projects', result['project_id']]); return 'Propuesta aprobada: el proyecto ya está creado.'; }
        return values['decision'] === 'rejected' ? 'Propuesta rechazada.' : 'Se pidieron cambios al autor.';
      },
    });
  }

  correctProposal(): void {
    const p = this.proposal!;
    void this.withOptions(async () => {
      const fields: DialogField[] = [
        { key: 'title', label: 'Título', type: 'text', required: true },
        { key: 'description', label: 'Descripción', type: 'textarea', required: true },
        { key: 'objectives', label: 'Objetivos', type: 'textarea', required: true },
      ];
      const editing = p['status'] !== 'changes_requested';
      if (this.role === 'student') {
        fields.push({ key: 'responsible_researcher_id', label: 'Investigador responsable', type: 'select', required: true,
          options: await this.options('catalogs/researchers.php', {}),
          hint: 'Si lo cambias, la propuesta pasa a revisión del nuevo investigador.' });
      }
      fields.push({ key: 'file', label: p['file'] ? 'Reemplazar archivo (opcional)' : 'Archivo (opcional)', type: 'file',
        hint: p['file'] ? `Actual: ${p['file']['filename']}. Si subes otro, queda como nueva versión.` : 'PDF, Word, Excel, imagen o texto. Máximo 5 MB.' });
      this.openDialog({
        title: editing ? 'Editar propuesta' : 'Corregir y reenviar', confirmLabel: editing ? 'Guardar cambios' : 'Guardar y reenviar', fields,
        intro: editing ? 'Todavía nadie la revisa, así que puedes corregirla. Quien la revise verá la versión nueva.'
          : p['returns_to'] === 'pending_coordinator' ? 'Al guardar, regresa a Coordinación.' : 'Al guardar, regresa al investigador responsable.',
        values: { title: p['title'], description: p['description'], objectives: p['objectives'],
          responsible_researcher_id: String(p['responsible_researcher_id']) },
        submit: async (values, file) => {
          const body: Row = { proposal_id: p['id'], ...values, ...(await this.fileBody(file)) };
          delete body['file'];
          await this.post('proposals/update.php', body);
          return editing ? 'Propuesta actualizada.' : 'Correcciones enviadas.';
        },
      });
    });
  }

  cancelProposal(): void {
    const p = this.proposal!;
    this.openDialog({
      title: p['status'] === 'approved' ? 'Cancelar propuesta y su proyecto' : 'Cancelar propuesta', danger: true, values: {},
      confirmLabel: p['status'] === 'approved' ? 'Sí, cancelar propuesta y proyecto' : 'Sí, cancelar propuesta',
      warning: `¿Segura que quieres cancelar «${p['title']}»? ${this.cancelConsequence}`,
      fields: [{ key: 'reason', label: 'Motivo de la cancelación', type: 'textarea', required: true,
        placeholder: 'Ej.: Ya no se cuenta con los recursos para realizarla', hint: 'Lo verán el autor, el investigador responsable y el equipo.' }],
      submit: async values => {
        await this.post('proposals/cancel.php', { proposal_id: p['id'], ...values });
        return p['status'] === 'approved' ? 'Propuesta y proyecto cancelados.' : 'Propuesta cancelada.';
      },
    });
  }

  reactivateProposal(): void {
    const p = this.proposal!;
    this.openDialog({
      title: 'Reactivar propuesta', confirmLabel: 'Reactivar', values: {}, fields: [],
      intro: p['status_before_cancel'] === 'approved' ? `«${p['title']}» vuelve a estar aprobada y su proyecto se reabre.`
        : `«${p['title']}» vuelve al punto donde estaba antes de cancelarse.`,
      submit: async () => { await this.post('proposals/reactivate.php', { proposal_id: p['id'] }); return 'Propuesta reactivada.'; },
    });
  }

  proposalEvent(action: string): string {
    return ({
      created: 'Propuesta registrada', resubmit: 'Corregida y reenviada', edited: 'Editada por el autor', researcher_changed: 'Cambio de investigador responsable', review_approved: 'Aprobada',
      review_changes_requested: 'Cambios solicitados', review_rejected: 'Rechazada', cancelled: 'Cancelada', reactivated: 'Reactivada',
      // Historial anterior a la versión 3:
      update: 'Correcciones guardadas', assign: 'Evaluador asignado', archived: 'Archivada', unarchived: 'Desarchivada',
      evaluation_approved: 'Evaluación: aprobada', evaluation_changes_requested: 'Evaluación: cambios', evaluation_rejected: 'Evaluación: rechazada',
    } as Record<string, string>)[action] || action;
  }

  // =====================================================================
  // Proyecto: datos, cierre, cancelación y reporte
  // =====================================================================
  editProject(): void {
    const p = this.project!;
    this.openDialog({
      title: 'Editar datos del proyecto', confirmLabel: 'Guardar', values: {
        title: p['title'], description: p['description'] || '', objectives: p['objectives'] || '',
        start_date: p['start_date'] || '', end_date: p['end_date'] || '' },
      fields: [
        { key: 'title', label: 'Título', type: 'text', required: true },
        { key: 'description', label: 'Descripción', type: 'textarea', required: true },
        { key: 'objectives', label: 'Objetivos', type: 'textarea', required: true },
        { key: 'start_date', label: 'Fecha de inicio', type: 'date' },
        { key: 'end_date', label: 'Fecha de término', type: 'date' },
      ],
      submit: async values => {
        if (values['start_date'] && values['end_date'] && values['end_date'] < values['start_date']) {
          throw new Error('La fecha de término debe ser posterior a la de inicio.');
        }
        await this.post('projects/update.php', { project_id: p['id'], ...values });
        return 'Proyecto actualizado.';
      },
    });
  }

  requestClosure(): void {
    const p = this.project!;
    if (this.openActivities > 0) {
      this.say(`Antes de solicitar el cierre, termina o cancela las ${this.openActivities} actividades abiertas.`, 'error');
      this.setTab('Actividades');
      return;
    }
    this.openDialog({
      title: 'Solicitar cierre', confirmLabel: 'Solicitar cierre', values: {},
      intro: 'Coordinación revisará el proyecto. Mientras tanto no se podrá modificar. Si pide cambios, el proyecto queda "En cambios" y lo puedes volver a solicitar.',
      fields: [{ key: 'observations', label: 'Resumen de resultados (opcional)', type: 'textarea' }],
      submit: async values => { await this.post('closures/request.php', { project_id: p['id'], ...values }); return 'Cierre solicitado.'; },
    });
  }

  reviewClosure(): void {
    const p = this.project!;
    this.openDialog({
      title: 'Revisar cierre', confirmLabel: 'Guardar decisión', values: {},
      intro: p['last_closure']?.['observations'] ? `Resumen del responsable: ${p['last_closure']['observations']}` : undefined,
      fields: [
        { key: 'decision', label: 'Decisión', type: 'choice', required: true, options: [
          { value: 'approved', label: 'Aprobar: el proyecto queda Completado' },
          { value: 'changes_requested', label: 'Pedir cambios: el proyecto queda En cambios' },
        ] },
        { key: 'observations', label: 'Observaciones', type: 'textarea', requiredWhen: v => v['decision'] === 'changes_requested',
          hint: 'Obligatorias si pides cambios: indica qué falta.' },
      ],
      submit: async values => {
        await this.post('closures/review.php', { project_id: p['id'], ...values });
        return values['decision'] === 'approved' ? 'Proyecto completado.' : 'Se pidieron cambios al responsable.';
      },
    });
  }

  changeResearcher(): void {
    const p = this.project!;
    void this.withOptions(async () => {
      const options = (await this.options('catalogs/researchers.php', {})).filter(o => o.value !== String(p['responsible_researcher_id']));
      this.openDialog({
        title: 'Cambiar investigador responsable', confirmLabel: 'Cambiar responsable', values: {},
        intro: `${p['researcher_name']} seguirá en el equipo como investigador y conservará su historial.`,
        fields: [{ key: 'researcher_id', label: 'Nuevo investigador responsable', type: 'select', required: true, options }],
        submit: async values => { await this.post('projects/change-researcher.php', { project_id: p['id'], ...values }); return 'Responsable actualizado.'; },
      });
    });
  }

  cancelProject(): void {
    const p = this.project!;
    this.openDialog({
      title: 'Cancelar proyecto', confirmLabel: 'Sí, cancelar proyecto', danger: true, values: {},
      warning: `«${p['title']}» quedará en solo lectura para todo el equipo. No se borra nada: Coordinación puede reabrirlo si fue un error.`,
      fields: [{ key: 'reason', label: 'Motivo de la cancelación', type: 'textarea', required: true, hint: 'El equipo verá este motivo.' }],
      submit: async values => { await this.post('projects/cancel.php', { project_id: p['id'], ...values }); return 'Proyecto cancelado.'; },
    });
  }

  reopenProject(): void {
    const p = this.project!;
    this.openDialog({
      title: 'Reabrir proyecto', confirmLabel: 'Reabrir', values: {},
      intro: `«${p['title']}» volverá a "En proceso" y el equipo podrá trabajar de nuevo.`,
      fields: [{ key: 'reason', label: 'Motivo', type: 'textarea', required: true }],
      submit: async values => { await this.post('projects/reopen.php', { project_id: p['id'], ...values }); return 'Proyecto reabierto.'; },
    });
  }

  async downloadReport(general = false): Promise<void> {
    try {
      const data = general ? await this.post('reports/general.php', {}) : await this.post('reports/project.php', { project_id: this.project!['id'] });
      downloadReportPdf(data, {
        projectStatus: v => this.status('project', v), activityStatus: v => this.status('activity', v),
        milestoneStatus: v => this.status('milestone', v), role: r => this.roleName(r), date: d => this.date(d),
      });
      this.say('Reporte descargado en PDF.');
    } catch (error) { this.say(this.message(error, 'No se pudo generar el reporte.'), 'error'); }
  }

  // =====================================================================
  // Equipo
  // =====================================================================
  addMember(): void {
    const p = this.project!;
    void this.withOptions(async () => {
      const options = await this.options('catalogs/participants.php', { project_id: p['id'], all: '1' });
      if (!options.length) { this.say('No hay más estudiantes o investigadores activos para agregar.', 'error'); return; }
      this.openDialog({
        title: 'Agregar integrante', confirmLabel: 'Agregar', values: {},
        fields: [
          { key: 'user_id', label: 'Persona', type: 'select', required: true, options },
          { key: 'project_role', label: 'Rol en el proyecto (opcional)', type: 'text', hint: 'Por ejemplo: tesista, analista de datos.' },
        ],
        submit: async values => { await this.post('participants/add.php', { project_id: p['id'], ...values }); return 'Integrante agregado.'; },
      });
    });
  }

  toggleManage(member: Row): void {
    const grant = !Number(member['can_manage']);
    this.openDialog({
      title: grant ? `Dar permisos a ${member['name']}` : `Quitar permisos a ${member['name']}`,
      confirmLabel: grant ? 'Dar permisos' : 'Quitar permisos', values: {}, fields: [],
      intro: grant ? `«${member['name']}» podrá crear, editar y cancelar actividades e hitos, y revisar las entregas de los demás (no las suyas). Equipo, cierre y datos del proyecto siguen siendo solo tuyos.`
        : `«${member['name']}» ya no podrá gestionar el plan de trabajo; sus actividades no cambian.`,
      submit: async () => {
        await this.post('participants/permissions.php', { project_id: this.project!['id'], user_id: member['user_id'], can_manage: grant });
        return grant ? 'Permisos otorgados.' : 'Permisos retirados.';
      },
    });
  }

  editMemberRole(member: Row): void {
    this.openDialog({
      title: `Rol de ${member['name']}`, confirmLabel: 'Guardar', values: { project_role: member['project_role'] || '' },
      fields: [{ key: 'project_role', label: 'Rol en el proyecto', type: 'text' }],
      submit: async values => {
        await this.post('participants/update.php', { project_id: this.project!['id'], user_id: member['user_id'], ...values });
        return 'Rol actualizado.';
      },
    });
  }

  removeMember(member: Row): void {
    const p = this.project!;
    const pending = Number(member['pending_activities'] || 0);
    const options = this.activeMembers.filter(m => m['user_id'] !== member['user_id'])
      .map(m => ({ value: String(m['user_id']), label: m['name'] + (this.isProjectLead(m) ? ' (responsable)' : '') }));
    this.openDialog({
      title: 'Retirar del equipo', confirmLabel: 'Sí, retirar', danger: true,
      values: { reassign_to: String(p['responsible_researcher_id']) },
      warning: `${member['name']} ya no podrá ver el proyecto. Su historial se conserva y puedes reincorporarlo después.`,
      intro: pending ? `Tiene ${pending} actividad(es) sin terminar: elige quién las recibe.` : 'No tiene actividades pendientes.',
      fields: pending ? [{ key: 'reassign_to', label: 'Sus actividades pasan a', type: 'select', required: true, options }] : [],
      submit: async values => {
        const result = await this.post('participants/remove.php', { project_id: p['id'], user_id: member['user_id'], ...values });
        return Number(result['activities_moved']) ? `Integrante retirado; se reasignaron ${result['activities_moved']} actividad(es).` : 'Integrante retirado.';
      },
    });
  }

  rejoinMember(member: Row): void {
    this.openDialog({
      title: 'Reincorporar al equipo', confirmLabel: 'Reincorporar', values: {}, fields: [],
      intro: `${member['name']} volverá a ver el proyecto con su rol anterior.`,
      submit: async () => {
        await this.post('participants/add.php', { project_id: this.project!['id'], user_id: member['user_id'] });
        return 'Integrante reincorporado.';
      },
    });
  }

  // =====================================================================
  // Actividades
  // =====================================================================
  activityForm(existing?: Row, milestoneId?: number): void {
    const projectId = existing ? existing['project_id'] : this.project!['id'];
    void this.withOptions(async () => {
      const options = await this.options('catalogs/participants.php', { project_id: projectId });
      const milestones: Row[] = this.project ? this.milestones
        : (await this.api.request<Row>('milestones/list.php', { project_id: projectId }))['items'];
      const hitoOptions = [{ value: 'none', label: 'Sin hito' }, ...milestones.map(m => ({ value: String(m['id']), label: `${m['description']} (meta ${this.date(m['target_date'])})` }))];
      const currentHito = existing ? existing['milestone_id'] : milestoneId;
      this.openDialog({
        title: existing ? 'Editar actividad' : 'Nueva actividad', confirmLabel: existing ? 'Guardar' : 'Crear actividad',
        values: {
          ...(existing ? { description: existing['description'], participant_id: String(existing['participant_id']), deadline: existing['deadline'] } : {}),
          milestone_id: currentHito ? String(currentHito) : 'none',
        },
        fields: [
          { key: 'description', label: 'Descripción', type: 'textarea', required: true, placeholder: 'Ej.: Tomar muestras de agua en las 3 comunidades' },
          { key: 'participant_id', label: 'Responsable', type: 'select', required: true, options },
          { key: 'deadline', label: 'Fecha límite', type: 'date', required: true, min: existing ? undefined : this.todayIso },
          { key: 'milestone_id', label: 'Hito al que pertenece', type: 'select', options: hitoOptions,
            hint: 'El hito se marca como alcanzado solo, cuando todas sus actividades están completadas.' },
          { key: 'file', label: existing ? 'Agregar material de apoyo (opcional)' : 'Material de apoyo (opcional)', type: 'file',
            hint: 'Por ejemplo una guía o formato. PDF, Word, Excel, imagen o texto. Máximo 5 MB.' },
        ],
        submit: async (values, file) => {
          const body: Row = { ...values, milestone_id: values['milestone_id'] === 'none' ? '' : values['milestone_id'], ...(await this.fileBody(file)) };
          delete body['file'];
          if (existing) await this.post('activities/update.php', { activity_id: existing['id'], ...body });
          else await this.post('activities/create.php', { project_id: projectId, ...body });
          return existing ? 'Actividad actualizada.' : 'Actividad creada.';
        },
      });
    });
  }

  /** Plan de trabajo: cada hito con sus actividades y al final las que no tienen hito. */
  get activityGroups(): { milestone: Row | null; items: Row[] }[] {
    const items = this.visibleActivities;
    const groups: { milestone: Row | null; items: Row[] }[] = this.milestones.map(m => ({
      milestone: m, items: items.filter(a => Number(a['milestone_id']) === Number(m['id'])) }));
    const loose = items.filter(a => !a['milestone_id']);
    if (loose.length || !groups.length) groups.push({ milestone: null, items: loose });
    // Al buscar, se ocultan los hitos sin coincidencias.
    return this.activityFilter.trim() ? groups.filter(g => g.items.length) : groups;
  }
  milestonePercent(m: Row): number { return Number(m['activity_count']) ? Math.round(100 * Number(m['completed_count']) / Number(m['activity_count'])) : 0; }

  submitActivity(): void {
    const a = this.activity!;
    const files = this.evidence.length;
    this.openDialog({
      title: 'Entregar para revisión', confirmLabel: 'Entregar', values: {},
      intro: files ? `Se enviará con ${files} evidencia(s) adjunta(s).` : undefined,
      warning: files ? undefined : 'No has adjuntado evidencias. Puedes entregar así, pero revisa que no te falte ningún archivo.',
      fields: [{ key: 'comment', label: 'Comentario para el responsable (opcional)', type: 'textarea' }],
      submit: async values => { await this.post('activities/submit.php', { activity_id: a['id'], ...values }); return 'Actividad entregada.'; },
    });
  }

  reviewActivity(): void {
    const a = this.activity!;
    const reopening = a['status'] === 'completed';
    this.openDialog({
      title: reopening ? 'Reabrir actividad' : 'Revisar entrega', confirmLabel: 'Guardar', values: reopening ? { decision: 'changes_requested' } : {},
      intro: reopening ? 'Úsalo si la aceptaste por error o falta algo: vuelve a la persona asignada con tus observaciones.' : undefined,
      fields: [
        ...(reopening ? [] : [{ key: 'decision', label: 'Decisión', type: 'choice' as const, required: true, options: [
          { value: 'approved', label: 'Aceptar: queda Completada' },
          { value: 'changes_requested', label: 'Pedir cambios' },
        ] }]),
        { key: 'observations', label: 'Observaciones', type: 'textarea', requiredWhen: v => v['decision'] === 'changes_requested' },
      ],
      submit: async values => {
        await this.post('activities/review.php', { activity_id: a['id'], ...values });
        return values['decision'] === 'approved' ? 'Actividad aceptada.' : 'Se pidieron cambios.';
      },
    });
  }

  cancelActivity(): void {
    const a = this.activity!;
    this.openDialog({
      title: 'Cancelar actividad', confirmLabel: 'Sí, cancelar actividad', danger: true, values: {},
      warning: 'Deja de contar en el avance y ya no se podrá entregar. Si fue un error, crea la actividad de nuevo.',
      fields: [{ key: 'reason', label: 'Motivo', type: 'textarea', required: true }],
      submit: async values => { await this.post('activities/cancel.php', { activity_id: a['id'], ...values }); return 'Actividad cancelada.'; },
    });
  }

  addEvidence(): void {
    const a = this.activity!;
    this.openDialog({
      title: 'Adjuntar evidencia', confirmLabel: 'Adjuntar', values: {},
      fields: [
        { key: 'file', label: 'Archivo', type: 'file', required: true, hint: 'PDF, Word, Excel, PowerPoint, imagen o texto. Máximo 5 MB.' },
        { key: 'description', label: 'Descripción (opcional)', type: 'text' },
      ],
      submit: async (values, file) => {
        await this.post('evidence/upload.php', { project_id: a['project_id'], activity_id: a['id'], description: values['description'], ...(await this.fileBody(file)) });
        return 'Evidencia adjunta.';
      },
    });
  }

  removeEvidence(doc: Row): void {
    this.openDialog({
      title: 'Quitar evidencia', confirmLabel: 'Sí, quitar', danger: true, values: {}, fields: [],
      warning: `Se quitará «${doc['title']}». Puedes adjuntar el archivo correcto después.`,
      submit: async () => { await this.post('evidence/delete.php', { document_id: doc['id'] }); return 'Evidencia quitada.'; },
    });
  }

  // =====================================================================
  // Hitos
  // =====================================================================
  milestoneForm(existing?: Row): void {
    const p = this.project!;
    this.openDialog({
      title: existing ? 'Editar hito' : 'Nuevo hito', confirmLabel: 'Guardar',
      intro: 'Un hito agrupa actividades (por ejemplo "Trabajo de campo"). Las actividades se agregan desde el propio hito con «Actividad» o al crear/editar cada actividad.',
      values: existing ? { description: existing['description'], target_date: existing['target_date'] } : {},
      fields: [
        { key: 'description', label: 'Nombre del hito', type: 'text', required: true, placeholder: 'Ej.: Trabajo de campo' },
        { key: 'target_date', label: 'Fecha meta', type: 'date', required: true },
      ],
      submit: async values => {
        const body = { project_id: p['id'], ...values };
        if (existing) await this.post('milestones/update.php', { milestone_id: existing['id'], ...body });
        else await this.post('milestones/create.php', body);
        return 'Hito guardado.';
      },
    });
  }

  deleteMilestone(m: Row): void {
    this.openDialog({
      title: 'Eliminar hito', confirmLabel: 'Sí, eliminar', danger: true, values: {}, fields: [],
      warning: `Se eliminará el hito «${m['description']}». Sus actividades no se borran: quedan como «Sin hito».`,
      submit: async () => { await this.post('milestones/delete.php', { milestone_id: m['id'] }); return 'Hito eliminado.'; },
    });
  }

  // =====================================================================
  // Documentos del proyecto y fuentes institucionales
  // =====================================================================
  uploadDocument(existing?: Row, institutional = false): void {
    const module = institutional ? 'institutional-documents' : 'documents';
    const fields: DialogField[] = existing ? [] : [{ key: 'title', label: 'Título', type: 'text', required: true }];
    fields.push({ key: 'file', label: 'Archivo', type: 'file', required: true, hint: 'PDF, Word, Excel, PowerPoint, imagen o texto. Máximo 5 MB.' });
    if (existing && !institutional) fields.push({ key: 'version_note', label: 'Qué cambió (opcional)', type: 'text' });
    this.openDialog({
      title: existing ? `Nueva versión de «${existing['title']}»` : institutional ? 'Agregar fuente' : 'Subir documento',
      confirmLabel: 'Subir', values: {}, fields,
      intro: existing ? 'Las versiones anteriores se conservan y se pueden descargar.' : undefined,
      submit: async (values, file) => {
        const body: Row = { ...values, ...(await this.fileBody(file)) };
        delete body['file'];
        if (!institutional) body['project_id'] = this.project!['id'];
        if (existing) body['document_id'] = existing['id'];
        const action = existing ? (institutional ? 'update' : 'upload-version') : 'upload';
        await this.post(`${module}/${action}.php`, body);
        return existing ? 'Nueva versión guardada.' : 'Archivo subido.';
      },
    });
  }

  toggleRestriction(doc: Row): void {
    const restricted = Number(doc['restricted']) === 1;
    this.openDialog({
      title: restricted ? 'Mostrar a todo el equipo' : 'Solo investigadores', confirmLabel: 'Cambiar visibilidad', values: {}, fields: [],
      intro: restricted ? `Los estudiantes del proyecto podrán ver «${doc['title']}».` : `Los estudiantes del proyecto dejarán de ver «${doc['title']}».`,
      submit: async () => {
        await this.post('documents/set-restriction.php', { document_id: doc['id'], restricted: !restricted });
        return 'Visibilidad actualizada.';
      },
    });
  }

  deleteDocument(doc: Row, institutional = false): void {
    this.openDialog({
      title: institutional ? 'Retirar fuente' : 'Eliminar documento', confirmLabel: 'Sí, eliminar', danger: true, values: {}, fields: [],
      warning: `«${doc['title']}» y todas sus versiones dejarán de estar disponibles${institutional ? ' para el asistente' : ' para el equipo'}.`,
      submit: async () => {
        await this.post(`${institutional ? 'institutional-documents' : 'documents'}/delete.php`, { document_id: doc['id'] });
        return 'Archivo eliminado.';
      },
    });
  }

  async download(module: 'documents' | 'evidence' | 'institutional-documents', documentId: number, version?: number): Promise<void> {
    const params: Record<string, number> = { document_id: documentId };
    if (version) params['version'] = version;
    try { await this.backend.download(module, params); }
    catch (error) { this.say(this.message(error, 'No se pudo descargar el archivo.'), 'error'); }
  }

  // =====================================================================
  // Usuarios
  // =====================================================================
  private roleOptions(): Option[] { return (Object.keys(ROLE_LABELS) as Role[]).map(value => ({ value, label: ROLE_LABELS[value] })); }

  newUser(): void {
    this.openDialog({
      title: 'Nuevo usuario', confirmLabel: 'Crear usuario', values: { role: 'student' },
      fields: [
        { key: 'name', label: 'Nombre completo', type: 'text', required: true },
        { key: 'username', label: 'Usuario', type: 'text', required: true, hint: 'Sin espacios: letras, números, punto o guion.' },
        { key: 'email', label: 'Correo (opcional)', type: 'email' },
        { key: 'role', label: 'Rol', type: 'choice', required: true, options: this.roleOptions() },
      ],
      intro: 'La contraseña temporal se crea sola. Al terminar podrás copiar el usuario y la contraseña para compartirlos.',
      submit: async values => {
        const password = this.tempPassword(values['username']);
        await this.post('users/create.php', { ...values, password });
        this.credentials = { title: 'Cuenta creada', name: values['name'], username: String(values['username']).trim(), password };
        return 'Cuenta creada.';
      },
    });
  }

  /** Contraseña temporal fácil de dictar: Usuario + números (cumple mayúscula, minúscula y número). */
  tempPassword(username: unknown): string {
    const letters = String(username || '').normalize('NFD').replace(/[^A-Za-z]/g, '').toLowerCase().slice(0, 12) || 'usuario';
    let base = letters[0].toUpperCase() + letters.slice(1);
    if (base.length < 2) base += 'a';
    const digits = Math.max(3, 8 - base.length);
    const random = new Uint32Array(1); crypto.getRandomValues(random);
    return base + String(random[0] % 10 ** digits).padStart(digits, '0');
  }
  credentials?: { title: string; name: string; username: string; password: string };
  credentialsCopied = false;
  async copyCredentials(): Promise<void> {
    const c = this.credentials;
    if (!c) return;
    const text = `Hola ${c.name}, estos son tus datos para entrar a Research University:\nUsuario: ${c.username}\nContraseña temporal: ${c.password}\nAl entrar por primera vez te pedirá crear tu propia contraseña.`;
    try { await navigator.clipboard.writeText(text); }
    catch {
      const area = document.createElement('textarea'); area.value = text; document.body.appendChild(area); area.select();
      document.execCommand('copy'); area.remove();
    }
    this.credentialsCopied = true;
    this.changeDetector.markForCheck();
  }
  closeCredentials(): void { this.credentials = undefined; this.credentialsCopied = false; }

  editUser(user: Row): void {
    const self = Number(user['id']) === this.me;
    this.openDialog({
      title: `Editar a ${user['name']}`, confirmLabel: 'Guardar cambios',
      values: { name: user['name'], username: user['username'], email: user['email'] || '', role: user['role'], status: user['status'] },
      intro: self ? 'No puedes cambiar tu propio rol ni desactivar tu cuenta.'
        : 'Si cambias el rol o lo desactivas, su sesión se cierra. El sistema avisa si tiene proyectos o actividades que primero hay que pasar a alguien más.',
      fields: [
        { key: 'name', label: 'Nombre completo', type: 'text', required: true },
        { key: 'username', label: 'Usuario', type: 'text', required: true },
        { key: 'email', label: 'Correo (opcional)', type: 'email' },
        ...(self ? [] : [
          { key: 'role', label: 'Rol', type: 'choice' as const, required: true, options: this.roleOptions() },
          { key: 'status', label: 'Acceso', type: 'choice' as const, required: true,
            options: [{ value: 'active', label: 'Activo' }, { value: 'inactive', label: 'Inactivo (no puede entrar)' }] },
        ]),
      ],
      submit: async values => { await this.post('users/update.php', { user_id: user['id'], ...values }); return 'Usuario actualizado.'; },
    });
  }

  deleteUser(user: Row): void {
    this.openDialog({
      title: 'Eliminar usuario definitivamente', confirmLabel: 'Sí, eliminar para siempre', danger: true, values: {},
      warning: `¿Segura que quieres eliminar a «${user['name']}»${String(user['username']).toLowerCase() !== String(user['name']).toLowerCase() ? ' (usuario ' + user['username'] + ')' : ''}? ` +
        'Esto NO se puede deshacer: ya no podrá entrar y se borran sus datos personales. Si participó en proyectos, en su historial aparecerá como «Usuario eliminado». ' +
        'Si solo quieres quitarle el acceso por un tiempo, mejor desactiva la cuenta en Editar.',
      fields: [{ key: 'confirm', label: 'Para confirmar, escribe la palabra ELIMINAR', type: 'text', required: true, placeholder: 'ELIMINAR' }],
      submit: async values => {
        if (String(values['confirm']).trim().toUpperCase() !== 'ELIMINAR') throw new Error('Escribe ELIMINAR para confirmar.');
        const result = await this.post('users/delete.php', { user_id: user['id'] });
        return result['mode'] === 'deleted' ? 'Usuario eliminado.' : 'Usuario eliminado; su historial queda como «Usuario eliminado».';
      },
    });
  }

  resetPassword(user: Row): void {
    this.openDialog({
      title: `Contraseña temporal para ${user['name']}`, confirmLabel: 'Asignar contraseña temporal', values: {},
      intro: 'Se crea una contraseña temporal nueva: sus sesiones se cierran y al entrar tendrá que crear la suya. Si la persona tiene correo registrado, también puede recuperarla sola desde «¿Olvidaste tu contraseña?».',
      fields: [],
      submit: async () => {
        const password = this.tempPassword(user['username']);
        await this.post('users/reset-password.php', { user_id: user['id'], password });
        this.credentials = { title: 'Nueva contraseña temporal', name: user['name'], username: user['username'], password };
        return 'Contraseña temporal asignada.';
      },
    });
  }

  // =====================================================================
  // Historial del proyecto
  // =====================================================================
  eventLabel(event: Row): string {
    const key = `${event['entity']}:${event['action']}`;
    return ({
      'project:created_from_proposal': 'Proyecto creado desde la propuesta', 'project:configured': 'Datos del proyecto actualizados',
      'project:change-researcher': 'Cambio de investigador responsable', 'project:cancelled': 'Proyecto cancelado',
      'project:reopened': 'Proyecto reabierto', 'participant:add': 'Integrante agregado', 'participant:update': 'Rol de integrante actualizado',
      'participant:remove': 'Integrante retirado', 'participant:permissions': 'Permisos del plan de trabajo', 'activity:create': 'Actividad creada', 'activity:update': 'Actividad editada',
      'activity:reassign': 'Actividad reasignada', 'activity:submit': 'Actividad entregada', 'activity:review': 'Entrega revisada',
      'activity:cancel': 'Actividad cancelada', 'activity:start': 'Actividad iniciada', 'milestone:create': 'Hito creado',
      'milestone:update': 'Hito editado', 'milestone:delete': 'Hito eliminado', 'milestone:achieve': 'Hito alcanzado',
      'document:upload': 'Documento subido', 'document:upload-version': 'Nueva versión de documento', 'document:update': 'Documento actualizado',
      'document:delete': 'Documento eliminado', 'document:set-restriction': 'Visibilidad de documento cambiada',
      'document:set-block': 'Bloqueo de documento cambiado', 'closure:request': 'Cierre solicitado', 'closure:review': 'Cierre revisado',
    } as Record<string, string>)[key] || event['action'];
  }
  eventDetail(event: Row): string {
    let data: Row = {};
    try { data = JSON.parse(event['details'] || '{}') || {}; } catch { return ''; }
    const input: Row = data['input'] || {};
    const parts = [data['user'], data['title'], data['description'], input['description'], data['reason'] && `Motivo: ${data['reason']}`,
      input['reason'] && `Motivo: ${input['reason']}`, input['decision'] && (input['decision'] === 'approved' ? 'Aceptada' : 'Cambios pedidos'),
      input['observations'], data['before'] && typeof data['before'] === 'string' && `${data['before']} → ${data['after']}`,
      data['can_manage'] === true && 'Puede gestionar el plan de trabajo', data['can_manage'] === false && 'Ya no gestiona el plan de trabajo'];
    return parts.filter(Boolean).join(' · ');
  }

  // =====================================================================
  // Reporte imprimible
  // =====================================================================


  // =====================================================================
  // Asistente
  // =====================================================================
  /**
   * Convierte el formato que usa la IA (Markdown: **negritas**, *cursivas*, viñetas, listas numeradas,
   * citas con >, títulos con #) en HTML. Primero se escapa todo el texto, así no se puede inyectar HTML.
   */
  rich(markdown: string, sources: Row[] = []): string {
    // Referencias [P3] / [6] → etiqueta con el nombre del proyecto o documento.
    const refs = new Map<string, { label: string; kind: string }>();
    for (const src of sources) {
      refs.set(String(src['reference']), { label: String(src['title'] || ''), kind: src['type'] === 'project' ? 'project' : 'document' });
    }
    const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
    // Nunca se muestran los ID: [P3], [P1, P2], (P3), [6], [A12]… se cambian por el nombre o se quitan.
    // Entre paréntesis solo se tocan los que llevan letra, para no borrar cosas como "(2026)".
    const tag = (line: string) => line.replace(/\[((?:[PAH]?\d+)(?:\s*[,;]\s*[PAH]?\d+)*)\]|\(((?:[PAH]\d+)(?:\s*[,;]\s*[PAH]\d+)*)\)/g,
      (all, inBrackets: string, inParens: string) => (inBrackets || inParens).split(/\s*[,;]\s*/).map(ref => {
        const info = refs.get(ref);
        if (!info) return '';
        // Si la frase ya dice el nombre, no se repite.
        if (line.toLocaleLowerCase().replace(all.toLocaleLowerCase(), '').includes(info.label.toLocaleLowerCase())) return '';
        return `\u0000${info.kind}\u0001${info.label}\u0002`;
      }).filter(Boolean).join(' '))
      .replace(/[\[(](?:propuesta|actividad|hito|proyecto|documento|fragmento)\s*#?\s*\d+[\])]/gi, '')
      .replace(/\s+([.,;:])/g, '$1').replace(/ {2,}/g, ' ').replace(/\s+(y|o)\s*([.,;:]|$)/g, '$2');
    const inline = (v: string) => esc(tag(v))
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/«([^»\n]+)»/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_(?!\s)(.+?)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/\u0000(\w+)\u0001([^\u0002]*)\u0002/g, (_m, kind: string, label: string) =>
        `<span class="ref ref-${kind}" title="${kind === 'project' ? 'Proyecto' : 'Documento'}">${label}</span>`)
      .replace(/ +([.,;:])/g, '$1');
    const out: string[] = [];
    let list: 'ul' | 'ol' | null = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const raw of markdown.replace(/\r/g, '').split('\n')) {
      const line = raw.trimEnd();
      const bullet = line.match(/^\s*[*\-•]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        const kind = bullet ? 'ul' : 'ol';
        if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
        out.push(`<li>${inline((bullet || numbered)![1])}</li>`);
        continue;
      }
      closeList();
      if (!line.trim()) continue;
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      const quote = line.match(/^>\s?(.*)$/);
      if (heading) out.push(`<h4>${inline(heading[1])}</h4>`);
      else if (quote) out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      else out.push(`<p>${inline(line)}</p>`);
    }
    closeList();
    return out.join('');
  }

  async ask(): Promise<void> {
    if ((!this.question.trim() && !this.attachment) || this.asking || this.attachBusy) return;
    const attachment = this.attachment;
    const question = this.question.trim() || `Revisa el archivo «${attachment!.name}» y dime de qué trata.`;
    this.question = '';
    this.attachment = undefined;
    this.asking = true;
    this.messages.push({ author: 'Tú', text: question, html: this.rich(question), attachment: attachment?.name });
    // Conversación previa (sin la pregunta actual) para que la IA entienda "¿y eso cómo lo hago?".
    const history = this.messages.slice(0, -1).slice(-6).map(m => ({ author: m.author, text: m.text.split('\n\n**Fuentes consultadas:**')[0] }));
    const reply: ChatMessage = { author: 'Asistente', text: '', html: '', pending: true };
    this.messages.push(reply);
    this.scrollChat(true);
    let sources: Row[] = [];
    let replySources: Row[] = [];
    let notice = '';
    let failure: Row | null = null;
    let received = false;
    let answered = false;
    try {
      // 1) IA en streaming: el texto aparece mientras Gemini lo escribe.
      const payload: Row = { question, mode: 'ask', history, stream: true };
      if (attachment) payload['attachment'] = { name: attachment.name, mime: attachment.mime, data: attachment.data, text: attachment.text };
      const connected = await this.backend.streamFunction('asistente', payload, event => {
        if (event.type === 'delta') { received = true; reply.text += event.text; reply.html = this.rich(reply.text); this.scrollChat(); }
        else if (event.type === 'final') { received = true; reply.text = event.answer || ''; sources = event.sources || []; notice = event.notice || ''; }
        else if (event.type === 'done') {
          sources = event.sources || []; notice = event.notice || '';
          if (event.timing) console.info('Asistente', event.model, event.timing);
        }
        else if (event.type === 'error') failure = event;
        this.changeDetector.markForCheck();
      });
      if (failure && Number((failure as Row)['status']) === 401) {
        this.backend.setToken(null);
        await this.router.navigate(['/login'], { replaceUrl: true });
        throw new Error('Tu sesión terminó. Vuelve a iniciar sesión.');
      }
      if (failure && Number((failure as Row)['status']) < 500) throw new Error((failure as Row)['message'] || 'No se pudo consultar.');
      // 2) Si la función no está publicada o falló antes de responder: respuesta local con los datos del sistema.
      if (!connected || !received) {
        const r = await this.api.request<Row>('assistant/query.php', {}, { question, mode: 'ask' });
        reply.text = r['answer'];
        sources = r['sources'] || [];
        if (attachment) notice = 'El archivo adjunto solo lo puede leer la IA, que no respondió esta vez.';
      }
      reply.text += (sources.length ? '\n\n**Fuentes consultadas:**\n' + sources.map(s => s['type'] === 'project'
          ? `- Proyecto «${s['title']}»` : `- Documento «${s['title']}»${s['version'] ? ' (versión ' + s['version'] + ')' : ''}${s['project_title'] ? ' del proyecto «' + s['project_title'] + '»' : ''}`).join('\n') : '') +
        (notice ? '\n\n_(' + notice + ')_' : '');
      replySources = sources;
      answered = true;
    } catch (error) {
      reply.text = this.message(error, 'No se pudo consultar.');
    } finally {
      reply.pending = false;
      reply.html = this.rich(reply.text, replySources);
      this.asking = false;
      this.scrollChat();
      this.changeDetector.markForCheck();
    }
    if (answered) await this.saveExchange(question, reply.text, replySources, attachment?.name);
  }

  // ---------- historial de chats ----------
  get chatTitle(): string {
    return this.chats.find(c => Number(c['id']) === this.chatId)?.['title'] || (this.chatId ? 'Chat' : 'Nuevo chat');
  }
  private chatKey(): string { return `urpmp.chat.${this.me}`; }
  private todayKey(): string { return new Date().toLocaleDateString('en-CA'); }
  private savedChat(): number {
    try {
      const saved = JSON.parse(localStorage.getItem(this.chatKey()) || 'null');
      return saved && saved.day === this.todayKey() ? Number(saved.id) || 0 : 0;
    } catch { return 0; }
  }
  private rememberChat(id: number): void {
    try {
      if (id) localStorage.setItem(this.chatKey(), JSON.stringify({ id, day: this.todayKey() }));
      else localStorage.removeItem(this.chatKey());
    } catch { /* Sin almacenamiento local: el chat sigue en el historial. */ }
  }

  async loadChats(): Promise<void> {
    try { this.chats = (await this.api.request<Row>('assistant/chats.php'))['items']; }
    catch { this.chats = []; }
    this.changeDetector.markForCheck();
  }

  async openChat(id: number, closePanel = true): Promise<void> {
    if (this.asking) return;
    try {
      const result = await this.api.request<Row>('assistant/chat-messages.php', { chat_id: id });
      this.messages = (result['items'] as Row[]).map(m => ({
        author: m['author'] === 'user' ? 'Tú' : 'Asistente', text: m['text'], attachment: m['attachment'] || undefined,
        html: this.rich(m['text'], m['sources'] || []) }));
      this.chatId = id;
      this.rememberChat(id);
      if (closePanel) this.historyOpen = false;
      this.scrollChat(true);
    } catch (error) {
      this.say(this.message(error, 'No se pudo abrir el chat.'), 'error');
      if (this.chatId === id) this.newChat();
    }
    this.changeDetector.markForCheck();
  }

  newChat(): void {
    if (this.asking) return;
    this.messages = [];
    this.chatId = 0;
    this.attachment = undefined;
    this.question = '';
    this.historyOpen = false;
    this.rememberChat(0);
  }

  deleteChat(chat: Row): void {
    this.openDialog({
      title: 'Eliminar chat', confirmLabel: 'Sí, eliminar', danger: true, values: {}, fields: [],
      warning: `¿Segura que quieres eliminar «${chat['title']}»? Se borrará toda la conversación y no se puede recuperar.`,
      submit: async () => {
        await this.post('assistant/chat-delete.php', { chat_id: chat['id'] });
        if (Number(chat['id']) === this.chatId) this.newChat();
        await this.loadChats();
        return 'Chat eliminado.';
      },
    });
  }

  private async saveExchange(question: string, answer: string, sources: Row[], attachment?: string): Promise<void> {
    try {
      const body: Row = { question, answer, sources, attachment: attachment || '' };
      if (this.chatId) body['chat_id'] = this.chatId;
      const result = await this.post('assistant/chat-save.php', body);
      this.chatId = Number(result['chat_id']);
      this.rememberChat(this.chatId);
      await this.loadChats();
    } catch { /* Si no se pudo guardar, la conversación sigue en pantalla. */ }
  }

  chatDay(value: unknown): string {
    const d = new Date(String(value));
    if (isNaN(d.getTime())) return '';
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Hoy · ' + d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
  }

  /** Baja al último mensaje. Si la persona subió a leer algo, no la mueve (salvo al enviar). */
  private scrollChat(force = false): void {
    setTimeout(() => {
      const box = this.chatScroll?.nativeElement;
      if (!box) return;
      if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
    });
  }

  async chooseAttachment(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { this.say(`«${file.name}» pesa más de 5 MB. Elige un archivo más ligero.`, 'error'); return; }
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const types: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
      txt: 'text/plain', csv: 'text/csv', md: 'text/markdown' };
    this.attachBusy = true;
    try {
      if (ext === 'docx' || ext === 'xlsx') {
        const text = await extractOfficeText(file);
        if (!text.trim()) throw new Error('No se pudo leer el texto de ese archivo.');
        this.attachment = { name: file.name, mime: 'text/plain', size: file.size, text };
      } else if (types[ext]) {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
          reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
          reader.readAsDataURL(file);
        });
        this.attachment = { name: file.name, mime: types[ext], size: file.size, data };
      } else {
        throw new Error('Puedes adjuntar PDF, Word (.docx), Excel (.xlsx), imágenes o texto.');
      }
    } catch (error) {
      this.say(this.message(error, 'No se pudo adjuntar el archivo.'), 'error');
    } finally {
      this.attachBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  chatKeydown(event: KeyboardEvent): void {
    // Enter envía; Shift + Enter hace un salto de línea.
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void this.ask(); }
  }

  // =====================================================================
  // Mi perfil
  // =====================================================================
  choosePhoto(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { this.say('Elige una foto JPG, PNG o WEBP.', 'error'); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      // Se recorta en cuadrado y se reduce a 256 px para que pese poco.
      const side = Math.min(img.width, img.height);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      canvas.getContext('2d')!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 256, 256);
      this.profileAvatar = canvas.toDataURL('image/jpeg', 0.85);
      URL.revokeObjectURL(url);
      this.changeDetector.markForCheck();
    };
    img.onerror = () => { URL.revokeObjectURL(url); this.say('No se pudo abrir esa imagen.', 'error'); };
    img.src = url;
  }

  async saveProfile(): Promise<void> {
    if (this.profileSaving) return;
    if (!this.profileName.trim()) { this.say('Escribe tu nombre.', 'error'); return; }
    if (this.profileEmail.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(this.profileEmail.trim())) { this.say('Revisa tu correo.', 'error'); return; }
    this.profileSaving = true;
    try {
      const result = await this.post('profile/update.php', { name: this.profileName.trim(), email: this.profileEmail.trim(), avatar: this.profileAvatar });
      this.auth.updateUser(result['user']);
      this.say('Perfil actualizado.');
    } catch (error) {
      this.say(this.message(error, 'No se pudo guardar tu perfil.'), 'error');
    } finally {
      this.profileSaving = false;
      this.changeDetector.markForCheck();
    }
  }

  changeMyPassword(): void {
    this.openDialog({
      title: 'Cambiar mi contraseña', confirmLabel: 'Cambiar contraseña', values: {},
      intro: 'Tus sesiones en otros dispositivos se cerrarán; en este sigues dentro.',
      fields: [
        { key: 'current_password', label: 'Contraseña actual', type: 'password', required: true },
        { key: 'new_password', label: 'Nueva contraseña', type: 'password', required: true, hint: 'Mínimo 8 caracteres, con mayúscula, minúscula y número.' },
      ],
      submit: async values => {
        const result = await this.post('profile/change-password.php', values);
        this.auth.updateUser(result['user']);
        return 'Contraseña actualizada.';
      },
    });
  }

  /** Primer inicio con contraseña temporal: se crea la propia antes de entrar. */
  async submitFirstPassword(): Promise<void> {
    if (this.firstBusy) return;
    const { current, next, confirm } = this.firstPassword;
    this.firstError = '';
    if (!current || !next) { this.firstError = 'Completa las contraseñas.'; return; }
    if (!PASSWORD_RULE.test(next)) { this.firstError = 'La nueva contraseña necesita de 8 a 72 caracteres, con mayúscula, minúscula y número.'; return; }
    if (next !== confirm) { this.firstError = 'La confirmación no coincide con la nueva contraseña.'; return; }
    this.firstBusy = true;
    try {
      const result = await this.post('profile/change-password.php', { current_password: current, new_password: next });
      this.auth.updateUser(result['user']);
      this.firstPassword = { current: '', next: '', confirm: '' };
      this.firstShown = {};
      this.say('¡Listo! Ya tienes tu propia contraseña.');
      await this.load();
    } catch (error) {
      this.firstError = this.message(error, 'No se pudo cambiar la contraseña.');
    } finally {
      this.firstBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  // =====================================================================
  // Recuperar contraseña (pantalla de acceso)
  // =====================================================================
  startRecovery(): void {
    this.loginMode = 'forgot';
    this.recoverId = this.username.includes('@') ? this.username.trim() : '';
    this.recoverInfo = ''; this.loginError = ''; this.loginInfo = '';
  }
  backToLogin(): void { this.loginMode = 'login'; this.recoverInfo = ''; this.loginError = ''; }

  async requestCode(): Promise<void> {
    if (this.recoverBusy) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(this.recoverId.trim())) {
      this.loginError = 'Escribe el correo completo de tu cuenta, por ejemplo nombre@correo.com.'; return;
    }
    this.recoverBusy = true; this.loginError = ''; this.recoverInfo = '';
    try {
      const result = await this.backend.callFunction<Row>('asistente', { action: 'password-reset', identifier: this.recoverId.trim() }, 30000);
      if (!result) throw new Error('No se pudo conectar con el servicio de correo. Inténtalo más tarde o contacta a Coordinación.');
      if (result.status >= 300) throw new Error(result.body?.['message'] || 'No se pudo enviar el código.');
      this.recoverInfo = result.body?.['message'] || 'Revisa tu correo.';
      this.loginMode = 'code';
      this.recoverCode = ''; this.recoverPassword = '';
    } catch (error) {
      this.loginError = this.message(error, 'No se pudo enviar el código.');
    } finally {
      this.recoverBusy = false;
      this.changeDetector.markForCheck();
    }
  }

  async resetWithCode(): Promise<void> {
    if (this.recoverBusy) return;
    this.loginError = '';
    if (!/^\d{6}$/.test(this.recoverCode.replace(/\s/g, ''))) { this.loginError = 'El código tiene 6 números.'; return; }
    if (!PASSWORD_RULE.test(this.recoverPassword)) { this.loginError = 'La nueva contraseña necesita de 8 a 72 caracteres, con mayúscula, minúscula y número.'; return; }
    this.recoverBusy = true;
    try {
      const result = await this.backend.call<Row>('auth/reset-password.php', 'POST',
        { identifier: this.recoverId.trim(), code: this.recoverCode.replace(/\s/g, ''), password: this.recoverPassword }, 15000);
      if (result.status >= 300) throw new Error(result.body?.['message'] || 'No se pudo cambiar la contraseña.');
      this.loginMode = 'login';
      this.username = result.body?.['username'] || '';
      this.password = '';
      this.loginInfo = this.username ? `Contraseña actualizada. Tu usuario es «${this.username}»; ya puedes iniciar sesión.` : 'Contraseña actualizada. Ya puedes iniciar sesión.';
    } catch (error) {
      this.loginError = this.message(error, 'No se pudo cambiar la contraseña.');
    } finally {
      this.recoverBusy = false;
      this.changeDetector.markForCheck();
    }
  }


}
