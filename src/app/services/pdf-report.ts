/*
 * Reporte de proyectos en PDF, generado en el navegador sin librerías externas.
 * Usa las fuentes estándar de PDF (Helvetica) con acentos y ñ (codificación WinAnsi).
 */

type RGB = [number, number, number];
type Row = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const GREEN: RGB = [0.086, 0.294, 0.278];
const MINT: RGB = [0.871, 0.937, 0.922];
const INK: RGB = [0.09, 0.17, 0.16];
const MUTED: RGB = [0.39, 0.48, 0.45];
const LINE: RGB = [0.86, 0.91, 0.89];

/** Colores de estado (amarillo, azul, verde, rojo) igual que en la app. */
const TONES: Record<string, { bg: RGB; fg: RGB }> = {
  progress: { bg: [1, 0.95, 0.72], fg: [0.42, 0.33, 0.06] },
  changes: { bg: [0.86, 0.91, 1], fg: [0.11, 0.31, 0.57] },
  done: { bg: [0.85, 0.95, 0.88], fg: [0.11, 0.42, 0.23] },
  cancelled: { bg: [1, 0.86, 0.86], fg: [0.56, 0.18, 0.18] },
  neutral: { bg: [0.91, 0.94, 0.93], fg: [0.3, 0.38, 0.36] },
};

// Anchos de letra de Helvetica y Helvetica-Bold (en milésimas), caracteres 32 a 126.
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

const WIN_ANSI: Record<string, number> = { '€': 128, '‚': 130, '„': 132, '…': 133, '‘': 145, '’': 146, '“': 147, '”': 148, '•': 149, '–': 150, '—': 151, '™': 153 };

type Font = 'F1' | 'F2' | 'F3';

class PdfWriter {
  readonly width = 612;   // Carta
  readonly height = 792;
  readonly margin = 46;
  private pages: string[] = [];
  private ops: string[] = [];
  y = 0;

  constructor(private footer: string) { this.addPage(); }

  addPage(): void {
    if (this.ops.length) this.pages.push(this.ops.join('\n'));
    this.ops = [];
    this.y = this.height - this.margin;
  }

  /** Si no cabe la altura pedida, empieza una página nueva. */
  ensure(h: number): boolean {
    if (this.y - h < this.margin + 24) { this.addPage(); return true; }
    return false;
  }

  textWidth(text: string, size: number, font: Font = 'F1'): number {
    const widths = font === 'F2' ? W_BOLD : W_REG;
    let total = 0;
    for (const ch of text.normalize('NFD').replace(/[̀-ͯ]/g, '')) {
      const code = ch.charCodeAt(0);
      total += code >= 32 && code <= 126 ? widths[code - 32] : 556;
    }
    return total * size / 1000;
  }

  wrap(text: string, maxWidth: number, size: number, font: Font = 'F1'): string[] {
    const out: string[] = [];
    for (const paragraph of String(text ?? '').replace(/\r/g, '').split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const test = line ? line + ' ' + word : word;
        if (this.textWidth(test, size, font) <= maxWidth) { line = test; continue; }
        if (line) out.push(line);
        // Palabra más larga que la línea: se corta.
        let rest = word;
        while (this.textWidth(rest, size, font) > maxWidth && rest.length > 1) {
          let cut = rest.length;
          while (cut > 1 && this.textWidth(rest.slice(0, cut), size, font) > maxWidth) cut--;
          out.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
      }
      out.push(line);
    }
    return out.length ? out : [''];
  }

  private encode(text: string): string {
    let out = '';
    for (const ch of text) {
      let code = WIN_ANSI[ch] ?? ch.charCodeAt(0);
      if (code > 255) code = 63; // "?"
      if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
      else if (code < 32 || code > 126) out += '\\' + code.toString(8).padStart(3, '0');
      else out += ch;
    }
    return out;
  }

  private color(c: RGB, stroke = false): string { return `${c.map(v => v.toFixed(3)).join(' ')} ${stroke ? 'RG' : 'rg'}`; }

  text(x: number, y: number, text: string, size = 10, font: Font = 'F1', color: RGB = INK): void {
    this.ops.push(`BT /${font} ${size} Tf ${this.color(color)} ${x.toFixed(2)} ${y.toFixed(2)} Td (${this.encode(text)}) Tj ET`);
  }

  rect(x: number, y: number, w: number, h: number, fill: RGB, stroke?: RGB): void {
    this.ops.push(`${this.color(fill)} ${stroke ? this.color(stroke, true) + ' 0.6 w ' : ''}${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${stroke ? 'B' : 'f'}`);
  }

  line(x1: number, y1: number, x2: number, y2: number, color: RGB = LINE, width = 0.6): void {
    this.ops.push(`${this.color(color, true)} ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }

  /** Etiqueta de color con texto (como los estados de la app). */
  badge(x: number, y: number, label: string, tone: string, size = 8): number {
    const t = TONES[tone] || TONES['neutral'];
    const w = this.textWidth(label, size, 'F2') + 12;
    this.rect(x, y - 3.5, w, size + 6, t.bg);
    this.text(x + 6, y, label, size, 'F2', t.fg);
    return w;
  }

  // ---------- bloques de alto nivel ----------
  get contentWidth(): number { return this.width - this.margin * 2; }

  heading(title: string): void {
    this.ensure(90); // Un título nunca queda solo al final de la página.
    this.y -= 14;
    this.text(this.margin, this.y, title, 13, 'F2', GREEN);
    this.y -= 6;
    this.line(this.margin, this.y, this.width - this.margin, this.y, GREEN, 1.2);
    this.y -= 12;
  }

  paragraph(text: string, size = 10, color: RGB = INK, font: Font = 'F1'): void {
    for (const line of this.wrap(text, this.contentWidth, size, font)) {
      this.ensure(size + 4);
      this.text(this.margin, this.y, line, size, font, color);
      this.y -= size + 4;
    }
    this.y -= 4;
  }

  /**
   * Tabla con encabezado verde, filas alternadas y texto que se ajusta.
   * Si una columna tiene "tone", esa celda se dibuja como etiqueta de color.
   */
  table(columns: { title: string; width: number }[], rows: { cells: string[]; tones?: (string | null)[] }[], empty = 'Sin registros.'): void {
    const size = 9, pad = 5, lineH = 11.5;
    const total = columns.reduce((s, c) => s + c.width, 0);
    const widths = columns.map(c => c.width / total * this.contentWidth);
    const header = () => {
      this.rect(this.margin, this.y - 16, this.contentWidth, 18, GREEN);
      let x = this.margin;
      columns.forEach((c, i) => { this.text(x + pad, this.y - 10.5, c.title, size, 'F2', [1, 1, 1]); x += widths[i]; });
      this.y -= 18;
    };
    this.ensure(40);
    header();
    if (!rows.length) { this.y -= 14; this.text(this.margin + pad, this.y + 2, empty, size, 'F3', MUTED); this.y -= 8; return; }
    rows.forEach((row, r) => {
      const wrapped = row.cells.map((cell, i) => row.tones?.[i] ? [cell] : this.wrap(cell, widths[i] - pad * 2, size));
      const h = Math.max(...wrapped.map(l => l.length)) * lineH + pad * 2 - 2;
      if (this.ensure(h + 4)) header();
      if (r % 2 === 1) this.rect(this.margin, this.y - h, this.contentWidth, h, [0.965, 0.98, 0.972]);
      let x = this.margin;
      wrapped.forEach((lines, i) => {
        const tone = row.tones?.[i];
        if (tone) this.badge(x + pad, this.y - pad - 8, lines[0], tone, 7.5);
        else lines.forEach((l, k) => this.text(x + pad, this.y - pad - 8 - k * lineH, l, size));
        x += widths[i];
      });
      this.y -= h;
      this.line(this.margin, this.y, this.width - this.margin, this.y);
    });
    this.y -= 10;
  }

  /** Cuadros de resumen con número grande y barra de avance opcional. */
  summary(items: { label: string; value: string; percent?: number }[]): void {
    const gap = 10, h = 54;
    const w = (this.contentWidth - gap * (items.length - 1)) / items.length;
    this.ensure(h + 10);
    items.forEach((item, i) => {
      const x = this.margin + i * (w + gap);
      this.rect(x, this.y - h, w, h, [0.965, 0.98, 0.972], LINE);
      this.text(x + 10, this.y - 24, item.value, 18, 'F2', GREEN);
      this.text(x + 10, this.y - 38, item.label, 8, 'F1', MUTED);
      if (item.percent !== undefined) {
        this.rect(x + 10, this.y - 48, w - 20, 4, LINE);
        this.rect(x + 10, this.y - 48, (w - 20) * Math.max(0, Math.min(100, item.percent)) / 100, 4, [0.157, 0.463, 0.384]);
      }
    });
    this.y -= h + 14;
  }

  /** Arma el archivo PDF (objetos, tabla xref) y lo devuelve como bytes. */
  build(): Uint8Array {
    this.pages.push(this.ops.join('\n'));
    this.ops = [];
    const n = this.pages.length;
    // Pie de página con número de página en cada hoja.
    const streams = this.pages.map((content, i) => {
      const foot = `${this.footer}   ·   Página ${i + 1} de ${n}`;
      const footOps = [
        `${this.color(LINE, true)} 0.6 w ${this.margin} 34 m ${this.width - this.margin} 34 l S`,
        `BT /F1 8 Tf ${this.color(MUTED)} ${this.margin} 22 Td (${this.encode(foot)}) Tj ET`,
      ];
      return content + '\n' + footOps.join('\n');
    });
    const objects: string[] = [];
    // 1 catálogo · 2 páginas · 3-5 fuentes · luego página + contenido por hoja
    const pageIds = streams.map((_, i) => 6 + i * 2);
    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[2] = `<< /Type /Pages /Count ${n} /Kids [${pageIds.map(id => id + ' 0 R').join(' ')}] >>`;
    objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
    objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>';
    streams.forEach((stream, i) => {
      const pageId = pageIds[i];
      objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.width} ${this.height}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
      objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    });
    let pdf = '%PDF-1.4\n%âãÏÓ\n';
    const offsets: number[] = [];
    for (let id = 1; id < objects.length; id++) {
      offsets[id] = pdf.length;
      pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id++) pdf += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
    pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const bytes = new Uint8Array(pdf.length);
    for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
    return bytes;
  }

  // Encabezado de color de la primera página de cada proyecto.
  banner(title: string, subtitle: string): void {
    this.rect(0, this.height - 92, this.width, 92, GREEN);
    this.text(this.margin, this.height - 40, 'RESEARCH UNIVERSITY', 9, 'F2', [0.64, 0.78, 0.74]);
    const lines = this.wrap(title, this.contentWidth, 18, 'F2').slice(0, 2);
    lines.forEach((l, i) => this.text(this.margin, this.height - 62 - i * 20, l, 18, 'F2', [1, 1, 1]));
    this.y = this.height - 92 - 22;
    this.text(this.margin, this.y, subtitle, 9, 'F1', MUTED);
    this.y -= 18;
  }
}

export interface ReportLabels {
  projectStatus: (s: string) => { label: string; tone: string };
  activityStatus: (s: string) => { label: string; tone: string };
  milestoneStatus: (s: string) => { label: string; tone: string };
  role: (r: string) => string;
  date: (d: unknown) => string;
}

/** Arma el PDF del reporte (bytes y nombre de archivo). */
export function createReportPdf(data: Row, t: ReportLabels): { bytes: Uint8Array; name: string } {
  const generated = `Generado por ${data.generated_by || ''} el ${t.date(data.generated_at)}`;
  const projects: Row[] = data.projects || [];
  const pdf = new PdfWriter('Research University · Reporte de seguimiento');

  if (projects.length > 1) {
    // Portada del reporte general con la tabla de todos los proyectos.
    pdf.banner('Reporte general de proyectos', generated);
    const open = projects.filter(p => ['active', 'changes', 'closing'].includes(p.status)).length;
    const done = projects.filter(p => p.status === 'finalized').length;
    const avg = Math.round(projects.reduce((s, p) => s + Number(p.progress || 0), 0) / projects.length);
    pdf.summary([
      { label: 'Proyectos', value: String(projects.length) },
      { label: 'En curso', value: String(open) },
      { label: 'Completados', value: String(done) },
      { label: 'Avance promedio', value: `${avg} %`, percent: avg },
    ]);
    pdf.heading('Resumen');
    pdf.table([{ title: 'Proyecto', width: 40 }, { title: 'Responsable', width: 24 }, { title: 'Avance', width: 12 }, { title: 'Estado', width: 24 }],
      projects.map(p => {
        const st = t.projectStatus(p.status);
        return { cells: [p.title, p.researcher_name || '', `${p.progress ?? 0} %`, st.label], tones: [null, null, null, st.tone] };
      }));
  }

  projects.forEach((p, index) => {
    if (projects.length > 1 || index > 0) pdf.addPage();
    const st = t.projectStatus(p.status);
    pdf.banner(p.title, generated);
    let x = pdf.margin;
    x += pdf.badge(x, pdf.y, st.label, st.tone, 9) + 10;
    pdf.text(x, pdf.y, `Responsable: ${p.researcher_name || '—'}`, 10, 'F1', INK);
    pdf.y -= 16;
    pdf.text(pdf.margin, pdf.y, `Inicio: ${t.date(p.start_date)}     Término: ${t.date(p.end_date)}`, 9, 'F1', MUTED);
    pdf.y -= 20;
    if (p.status_note) pdf.paragraph(`Nota: ${p.status_note}`, 9, MUTED, 'F3');

    const progress = Number(p.progress || 0);
    pdf.summary([
      { label: 'Avance general', value: `${progress} %`, percent: progress },
      { label: 'Actividades completadas', value: `${p.completed_activities ?? 0} / ${p.total_activities ?? 0}` },
      { label: 'Hitos alcanzados', value: `${p.achieved_milestones ?? 0} / ${p.total_milestones ?? 0}` },
      { label: 'Actividades retrasadas', value: String(p.overdue_activities ?? 0) },
    ]);

    if (p.description) { pdf.heading('Descripción'); pdf.paragraph(p.description); }
    if (p.objectives) { pdf.heading('Objetivos'); pdf.paragraph(p.objectives); }

    pdf.heading('Equipo');
    pdf.table([{ title: 'Nombre', width: 40 }, { title: 'Rol en el proyecto', width: 40 }, { title: 'Estado', width: 20 }],
      (p.participants || []).map((m: Row) => ({
        cells: [m.name, m.project_role || t.role(m.role), Number(m.is_active) ? 'Activo' : 'Retirado'],
        tones: [null, null, Number(m.is_active) ? 'done' : 'neutral'],
      })), 'Sin integrantes.');

    // Plan de trabajo: cada hito con sus actividades, y al final las que no tienen hito.
    pdf.heading('Hitos y actividades');
    const activities: Row[] = p.activities || [];
    const milestones: Row[] = p.milestones || [];
    const activityRows = (items: Row[]) => items.map((a: Row) => {
      const s = t.activityStatus(a.status);
      const late = a.deadline_status === 'Retrasada' ? ' (retrasada)' : '';
      return { cells: [a.description, a.participant_name || '', t.date(a.deadline) + late, s.label], tones: [null, null, null, s.tone] };
    });
    const cols = [{ title: 'Actividad', width: 42 }, { title: 'Responsable', width: 22 }, { title: 'Fecha límite', width: 15 }, { title: 'Estado', width: 21 }];
    for (const m of milestones) {
      const s = t.milestoneStatus(m.status);
      pdf.ensure(70);
      pdf.paragraph(`Hito: ${m.description}  ·  meta ${t.date(m.target_date)}  ·  ${m.completed_count ?? 0} de ${m.activity_count ?? 0} completadas  ·  ${s.label}`, 10, GREEN, 'F2');
      pdf.table(cols, activityRows(activities.filter(a => Number(a.milestone_id) === Number(m.id))), 'Este hito todavía no tiene actividades.');
    }
    const loose = activities.filter(a => !a.milestone_id);
    if (loose.length || !milestones.length) {
      if (milestones.length) pdf.paragraph('Actividades sin hito', 10, GREEN, 'F2');
      pdf.table(cols, activityRows(loose), 'Sin actividades registradas.');
    }

    pdf.heading('Documentos');
    pdf.table([{ title: 'Documento', width: 64 }, { title: 'Tipo', width: 22 }, { title: 'Versión', width: 14 }],
      (p.documents || []).map((d: Row) => ({ cells: [d.title, d.kind === 'evidence' ? 'Evidencia' : 'Documento', `v${d.version ?? 1}`] })),
      'Sin documentos.');

    const closures: Row[] = p.closures || [];
    if (closures.length) {
      pdf.heading('Solicitudes de cierre');
      pdf.table([{ title: 'Fecha', width: 18 }, { title: 'Resultado', width: 22 }, { title: 'Observaciones', width: 60 }],
        closures.map(c => ({
          cells: [t.date(c.created_at), c.status === 'approved' ? 'Aprobado' : c.status === 'pending' ? 'Pendiente' : 'Cambios pedidos',
            [c.observations, c.review_observations].filter(Boolean).join(' · ') || '—'],
          tones: [null, c.status === 'approved' ? 'done' : c.status === 'pending' ? 'progress' : 'changes', null],
        })));
    }
  });

  const bytes = pdf.build();
  const slug = projects.length === 1
    ? 'reporte-' + String(projects[0].title).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 60)
    : 'reporte-general';
  return { bytes, name: `${slug || 'reporte'}.pdf` };
}

/** Crea el PDF del reporte y lo descarga. */
export function downloadReportPdf(data: Row, t: ReportLabels): void {
  const { bytes, name } = createReportPdf(data, t);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
