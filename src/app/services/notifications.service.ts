/* Notificaciones de la campanita: una sola consulta compartida por todas las pantallas. */
import { Injectable, signal } from '@angular/core';
import { ApiService } from './api.service';

export interface AppNotification {
  id: number;
  title: string;
  body?: string | null;
  link?: string | null;
  tone: string;
  read_at?: string | null;
  created_at: string;
}

@Injectable({ providedIn: 'root' })
export class NotificationsService {
  private readonly list = signal<AppNotification[]>([]);
  private readonly count = signal(0);
  readonly items = this.list.asReadonly();
  readonly unread = this.count.asReadonly();
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(private api: ApiService) {}

  /** Empieza a revisar cada minuto (si ya está corriendo, no hace nada). */
  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => { if (document.visibilityState !== 'hidden') void this.refresh(); }, 60000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.list.set([]);
    this.count.set(0);
  }

  async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const result = await this.api.request<{ items: AppNotification[]; unread: number }>('notifications/list.php', {}, {});
      this.list.set(result.items);
      this.count.set(Number(result.unread) || 0);
    } catch { /* Sin conexión: se intenta en el siguiente minuto. */ }
    finally { this.busy = false; }
  }

  async markRead(id?: number): Promise<void> {
    try {
      const result = await this.api.request<{ unread: number }>('notifications/read.php', {}, id ? { notification_id: id } : { all: true });
      this.count.set(Number(result.unread) || 0);
      const now = new Date().toISOString();
      this.list.set(this.list().map(n => (!id || n.id === id) ? { ...n, read_at: n.read_at || now } : n));
    } catch { /* Se volverá a marcar en el siguiente intento. */ }
  }
}
