/*
 * Miniatura de un archivo guardado (como en el explorador de archivos):
 * foto, primera página del PDF o del Word, primera diapositiva o inicio de la hoja de Excel.
 * Se carga solo cuando la miniatura aparece en pantalla.
 * Uso: <app-file-thumb module="documents" [id]="d.id" [version]="d.version" [name]="d.filename"></app-file-thumb>
 */
import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, Input, OnChanges, OnDestroy } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { FileCacheService } from '../services/file-cache.service';
import { Thumb, extOf } from '../services/file-render';

const COLORS: Record<string, string> = { pdf: '#c0392b', doc: '#2b5797', docx: '#2b5797', xls: '#1e7145', xlsx: '#1e7145', csv: '#1e7145',
  ppt: '#d24726', pptx: '#d24726', txt: '#5b6b68', md: '#5b6b68' };

@Component({
  selector: 'app-file-thumb',
  standalone: true,
  template: `<span class="ft" [class.small]="small" [title]="name">
    @if (thumb?.kind === 'img') {
      <img [src]="imgSrc" alt="" [style.object-fit]="imgFit">
    } @else if (thumb?.kind === 'html') {
      <span class="ft-page" [style.width.px]="pageW" [style.height.px]="pageH" [style.transform]="'scale(' + scale + ')'"
        [style.top.px]="offsetTop" [innerHTML]="html"></span>
    } @else {
      <span class="ft-icon" [class.loading]="loading">
        <svg viewBox="0 0 40 50" aria-hidden="true"><path d="M4 2h22l10 10v34a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="#fff" stroke="#c9d3d1"/><path d="M26 2v10h10" fill="#eef2f1" stroke="#c9d3d1"/></svg>
        <b [style.background]="color">{{ ext.toUpperCase() || 'ARCH' }}</b>
      </span>
    }
    @if (thumb?.kind !== 'icon' && thumb && !small) { <b class="ft-badge" [style.background]="color">{{ ext.toUpperCase() }}</b> }
  </span>`,
  styles: [`
    :host { display: inline-block; flex-shrink: 0; line-height: 0; }
    .ft { position: relative; display: block; width: 64px; height: 80px; border-radius: 8px; overflow: hidden; background: #fff;
      border: 1px solid #d7e0de; box-shadow: 0 1px 3px #0001; }
    .ft.small { width: 44px; height: 56px; border-radius: 6px; }
    img { width: 100%; height: 100%; display: block; background: #f4f6f5; }
    .ft-page { position: absolute; left: 0; transform-origin: 0 0; background: #fff; pointer-events: none; overflow: hidden; line-height: normal; }
    .ft-icon { position: absolute; inset: 0; display: grid; place-items: center; background: #f7f9f8; }
    .ft-icon svg { width: 62%; height: 78%; }
    .ft-icon b { position: absolute; bottom: 18%; left: 50%; transform: translateX(-50%); color: #fff; font: 700 9px/1 Arial, sans-serif;
      padding: 3px 5px; border-radius: 3px; letter-spacing: .3px; }
    .ft-icon.loading svg { animation: ft-pulse 1.2s ease-in-out infinite; }
    @keyframes ft-pulse { 50% { opacity: .45; } }
    .ft-badge { position: absolute; right: 3px; bottom: 3px; color: #fff; font: 700 8px/1 Arial, sans-serif; padding: 2px 4px; border-radius: 3px; line-height: 1; }
  `],
})
export class FileThumbComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() module = 'documents';
  @Input() id = 0;
  @Input() version?: number | null;
  @Input() stamp?: string | number | null;
  @Input() name = '';
  @Input() small = false;

  thumb?: Thumb;
  loading = false;
  html?: SafeHtml;
  imgSrc = '';
  imgFit = 'cover';
  pageW = 0; pageH = 0; scale = 1; offsetTop = 0;
  private observer?: IntersectionObserver;
  private visible = false;
  private loadedKey = '';

  constructor(private cache: FileCacheService, private host: ElementRef<HTMLElement>, private sanitizer: DomSanitizer,
    private changeDetector: ChangeDetectorRef) {}

  get ext(): string { return extOf(this.name); }
  get color(): string { return COLORS[this.ext] || '#5b6b68'; }

  ngAfterViewInit(): void {
    if (typeof IntersectionObserver === 'undefined') { this.visible = true; void this.load(); return; }
    this.observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { this.visible = true; this.observer?.disconnect(); void this.load(); }
    }, { rootMargin: '200px' });
    this.observer.observe(this.host.nativeElement);
  }
  ngOnChanges(): void { if (this.visible) void this.load(); }
  ngOnDestroy(): void { this.observer?.disconnect(); }

  private async load(): Promise<void> {
    const src = { module: this.module, id: this.id, version: this.version, stamp: this.stamp };
    const key = this.cache.key(src);
    if (!this.id || key === this.loadedKey) return;
    this.loadedKey = key;
    this.loading = true;
    this.changeDetector.markForCheck();
    try {
      const thumb = await this.cache.thumb(src, this.name);
      if (key !== this.loadedKey) return;
      const box = this.small ? { w: 44, h: 56 } : { w: 64, h: 80 };
      if (thumb.kind === 'img') { this.imgSrc = thumb.src; this.imgFit = thumb.fit || 'cover'; }
      if (thumb.kind === 'html') {
        this.pageW = thumb.width; this.pageH = thumb.height;
        // Documentos verticales: se ve la parte de arriba de la hoja. Diapositivas/hojas: centradas.
        this.scale = box.w / thumb.width;
        this.offsetTop = thumb.flavor === 'docx' || thumb.flavor === 'text' ? 0 : Math.max(0, (box.h - thumb.height * this.scale) / 2);
        if (thumb.flavor === 'xlsx' || thumb.flavor === 'csv') { this.scale = box.w / 360; this.offsetTop = 0; }
        this.html = this.sanitizer.bypassSecurityTrustHtml(thumb.html);
      }
      this.thumb = thumb;
    } catch {
      this.thumb = { kind: 'icon' };
    } finally {
      this.loading = false;
      this.changeDetector.markForCheck();
    }
  }
}
