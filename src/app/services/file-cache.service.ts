import { Injectable } from '@angular/core';
import { BackendService } from './backend.service';
import { Thumb, makeThumb } from './file-render';

export interface FileSource { module: string; id: number; version?: number | null; stamp?: string | number | null; }

/**
 * Guarda en memoria los archivos ya descargados y sus miniaturas, para no pedirlos dos veces
 * (la miniatura y el visor usan el mismo archivo). Las miniaturas de imagen se recuerdan
 * también en el navegador, así la lista carga rápido la próxima vez.
 */
@Injectable({ providedIn: 'root' })
export class FileCacheService {
  private files = new Map<string, Promise<File | null>>();
  private thumbs = new Map<string, Promise<Thumb>>();
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(private backend: BackendService) {}

  key(src: FileSource): string { return `${src.module}:${src.id}:${src.version ?? src.stamp ?? ''}`; }

  file(src: FileSource): Promise<File | null> {
    const key = this.key(src);
    let p = this.files.get(key);
    if (!p) {
      const params: Record<string, number> = src.module === 'proposals' ? { proposal_id: src.id } : { document_id: src.id };
      if (src.version && src.module !== 'proposals') params['version'] = src.version;
      p = this.backend.fetchFile(src.module, params, src.module === 'proposals' ? 'download-file' : 'download');
      p.catch(() => this.files.delete(key));
      this.files.set(key, p);
      // Solo se guardan los últimos 15 archivos en memoria.
      if (this.files.size > 15) this.files.delete(this.files.keys().next().value as string);
    }
    return p;
  }

  thumb(src: FileSource, name: string): Promise<Thumb> {
    const key = this.key(src);
    let p = this.thumbs.get(key);
    if (!p) {
      const stored = this.readStored(key);
      p = stored ? Promise.resolve(stored) : this.limited(async () => {
        const file = await this.file(src);
        const thumb: Thumb = file ? await makeThumb(file, name) : { kind: 'icon' };
        if (thumb.kind === 'img') this.store(key, thumb);
        return thumb;
      });
      p.catch(() => this.thumbs.delete(key));
      this.thumbs.set(key, p);
    }
    return p;
  }

  /** Máximo 2 miniaturas a la vez, para no saturar la conexión. */
  private async limited<T>(job: () => Promise<T>): Promise<T> {
    if (this.running >= 2) await new Promise<void>(resolve => this.waiting.push(resolve));
    this.running++;
    try { return await job(); } finally { this.running--; this.waiting.shift()?.(); }
  }

  private readStored(key: string): Thumb | null {
    try { const v = localStorage.getItem('rv-thumb:' + key); return v ? JSON.parse(v) as Thumb : null; } catch { return null; }
  }
  private store(key: string, thumb: Thumb): void {
    try {
      const index: string[] = JSON.parse(localStorage.getItem('rv-thumb-index') || '[]');
      index.push(key);
      while (index.length > 80) localStorage.removeItem('rv-thumb:' + index.shift());
      localStorage.setItem('rv-thumb:' + key, JSON.stringify(thumb));
      localStorage.setItem('rv-thumb-index', JSON.stringify(index));
    } catch { /* sin espacio: no pasa nada */ }
  }
}
