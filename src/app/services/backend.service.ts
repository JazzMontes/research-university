/*
 * Transporte único hacia el backend.
 * - Modo "supabase": cada ruta PHP (p. ej. "proposals/list.php") se envía a la función
 *   public.research_api de Supabase, que responde { status, body } con los mismos códigos HTTP.
 * - Modo "php": peticiones HTTP normales al backend de XAMPP con su cookie de sesión.
 */
import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';
import { environment } from '../../environments/environment';

export interface BackendResult<T = any> { status: number; body: T; }
type Params = Record<string, unknown>;

@Injectable({ providedIn: 'root' })
export class BackendService {
  readonly mode: 'supabase' | 'php' = environment.supabaseUrl && environment.supabaseKey ? 'supabase' : 'php';
  /** Supabase guarda los archivos en la base; 5 MB por archivo cuida el plan gratuito. */
  readonly maxUploadBytes = this.mode === 'supabase' ? 5 * 1024 * 1024 : 10 * 1024 * 1024;
  private readonly tokenKey = 'urpmp_session_token';
  private readonly phpBase = environment.apiBaseUrl.replace(/\/$/, '');

  constructor(private http: HttpClient) {}

  get token(): string | null {
    try { return localStorage.getItem(this.tokenKey); } catch { return null; }
  }

  setToken(token: string | null): void {
    try {
      if (token) localStorage.setItem(this.tokenKey, token);
      else localStorage.removeItem(this.tokenKey);
    } catch { /* Navegación privada sin almacenamiento: la sesión dura lo que la pestaña. */ }
  }

  async call<T = any>(path: string, method: 'GET' | 'POST', data: Params = {}, timeoutMs = 15000): Promise<BackendResult<T>> {
    if (this.mode === 'supabase') return this.callSupabase<T>(path, method, data, timeoutMs);
    if (typeof location !== 'undefined' && location.hostname.endsWith('github.io')) {
      return { status: 503, body: { message: 'Esta publicación no tiene configurado Supabase. Agrega SUPABASE_URL y SUPABASE_KEY en el repositorio y vuelve a publicar.' } as T };
    }
    return this.callPhp<T>(path, method, data, timeoutMs);
  }

  private async callSupabase<T>(path: string, method: string, data: Params, timeoutMs: number): Promise<BackendResult<T>> {
    const url = environment.supabaseUrl.replace(/\/$/, '') + '/rest/v1/rpc/research_api';
    const key = environment.supabaseKey;
    let headers = new HttpHeaders({ apikey: key, 'Content-Type': 'application/json' });
    // Las claves antiguas (anon, JWT "eyJ…") también van en Authorization; las nuevas sb_publishable_ no.
    if (key.startsWith('eyJ')) headers = headers.set('Authorization', `Bearer ${key}`);
    try {
      const result = await firstValueFrom(this.http.post<BackendResult<T>>(url,
        { ruta: path, metodo: method, datos: data, token: this.token }, { headers }).pipe(timeout(timeoutMs)));
      if (!result || typeof result.status !== 'number') {
        return { status: 502, body: { message: 'Supabase devolvió una respuesta inesperada.' } as T };
      }
      return result;
    } catch (error) {
      if (error instanceof HttpErrorResponse) {
        if (error.status === 0) return this.failure(0, 'No hay respuesta de Supabase. Revisa tu internet o si el proyecto está en pausa (supabase.com → Restore project).');
        if (error.status === 404 || error.error?.code === 'PGRST202') {
          return this.failure(503, 'La base de datos de Supabase no tiene instalada la API. Ejecuta supabase/instalar_todo.sql en el SQL Editor.');
        }
        if (error.status === 401 || error.status === 403) {
          return this.failure(503, 'La clave pública de Supabase no es válida. Revisa SUPABASE_URL y SUPABASE_KEY.');
        }
        if (error.status === 413) return this.failure(413, 'El archivo es demasiado grande para enviarlo.');
        return this.failure(503, `Supabase respondió con un error (${error.status}). Inténtalo de nuevo.`);
      }
      return this.failure(0, 'La solicitud tardó demasiado. Revisa tu conexión e inténtalo de nuevo.');
    }
  }

  private async callPhp<T>(path: string, method: string, data: Params, timeoutMs: number): Promise<BackendResult<T>> {
    const url = `${this.phpBase}/${path}`;
    try {
      const request = method === 'POST'
        ? this.http.post<T>(url, data, { withCredentials: true })
        : this.http.get<T>(url, { withCredentials: true, params: this.toParams(data) });
      const body = await firstValueFrom(request.pipe(timeout(timeoutMs)));
      return { status: 200, body };
    } catch (error) {
      if (error instanceof HttpErrorResponse) {
        if (error.status === 0) return this.failure(0, 'No se pudo conectar con la API. Revisa Apache, la dirección y los permisos de conexión.');
        return { status: error.status, body: (error.error && typeof error.error === 'object' ? error.error : {}) as T };
      }
      return this.failure(0, 'La solicitud tardó demasiado. Revisa tu conexión e inténtalo de nuevo.');
    }
  }

  /**
   * Llama a una función Edge de Supabase (p. ej. "asistente", que conecta con ChatGPT o Gemini).
   * Devuelve null si la función no está publicada o no responde, para usar el respaldo local.
   */
  async callFunction<T = any>(name: string, data: Params, timeoutMs = 65000): Promise<BackendResult<T> | null> {
    if (this.mode !== 'supabase') return null;
    const url = environment.supabaseUrl.replace(/\/$/, '') + '/functions/v1/' + name;
    const key = environment.supabaseKey;
    let headers = new HttpHeaders({ apikey: key, 'Content-Type': 'application/json' });
    if (key.startsWith('eyJ')) headers = headers.set('Authorization', `Bearer ${key}`);
    try {
      const result = await firstValueFrom(this.http.post<BackendResult<T>>(url, { ...data, token: this.token }, { headers }).pipe(timeout(timeoutMs)));
      return result && typeof result.status === 'number' ? result : null;
    } catch {
      return null;
    }
  }

  /**
   * Igual que callFunction, pero recibe la respuesta en partes (streaming, eventos "data: {json}").
   * Devuelve false si no pudo conectarse, para que la app use el respaldo local.
   */
  async streamFunction(name: string, data: Params, onEvent: (event: any) => void, timeoutMs = 70000): Promise<boolean> {
    if (this.mode !== 'supabase' || typeof fetch === 'undefined') return false;
    const key = environment.supabaseKey;
    const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
    if (key.startsWith('eyJ')) headers['Authorization'] = `Bearer ${key}`;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const res = await fetch(environment.supabaseUrl.replace(/\/$/, '') + '/functions/v1/' + name, {
        method: 'POST', headers, body: JSON.stringify({ ...data, token: this.token }), signal: abort.signal,
      });
      if (!res.ok || !res.body || !(res.headers.get('content-type') || '').includes('event-stream')) return false;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try { onEvent(JSON.parse(line.slice(5))); } catch { /* evento incompleto */ }
          }
        }
      }
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Descarga un archivo: en PHP abre la URL; en Supabase recibe base64 y lo guarda. */
  /** Trae el archivo guardado (para verlo en la app). En modo PHP devuelve null y se abre en otra pestaña. */
  async fetchFile(module: string, params: Record<string, string | number>, action = 'download'): Promise<File | null> {
    if (this.mode === 'php') return null;
    const result = await this.call<{ filename: string; mime: string; content_base64: string; message?: string }>(
      `${module}/${action}.php`, 'GET', params, 60000);
    if (result.status !== 200) throw new Error(result.body?.message || 'No se pudo abrir el archivo.');
    const binary = atob(result.body.content_base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], result.body.filename || 'archivo', { type: result.body.mime || 'application/octet-stream' });
  }

  async download(module: string, params: Record<string, string | number>, action = 'download'): Promise<void> {
    if (this.mode === 'php') {
      const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
      window.open(`${this.phpBase}/${module}/${action}.php?${query}`, '_blank', 'noopener');
      return;
    }
    const result = await this.call<{ filename: string; mime: string; content_base64: string; message?: string }>(
      `${module}/${action}.php`, 'GET', params, 60000);
    if (result.status !== 200) throw new Error(result.body?.message || 'No se pudo descargar el archivo.');
    const binary = atob(result.body.content_base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: result.body.mime || 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = result.body.filename || 'archivo';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  private toParams(data: Params): HttpParams {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && value !== null) params = params.set(key, String(value));
    }
    return params;
  }

  private failure<T>(status: number, message: string): BackendResult<T> {
    return { status, body: { message } as T };
  }
}
