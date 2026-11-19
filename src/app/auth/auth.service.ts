/*
 * Conecta el login, la consulta de sesión y el cierre con el backend.
 * Supabase: token de sesión guardado en el dispositivo (la base solo guarda su hash).
 * PHP (XAMPP): cookie HttpOnly como antes.
 */
import { Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Role, sectionAllowed } from '../platform/ui-config';
import { BackendResult, BackendService } from '../services/backend.service';

export interface AuthUser {
  id: number;
  name: string;
  username: string;
  role: Role;
  status: 'active';
}

interface SessionResponse { user: AuthUser; token?: string; message?: string; }

export class AuthError extends Error {
  constructor(message: string, public readonly status = 0) { super(message); }
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly currentUser = signal<AuthUser | null>(null);
  readonly user = this.currentUser.asReadonly();
  private readonly inactivityMs = 30 * 60 * 1000;
  private readonly activityCheckMs = 60 * 1000;
  private lastActivity = 0;
  private lastCheck = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private listening = false;
  private sessionRequest?: Promise<AuthUser | null>;
  private expiring = false;
  private generation = 0;
  sessionMessage = '';

  constructor(private backend: BackendService, private router: Router) {}

  // El rol viene del servidor. No se reciben roles ni permisos desde el formulario.
  async login(username: string, password: string): Promise<AuthUser> {
    ++this.generation;
    try {
      const response = this.unwrap(await this.backend.call<SessionResponse>(
        'auth/login.php', 'POST', { username: username.trim(), password }, 15000), true);
      const user = this.validateUser(response);
      if (this.backend.mode === 'supabase') {
        if (!response.token) throw new AuthError('La API no devolvió una sesión. Revisa la instalación en Supabase.', 502);
        this.backend.setToken(response.token);
      }
      this.sessionMessage = '';
      this.lastActivity = Date.now();
      this.acceptUser(user);
      return user;
    } catch (error) {
      this.clearUser();
      throw this.explainError(error, true);
    }
  }

  // Se consulta al recargar, navegar y durante actividad real; no hay latido permanente.
  checkSession(): Promise<AuthUser | null> {
    if (this.sessionRequest) return this.sessionRequest;
    const request = this.fetchSession();
    this.sessionRequest = request;
    request.finally(() => { if (this.sessionRequest === request) this.sessionRequest = undefined; }).catch(() => {});
    return request;
  }

  private async fetchSession(): Promise<AuthUser | null> {
    const generation = this.generation;
    try {
      if (this.backend.mode === 'supabase' && !this.backend.token) {
        throw new AuthError('Tu sesión terminó. Vuelve a iniciar sesión.', 401);
      }
      const response = this.unwrap(await this.backend.call<SessionResponse>('auth/session.php', 'GET', {}, 15000));
      if (generation !== this.generation) return this.user();
      const user = this.validateUser(response);
      if (!this.lastActivity) this.lastActivity = Date.now();
      this.acceptUser(user);
      this.sessionMessage = '';
      return user;
    } catch (error) {
      if (generation !== this.generation) return this.user();
      const failure = this.explainError(error);
      const hadUser = this.user() !== null;
      this.clearUser();
      if (failure.status === 401) {
        this.backend.setToken(null);
        this.sessionMessage = hadUser ? 'Tu sesión terminó. Vuelve a iniciar sesión.' : '';
        return null;
      }
      this.sessionMessage = failure.message;
      throw failure;
    }
  }

  async logout(): Promise<void> {
    try {
      this.unwrap(await this.backend.call('auth/logout.php', 'POST', {}, 15000));
      this.backend.setToken(null);
      this.clearUser();
      this.sessionMessage = '';
    } catch (error) {
      throw this.explainError(error);
    }
  }

  // Si se cumple el tiempo local, se oculta el contenido y se intenta cerrar en el servidor.
  private async expireSession(): Promise<void> {
    if (this.expiring) return;
    this.expiring = true;
    this.clearUser();
    this.sessionMessage = 'Tu sesión terminó por inactividad. Vuelve a iniciar sesión.';
    try {
      await this.backend.call('auth/logout.php', 'POST', {}, 15000);
    } catch { /* El backend también valida la expiración antes de permitir el acceso. */ }
    this.backend.setToken(null);
    await this.router.navigate(['/login'], { replaceUrl: true });
    this.expiring = false;
  }

  private acceptUser(user: AuthUser): void {
    this.currentUser.set(user);
    this.lastCheck = Date.now();
    this.startTracking();
    this.scheduleExpiry();
  }

  private clearUser(): void {
    ++this.generation;
    this.currentUser.set(null);
    this.lastActivity = 0;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.listening) {
      for (const event of ['pointerdown', 'keydown', 'touchstart', 'scroll']) {
        window.removeEventListener(event, this.onActivity, true);
      }
      window.removeEventListener('focus', this.onFocus);
      this.listening = false;
    }
  }

  private startTracking(): void {
    if (this.listening) return;
    this.listening = true;
    for (const event of ['pointerdown', 'keydown', 'touchstart', 'scroll']) {
      window.addEventListener(event, this.onActivity, { passive: true, capture: true });
    }
    window.addEventListener('focus', this.onFocus);
  }

  private readonly onActivity = (): void => {
    if (!this.user()) return;
    const now = Date.now();
    // No reactiva una sesión si el navegador suspendió la pestaña durante más de 30 minutos.
    if (now - this.lastActivity >= this.inactivityMs) { void this.expireSession(); return; }
    this.lastActivity = now;
    this.scheduleExpiry();
    if (now - this.lastCheck >= this.activityCheckMs) void this.refreshWhileActive();
  };

  private readonly onFocus = (): void => {
    if (!this.user()) return;
    if (Date.now() - this.lastActivity >= this.inactivityMs) { void this.expireSession(); return; }
    void this.refreshWhileActive();
  };

  private async refreshWhileActive(): Promise<void> {
    const previousRole = this.user()?.role;
    try {
      const user = await this.checkSession();
      if (!user) {
        await this.router.navigate(['/login'], { replaceUrl: true });
      } else if (user.role !== previousRole && this.router.url.startsWith('/app/')) {
        const section = this.router.url.split('/')[2]?.split('?')[0] || 'dashboard';
        if (!sectionAllowed(section, user.role)) {
          await this.router.navigate(['/app/dashboard'], { queryParams: { denied: '1' }, replaceUrl: true });
        }
      }
    } catch {
      await this.router.navigate(['/login'], { replaceUrl: true });
    }
  }

  private scheduleExpiry(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.expireSession(),
      Math.max(0, this.inactivityMs - (Date.now() - this.lastActivity)));
  }

  private validateUser(response: SessionResponse): AuthUser {
    const user = response?.user;
    const roles = ['student', 'researcher', 'coordinator'];
    if (!user || !Number.isInteger(user.id) || user.id <= 0 ||
        typeof user.name !== 'string' || typeof user.username !== 'string' ||
        user.status !== 'active' || !roles.includes(user.role)) {
      throw new AuthError('La API devolvió una sesión no válida. Revisa la configuración del backend.', 502);
    }
    return user;
  }

  // Convierte la respuesta del backend en datos o en un AuthError con el código HTTP.
  private unwrap<T>(result: BackendResult<T>, login = false): T {
    if (result.status >= 200 && result.status < 300) return result.body;
    throw this.explainStatus(result.status, (result.body as { message?: string } | null)?.message, login);
  }

  private explainError(error: unknown, login = false): AuthError {
    if (error instanceof AuthError) return error;
    return new AuthError('La solicitud no pudo completarse. Revisa tu conexión e inténtalo de nuevo.');
  }

  private explainStatus(status: number, message: string | undefined, login = false): AuthError {
    if (status === 401) return new AuthError(login ? 'Usuario o contraseña incorrectos.' : 'Tu sesión terminó. Vuelve a iniciar sesión.', 401);
    if (status === 403) return new AuthError(login ? 'La cuenta está inactiva o el acceso no está autorizado.' : 'No tienes permiso para realizar esta operación.', 403);
    if (status === 400 || status === 422) return new AuthError('Escribe tu usuario y contraseña.', status);
    if (status === 404) return new AuthError('No se encontró la API. Revisa la dirección configurada del backend.', 404);
    // Mensajes de conexión o configuración que ya vienen explicados por el transporte.
    if ((status === 0 || status >= 500) && message && !/^Internal server error/i.test(message)) return new AuthError(message, status);
    if (status === 0) return new AuthError('No se pudo conectar con la API. Revisa la conexión.', 0);
    return new AuthError('No se pudo completar la solicitud. Comprueba que el backend y la base de datos estén disponibles.', status);
  }
}
