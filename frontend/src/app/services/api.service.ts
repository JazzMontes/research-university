/* Envía las operaciones de la plataforma al backend configurado (Supabase o PHP). */
import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { BackendService } from './backend.service';

@Injectable({ providedIn: 'root' })
export class ApiService {
  constructor(private backend: BackendService, private router: Router) {}

  // Sin body es una consulta (GET); con body es una operación (POST), igual que los archivos PHP.
  async request<T>(path: string, params: Record<string, string | number> = {}, body?: object): Promise<T> {
    const method = body ? 'POST' : 'GET';
    const wait = path.startsWith('assistant/') ? 65000 : body && 'file_base64' in body ? 60000 : 15000;
    const result = await this.backend.call<T>(path, method, (body ?? params) as Record<string, unknown>, wait);
    if (result.status >= 200 && result.status < 300) return result.body;
    if (result.status === 401) {
      this.backend.setToken(null);
      await this.router.navigate(['/login'], { replaceUrl: true });
      throw new Error('Tu sesión terminó. Vuelve a iniciar sesión.');
    }
    const message = (result.body as { message?: string } | null)?.message;
    throw new Error(message || 'No se pudo completar la solicitud. Revisa la conexión con la API.');
  }
}
