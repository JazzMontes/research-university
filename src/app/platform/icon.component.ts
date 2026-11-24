/*
 * Íconos de la app (trazo fino, estilo "outline"). Se dibujan aquí mismo, sin descargar nada.
 * Uso: <app-icon name="trash"></app-icon>   ·   tamaño opcional: [size]="20"
 */
import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-icon',
  standalone: true,
  template: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" [attr.width]="size" [attr.height]="size">
    @switch (name) {
      @case ('home') { <svg:path d="M3 10.5 12 3l9 7.5"/><svg:path d="M5 9.5V21h14V9.5"/><svg:path d="M9.5 21v-6h5v6"/> }
      @case ('proposal') { <svg:path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><svg:path d="M14 3v6h6"/><svg:path d="M8 13h8M8 17h5"/> }
      @case ('folder') { <svg:path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/> }
      @case ('users') { <svg:circle cx="9" cy="8" r="3.5"/><svg:path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><svg:path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/> }
      @case ('book') { <svg:path d="M3 5h6a3 3 0 0 1 3 3v12a2.5 2.5 0 0 0-2.5-2.5H3z"/><svg:path d="M21 5h-6a3 3 0 0 0-3 3v12a2.5 2.5 0 0 1 2.5-2.5H21z"/> }
      @case ('sparkles') { <svg:path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z"/><svg:path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/> }
      @case ('user') { <svg:circle cx="12" cy="8" r="4"/><svg:path d="M4 21a8 8 0 0 1 16 0"/> }
      @case ('logout') { <svg:path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><svg:path d="M10 17l-5-5 5-5M5 12h11"/> }
      @case ('bell') { <svg:path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><svg:path d="M10.3 20a2 2 0 0 0 3.4 0"/> }
      @case ('plus') { <svg:path d="M12 5v14M5 12h14"/> }
      @case ('edit') { <svg:path d="M4 20h4L19 9l-4-4L4 16z"/><svg:path d="M13.5 6.5l4 4"/> }
      @case ('trash') { <svg:path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/> }
      @case ('x') { <svg:path d="M6 6l12 12M18 6 6 18"/> }
      @case ('check') { <svg:path d="M5 12.5l4.5 4.5L19 7"/> }
      @case ('download') { <svg:path d="M12 4v11M7 10l5 5 5-5"/><svg:path d="M5 20h14"/> }
      @case ('upload') { <svg:path d="M12 20V9M7 14l5-5 5 5"/><svg:path d="M5 4h14"/> }
      @case ('send') { <svg:path d="M4 12 20 4l-6 16-3-7z"/><svg:path d="M11 13l9-9"/> }
      @case ('clip') { <svg:path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/> }
      @case ('search') { <svg:circle cx="11" cy="11" r="7"/><svg:path d="M20 20l-4-4"/> }
      @case ('clock') { <svg:circle cx="12" cy="12" r="9"/><svg:path d="M12 7v5l3 2"/> }
      @case ('calendar') { <svg:rect x="3" y="5" width="18" height="16" rx="2"/><svg:path d="M3 10h18M8 3v4M16 3v4"/> }
      @case ('alert') { <svg:path d="M10.3 4 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z"/><svg:path d="M12 9v4M12 17h.01"/> }
      @case ('refresh') { <svg:path d="M4 12a8 8 0 0 1 14-5.3L20 9"/><svg:path d="M20 4v5h-5"/><svg:path d="M20 12a8 8 0 0 1-14 5.3L4 15"/><svg:path d="M4 20v-5h5"/> }
      @case ('ban') { <svg:circle cx="12" cy="12" r="9"/><svg:path d="M5.6 5.6l12.8 12.8"/> }
      @case ('user-plus') { <svg:circle cx="9" cy="8" r="4"/><svg:path d="M2 21a7 7 0 0 1 14 0"/><svg:path d="M19 8v6M16 11h6"/> }
      @case ('user-minus') { <svg:circle cx="9" cy="8" r="4"/><svg:path d="M2 21a7 7 0 0 1 14 0"/><svg:path d="M16 11h6"/> }
      @case ('swap') { <svg:path d="M7 4 3 8l4 4"/><svg:path d="M3 8h14"/><svg:path d="M17 20l4-4-4-4"/><svg:path d="M21 16H7"/> }
      @case ('star') { <svg:path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/> }
      @case ('key') { <svg:circle cx="8" cy="15" r="4"/><svg:path d="M11 12l9-9M17 6l3 3M15 8l2 2"/> }
      @case ('copy') { <svg:rect x="9" y="9" width="12" height="12" rx="2"/><svg:path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/> }
      @case ('lock') { <svg:rect x="5" y="11" width="14" height="10" rx="2"/><svg:path d="M8 11V7a4 4 0 0 1 8 0v4"/> }
      @case ('flag') { <svg:path d="M5 21V4"/><svg:path d="M5 4h12l-2.5 4L17 12H5"/> }
      @case ('tasks') { <svg:path d="M3 6l2 2 3-3M3 13l2 2 3-3"/><svg:path d="M11 7h10M11 14h10M4 20h17"/> }
      @case ('chart') { <svg:path d="M3 3v18h18"/><svg:path d="M7 16v-4M12 16V8M17 16v-7"/> }
      @case ('chat') { <svg:path d="M4 5h16v11H9l-5 4z"/><svg:path d="M8 9.5h8M8 12.5h5"/> }
      @case ('menu') { <svg:path d="M4 7h16M4 12h16M4 17h16"/> }
      @case ('back') { <svg:path d="M15 5l-7 7 7 7"/> }
      @case ('next') { <svg:path d="M9 5l7 7-7 7"/> }
      @case ('mail') { <svg:rect x="3" y="5" width="18" height="14" rx="2"/><svg:path d="M3 7l9 6 9-6"/> }
      @case ('printer') { <svg:path d="M6 9V3h12v6"/><svg:rect x="3" y="9" width="18" height="8" rx="2"/><svg:path d="M7 14h10v7H7z"/> }
      @case ('camera') { <svg:path d="M4 8h3l2-3h6l2 3h3v11H4z"/><svg:circle cx="12" cy="13" r="3.5"/> }
      @case ('file') { <svg:path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><svg:path d="M14 3v6h6"/> }
      @case ('eye') { <svg:path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><svg:circle cx="12" cy="12" r="3"/> }
      @case ('eye-off') { <svg:path d="M3 3l18 18M10.6 5.1A9.8 9.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/> }
      @case ('review') { <svg:path d="M9 11l2 2 4-4"/><svg:path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><svg:path d="M14 3v6h6"/> }
      @case ('flag-done') { <svg:path d="M5 21V4"/><svg:path d="M5 4h12l-2.5 4L17 12H5"/><svg:path d="M15 17l2 2 4-4"/> }
      @case ('shield') { <svg:path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/> }
      @case ('info') { <svg:circle cx="12" cy="12" r="9"/><svg:path d="M12 11v5M12 8h.01"/> }
      @default { <svg:circle cx="12" cy="12" r="3"/> }
    }
  </svg>`,
  styles: [`:host { display: inline-flex; align-items: center; justify-content: center; vertical-align: -0.2em; flex-shrink: 0; line-height: 0; }
    svg { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }`],
})
export class IconComponent {
  @Input() name = '';
  @Input() size: number | string = 18;
}
