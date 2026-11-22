/*
 * Vista previa de archivos con su formato, sin librerías externas (salvo pdf.js, que va en assets/pdfjs).
 *  - Word (.docx): párrafos, títulos, negritas/cursivas/subrayado, tamaños, colores, alineación,
 *    viñetas y numeración, tablas e imágenes.
 *  - Excel (.xlsx): hojas con celdas combinadas, negritas, colores de letra y relleno, bordes,
 *    anchos de columna y formatos de número/fecha/porcentaje.
 *  - PowerPoint (.pptx): diapositivas con cuadros de texto, imágenes y fondos en su posición.
 *  - PDF: páginas dibujadas con pdf.js.  - CSV: tabla.  - Texto: tal cual.
 * Todo el texto se escapa; solo se generan etiquetas y estilos propios (no se copia HTML del archivo).
 */

export type FullRender =
  | { kind: 'image'; src: string }
  | { kind: 'pdf'; pages: string[]; total: number }
  | { kind: 'doc'; html: string; flavor: 'docx' | 'pptx' | 'text' | 'csv'; width?: number }
  | { kind: 'sheets'; sheets: { name: string; html: string }[] }
  | { kind: 'other' };

export type Thumb =
  | { kind: 'img'; src: string; fit?: 'cover' | 'contain' }
  | { kind: 'html'; html: string; width: number; height: number; flavor: string }
  | { kind: 'icon' };

export const extOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name || '')?.[1] || '').toLowerCase();
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const hex = (v: string | null | undefined) => {
  if (!v) return '';
  const m = /^(?:[0-9a-f]{2})?([0-9a-f]{6})$/i.exec(v.trim());
  return m ? '#' + m[1].toLowerCase() : '';
};
const fontCss = (name?: string | null) => {
  const clean = (name || '').replace(/[^\w \-]/g, '').trim();
  return (clean ? `'${clean}', ` : '') + 'Calibri, Carlito, Aptos, Arial, Helvetica, sans-serif';
};
const kids = (el: Element | null | undefined, name?: string) => el ? Array.from(el.children).filter(c => !name || c.nodeName === name) : [];
const kid = (el: Element | null | undefined, name: string) => kids(el, name)[0] || null;
const deep = (el: Element | null | undefined, name: string) => el ? Array.from(el.getElementsByTagName(name)) : [];
const val = (el: Element | null | undefined, attr = 'w:val') => el?.getAttribute(attr) ?? null;
const num = (v: string | null | undefined, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const xml = (text: string | null) => text ? new DOMParser().parseFromString(text, 'application/xml') : null;
const mimeOf = (path: string) => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' } as Record<string, string>)[extOf(path)] || '';

function toDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

/** Ruta relativa dentro del ZIP (p. ej. "word/" + "../media/a.png"). */
function joinPath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (base + target).split('/');
  const out: string[] = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); }
  return out.join('/');
}

// ---------------------------------------------------------------------------
// Lector de ZIP (los archivos de Office son ZIP)
// ---------------------------------------------------------------------------
class Zip {
  private entries = new Map<string, { method: number; start: number; size: number }>();
  private constructor(private buf: Uint8Array) {}
  static open(buf: Uint8Array): Zip | null {
    const zip = new Zip(buf);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const count = view.getUint16(eocd + 10, true);
    let ptr = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder();
    for (let n = 0; n < count && ptr + 46 <= buf.length; n++) {
      if (view.getUint32(ptr, true) !== 0x02014b50) break;
      const method = view.getUint16(ptr + 10, true);
      const size = view.getUint32(ptr + 20, true);
      const nameLen = view.getUint16(ptr + 28, true);
      const extraLen = view.getUint16(ptr + 30, true);
      const commentLen = view.getUint16(ptr + 32, true);
      const local = view.getUint32(ptr + 42, true);
      const name = decoder.decode(buf.subarray(ptr + 46, ptr + 46 + nameLen));
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      zip.entries.set(name, { method, start, size });
      ptr += 46 + nameLen + extraLen + commentLen;
    }
    return zip;
  }
  has(name: string): boolean { return this.entries.has(name); }
  names(): string[] { return Array.from(this.entries.keys()); }
  async bytes(name: string): Promise<Uint8Array | null> {
    const e = this.entries.get(name);
    if (!e) return null;
    const data = this.buf.slice(e.start, e.start + e.size);
    if (e.method === 0) return data;
    if (e.method !== 8 || typeof DecompressionStream === 'undefined') return null;
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async text(name: string): Promise<string | null> {
    const b = await this.bytes(name);
    return b ? new TextDecoder().decode(b) : null;
  }
  async xml(name: string): Promise<Document | null> { return xml(await this.text(name)); }
  /** Relaciones (r:id → destino) de una parte, p. ej. word/document.xml. */
  async rels(part: string): Promise<Map<string, { target: string; external: boolean }>> {
    const slash = part.lastIndexOf('/');
    const dir = part.slice(0, slash + 1);
    const doc = await this.xml(`${dir}_rels/${part.slice(slash + 1)}.rels`);
    const map = new Map<string, { target: string; external: boolean }>();
    for (const r of deep(doc?.documentElement, 'Relationship')) {
      const external = r.getAttribute('TargetMode') === 'External';
      const target = r.getAttribute('Target') || '';
      map.set(r.getAttribute('Id') || '', { target: external ? target : joinPath(dir, target), external });
    }
    return map;
  }
  async image(path: string): Promise<string> {
    const mime = mimeOf(path);
    if (!mime) return '';
    const b = await this.bytes(path);
    return b ? toDataUrl(b, mime) : '';
  }
}

/** Colores del tema (Office): lt1, dk1, lt2, dk2, accent1..6, hlink. */
async function themeColors(zip: Zip, path: string): Promise<Record<string, string>> {
  const doc = await zip.xml(path);
  const out: Record<string, string> = {};
  const scheme = deep(doc?.documentElement, 'a:clrScheme')[0];
  for (const c of kids(scheme)) {
    const name = c.nodeName.replace('a:', '');
    const srgb = kid(c, 'a:srgbClr'); const sys = kid(c, 'a:sysClr');
    out[name] = hex(srgb?.getAttribute('val') || sys?.getAttribute('lastClr'));
  }
  return out;
}
async function themeFont(zip: Zip, path: string, which = 'a:minorFont'): Promise<string> {
  const doc = await zip.xml(path);
  return deep(doc?.documentElement, which)[0]?.getElementsByTagName('a:latin')[0]?.getAttribute('typeface') || '';
}
function tint(color: string, t: number): string {
  if (!color || !t) return color;
  const n = parseInt(color.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => Math.round(t > 0 ? v + (255 - v) * t : v * (1 + t)));
  return '#' + ch.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Word (.docx)
// ---------------------------------------------------------------------------
interface RunProps { b?: boolean; i?: boolean; u?: boolean; s?: boolean; sz?: number; color?: string; font?: string; bg?: string; caps?: boolean; va?: string; }
interface ParaProps { ctx?: boolean; jc?: string; before?: number; after?: number; line?: number; lineRule?: string; left?: number; firstLine?: number; hanging?: number; shd?: string; numId?: string; ilvl?: number; style?: string; border?: string; }

const HIGHLIGHT: Record<string, string> = { yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000',
  darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000', darkYellow: '#808000',
  darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff' };

function onOff(el: Element | null): boolean | undefined {
  if (!el) return undefined;
  const v = val(el);
  return !(v === '0' || v === 'false' || v === 'off');
}
function readRPr(rPr: Element | null, theme: Record<string, string>): RunProps {
  const p: RunProps = {};
  if (!rPr) return p;
  const set = <K extends keyof RunProps>(k: K, v: RunProps[K] | undefined) => { if (v !== undefined) p[k] = v; };
  set('b', onOff(kid(rPr, 'w:b')));
  set('i', onOff(kid(rPr, 'w:i')));
  const u = kid(rPr, 'w:u'); if (u) p.u = val(u) !== 'none';
  set('s', onOff(kid(rPr, 'w:strike')) ?? onOff(kid(rPr, 'w:dstrike')));
  set('caps', onOff(kid(rPr, 'w:caps')));
  const sz = val(kid(rPr, 'w:sz')); if (sz) p.sz = num(sz) / 2;
  const color = kid(rPr, 'w:color');
  if (color) p.color = hex(val(color)) || (color.getAttribute('w:themeColor') ? theme[themeKey(color.getAttribute('w:themeColor')!)] : '') || undefined;
  const fonts = kid(rPr, 'w:rFonts');
  if (fonts?.getAttribute('w:ascii')) p.font = fonts.getAttribute('w:ascii')!;
  else if (fonts?.getAttribute('w:asciiTheme')) p.font = /major/.test(fonts.getAttribute('w:asciiTheme')!) ? theme['__major'] : theme['__minor'];
  const hl = val(kid(rPr, 'w:highlight')); if (hl && HIGHLIGHT[hl]) p.bg = HIGHLIGHT[hl];
  const shd = kid(rPr, 'w:shd'); if (shd && hex(shd.getAttribute('w:fill'))) p.bg = hex(shd.getAttribute('w:fill'));
  const va = val(kid(rPr, 'w:vertAlign')); if (va) p.va = va;
  return p;
}
function themeKey(k: string): string {
  return ({ text1: 'dk1', text2: 'dk2', background1: 'lt1', background2: 'lt2', dark1: 'dk1', dark2: 'dk2', light1: 'lt1', light2: 'lt2', hyperlink: 'hlink' } as Record<string, string>)[k] || k;
}
function readPPr(pPr: Element | null): ParaProps {
  const p: ParaProps = {};
  if (!pPr) return p;
  const style = val(kid(pPr, 'w:pStyle')); if (style) p.style = style;
  const ctx = onOff(kid(pPr, 'w:contextualSpacing')); if (ctx !== undefined) p.ctx = ctx;
  const jc = val(kid(pPr, 'w:jc')); if (jc) p.jc = jc;
  const sp = kid(pPr, 'w:spacing');
  if (sp) {
    if (sp.getAttribute('w:before') !== null) p.before = num(sp.getAttribute('w:before'));
    if (sp.getAttribute('w:after') !== null) p.after = num(sp.getAttribute('w:after'));
    if (sp.getAttribute('w:line') !== null) { p.line = num(sp.getAttribute('w:line')); p.lineRule = sp.getAttribute('w:lineRule') || 'auto'; }
  }
  const ind = kid(pPr, 'w:ind');
  if (ind) {
    const left = ind.getAttribute('w:left') ?? ind.getAttribute('w:start'); if (left !== null) p.left = num(left);
    if (ind.getAttribute('w:firstLine') !== null) p.firstLine = num(ind.getAttribute('w:firstLine'));
    if (ind.getAttribute('w:hanging') !== null) p.hanging = num(ind.getAttribute('w:hanging'));
  }
  const shd = kid(pPr, 'w:shd'); if (shd && hex(shd.getAttribute('w:fill'))) p.shd = hex(shd.getAttribute('w:fill'));
  const numPr = kid(pPr, 'w:numPr');
  if (numPr) { p.numId = val(kid(numPr, 'w:numId')) || undefined; p.ilvl = num(val(kid(numPr, 'w:ilvl'))); }
  const bottom = kid(kid(pPr, 'w:pBdr'), 'w:bottom');
  if (bottom && val(bottom) !== 'none' && val(bottom) !== 'nil') p.border = hex(bottom.getAttribute('w:color')) || '#000';
  return p;
}
function runCss(r: RunProps): string {
  const css: string[] = [];
  if (r.b) css.push('font-weight:700');
  if (r.i) css.push('font-style:italic');
  const deco = [r.u ? 'underline' : '', r.s ? 'line-through' : ''].filter(Boolean).join(' ');
  if (deco) css.push('text-decoration:' + deco);
  if (r.sz) css.push(`font-size:${r.sz}pt`);
  if (r.color) css.push('color:' + r.color);
  if (r.font) css.push('font-family:' + fontCss(r.font));
  if (r.bg) css.push('background:' + r.bg);
  if (r.caps) css.push('text-transform:uppercase');
  if (r.va === 'superscript') css.push('vertical-align:super;font-size:0.7em');
  if (r.va === 'subscript') css.push('vertical-align:sub;font-size:0.7em');
  return css.join(';');
}

function romanize(n: number): string {
  const map: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out;
}
function counterText(n: number, fmt: string): string {
  switch (fmt) {
    case 'lowerLetter': return String.fromCharCode(96 + ((n - 1) % 26) + 1);
    case 'upperLetter': return String.fromCharCode(64 + ((n - 1) % 26) + 1);
    case 'lowerRoman': return romanize(n);
    case 'upperRoman': return romanize(n).toUpperCase();
    default: return String(n);
  }
}

class DocxRenderer {
  private styles = new Map<string, { basedOn?: string; p: ParaProps; r: RunProps; type: string }>();
  private defaultR: RunProps = {};
  private defaultP: ParaProps = {};
  private defaultParaStyle = '';
  private numbering = new Map<string, Map<number, { fmt: string; text: string; left?: number; hanging?: number; start: number; r: RunProps }>>();
  private counters = new Map<string, number[]>();
  private rels = new Map<string, { target: string; external: boolean }>();
  private theme: Record<string, string> = {};
  private font = '';
  pageWidth = 794; pageHeight = 1123; margin = { top: 96, right: 96, bottom: 96, left: 96 };
  private paragraphsLeft = Infinity;
  private prev: { style: string; after: number; ctx: boolean } | null = null;

  constructor(private zip: Zip) {}

  async render(limitParagraphs = Infinity): Promise<string> {
    this.paragraphsLeft = limitParagraphs;
    this.theme = await themeColors(this.zip, 'word/theme/theme1.xml');
    this.font = await themeFont(this.zip, 'word/theme/theme1.xml');
    this.theme['__minor'] = this.font;
    this.theme['__major'] = await themeFont(this.zip, 'word/theme/theme1.xml', 'a:majorFont');
    await this.loadStyles();
    await this.loadNumbering();
    this.rels = await this.zip.rels('word/document.xml');
    const doc = await this.zip.xml('word/document.xml');
    const body = deep(doc?.documentElement, 'w:body')[0];
    if (!body) throw new Error('docx sin cuerpo');
    const sect = kid(body, 'w:sectPr');
    const pgSz = kid(sect, 'w:pgSz'); const pgMar = kid(sect, 'w:pgMar');
    if (pgSz) { this.pageWidth = Math.round(num(pgSz.getAttribute('w:w'), 11906) / 15); this.pageHeight = Math.round(num(pgSz.getAttribute('w:h'), 16838) / 15); }
    if (pgMar) {
      this.margin = { top: num(pgMar.getAttribute('w:top'), 1440) / 15, right: num(pgMar.getAttribute('w:right'), 1440) / 15,
        bottom: num(pgMar.getAttribute('w:bottom'), 1440) / 15, left: num(pgMar.getAttribute('w:left'), 1440) / 15 };
    }
    const inner = await this.blocks(body);
    const base = runCss({ sz: 11, ...this.defaultR, font: this.defaultR.font || this.font || 'Calibri' });
    return `<div class="rv-docx-page" style="width:${this.pageWidth}px;min-height:${this.pageHeight}px;padding:${this.margin.top}px ${this.margin.right}px ${this.margin.bottom}px ${this.margin.left}px;${base}">${inner}</div>`;
  }

  private async loadStyles(): Promise<void> {
    const doc = await this.zip.xml('word/styles.xml');
    const root = doc?.documentElement;
    const defaults = deep(root, 'w:docDefaults')[0];
    this.defaultR = readRPr(deep(defaults, 'w:rPr')[0] || null, this.theme);
    this.defaultP = readPPr(deep(defaults, 'w:pPr')[0] || null);
    for (const s of deep(root, 'w:style')) {
      const id = s.getAttribute('w:styleId') || '';
      const type = s.getAttribute('w:type') || '';
      if (type === 'paragraph' && s.getAttribute('w:default') === '1') this.defaultParaStyle = id;
      this.styles.set(id, { type, basedOn: val(kid(s, 'w:basedOn')) || undefined, p: readPPr(kid(s, 'w:pPr')), r: readRPr(kid(s, 'w:rPr'), this.theme) });
    }
  }
  private styleChain(id: string | undefined, depth = 0): { p: ParaProps; r: RunProps } {
    const s = id ? this.styles.get(id) : undefined;
    if (!s || depth > 10) return { p: {}, r: {} };
    const parent = this.styleChain(s.basedOn, depth + 1);
    return { p: { ...parent.p, ...s.p }, r: { ...parent.r, ...s.r } };
  }
  private async loadNumbering(): Promise<void> {
    const doc = await this.zip.xml('word/numbering.xml');
    const root = doc?.documentElement;
    const abstracts = new Map<string, Element>();
    for (const a of deep(root, 'w:abstractNum')) abstracts.set(a.getAttribute('w:abstractNumId') || '', a);
    for (const n of deep(root, 'w:num')) {
      const abs = abstracts.get(val(kid(n, 'w:abstractNumId')) || '');
      if (!abs) continue;
      const levels = new Map<number, { fmt: string; text: string; left?: number; hanging?: number; start: number; r: RunProps }>();
      for (const lvl of kids(abs, 'w:lvl')) {
        const ind = deep(lvl, 'w:ind')[0];
        levels.set(num(lvl.getAttribute('w:ilvl')), {
          fmt: val(kid(lvl, 'w:numFmt')) || 'decimal', text: val(kid(lvl, 'w:lvlText')) ?? '', start: num(val(kid(lvl, 'w:start')), 1),
          left: ind ? num(ind.getAttribute('w:left') ?? ind.getAttribute('w:start')) : undefined,
          hanging: ind ? num(ind.getAttribute('w:hanging')) : undefined, r: readRPr(kid(lvl, 'w:rPr'), this.theme),
        });
      }
      this.numbering.set(n.getAttribute('w:numId') || '', levels);
    }
  }

  private async blocks(parent: Element): Promise<string> {
    let html = '';
    for (const el of kids(parent)) {
      if (this.paragraphsLeft <= 0) break;
      if (el.nodeName === 'w:p') html += await this.paragraph(el);
      else if (el.nodeName === 'w:tbl') html += await this.table(el);
      else if (el.nodeName === 'w:sdt') html += await this.blocks(kid(el, 'w:sdtContent') || el);
      else if (el.nodeName === 'w:customXml' || el.nodeName === 'w:ins') html += await this.blocks(el);
    }
    return html;
  }

  private async paragraph(p: Element): Promise<string> {
    this.paragraphsLeft--;
    const own = readPPr(kid(p, 'w:pPr'));
    const styled = this.styleChain(own.style || this.defaultParaStyle);
    const pp: ParaProps = { ...this.defaultP, ...styled.p, ...own };
    const baseR: RunProps = { ...this.defaultR, ...styled.r, ...readRPr(kid(kid(p, 'w:pPr'), 'w:rPr'), this.theme) };
    // La marca de párrafo no se dibuja, pero su tamaño define la altura de una línea vacía.
    const markR: RunProps = { ...baseR };
    delete markR.u; delete markR.bg;
    const content = await this.inline(p, { ...this.defaultR, ...styled.r });
    // Espaciado contextual: entre párrafos del mismo estilo (p. ej. viñetas) no se deja espacio extra.
    const styleId = own.style || this.defaultParaStyle;
    let before = (pp.before ?? 0) / 15;
    if (pp.ctx && this.prev && this.prev.ctx && this.prev.style === styleId) before = -this.prev.after;
    this.prev = { style: styleId, after: (pp.after ?? 0) / 15, ctx: !!pp.ctx };
    const css: string[] = [`margin:${before}px 0 ${(pp.after ?? 0) / 15}px`];
    if (pp.jc) css.push('text-align:' + ({ both: 'justify', distribute: 'justify', center: 'center', right: 'right', end: 'right' } as Record<string, string>)[pp.jc] || 'left');
    if (pp.line) css.push(pp.lineRule === 'auto' ? `line-height:${(pp.line / 240 * 1.17).toFixed(2)}` : `line-height:${Math.round(pp.line / 15)}px`);
    if (pp.shd) css.push('background:' + pp.shd);
    if (pp.border) css.push(`border-bottom:1px solid ${pp.border};padding-bottom:2px`);
    let prefix = '';
    let left = pp.left ?? 0; let first = pp.firstLine ?? 0; const hang = pp.hanging ?? 0;
    if (pp.numId && pp.numId !== '0') {
      const lvl = this.numbering.get(pp.numId)?.get(pp.ilvl ?? 0);
      if (lvl) {
        if (own.left === undefined && lvl.left !== undefined) left = lvl.left;
        const hanging = own.hanging ?? lvl.hanging ?? 360;
        const counts = this.counters.get(pp.numId) || [];
        const level = pp.ilvl ?? 0;
        counts[level] = (counts[level] ?? lvl.start - 1) + 1;
        counts.length = level + 1;
        this.counters.set(pp.numId, counts);
        let label: string;
        if (lvl.fmt === 'bullet') {
          const ch = lvl.text;
          label = !ch || /[-]/.test(ch) || ch === '·' ? (['•', '◦', '▪'][level % 3]) : ch;
        } else if (lvl.fmt === 'none') {
          label = '';
        } else {
          label = lvl.text.replace(/%(\d)/g, (_, d) => {
            const i = Number(d) - 1;
            const fmt = this.numbering.get(pp.numId!)?.get(i)?.fmt || 'decimal';
            return counterText(counts[i] ?? 1, fmt);
          });
        }
        prefix = `<span class="rv-num" style="width:${hanging / 15}px;margin-left:-${hanging / 15}px;${runCss({ ...baseR, ...lvl.r, u: false })}">${esc(label)}</span>`;
        first = 0;
      }
    } else if (hang) {
      first = -hang;
    }
    if (left) css.push(`padding-left:${left / 15}px`);
    if (first) css.push(`text-indent:${first / 15}px`);
    const empty = !content.replace(/<[^>]+>/g, '').trim() && !/<img|<br/.test(content);
    return `<p style="${css.join(';')};${runCss(markR)}">${prefix}${empty ? '&nbsp;' : content}</p>`;
  }

  private async inline(parent: Element, paraR: RunProps): Promise<string> {
    let html = '';
    for (const el of kids(parent)) {
      switch (el.nodeName) {
        case 'w:r': html += await this.run(el, paraR); break;
        case 'w:hyperlink': {
          const inner = await this.inline(el, paraR);
          const rel = this.rels.get(el.getAttribute('r:id') || '');
          html += rel?.external && /^https?:\/\//i.test(rel.target)
            ? `<a href="${esc(rel.target)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner;
          break;
        }
        case 'w:ins': case 'w:smartTag': case 'w:fldSimple': case 'w:customXml': case 'w:bdo': case 'w:dir':
          html += await this.inline(el, paraR); break;
        case 'w:sdt': html += await this.inline(kid(el, 'w:sdtContent') || el, paraR); break;
      }
    }
    return html;
  }

  private async run(r: Element, paraR: RunProps): Promise<string> {
    const rPr = kid(r, 'w:rPr');
    const charStyle = this.styleChain(val(kid(rPr, 'w:rStyle')) || undefined).r;
    const props: RunProps = { ...paraR, ...charStyle, ...readRPr(rPr, this.theme) };
    let text = '';
    for (const c of kids(r)) {
      switch (c.nodeName) {
        case 'w:t': text += esc(c.textContent); break;
        case 'w:tab': text += '<span class="rv-tab"></span>'; break;
        case 'w:br': text += c.getAttribute('w:type') === 'page' ? '<span class="rv-pagebreak"></span>' : '<br>'; break;
        case 'w:cr': text += '<br>'; break;
        case 'w:noBreakHyphen': text += '‑'; break;
        case 'w:sym': text += '•'; break;
        case 'w:drawing': text += await this.drawing(c); break;
        case 'w:pict': case 'w:object': {
          const img = deep(c, 'v:imagedata')[0];
          const rel = this.rels.get(img?.getAttribute('r:id') || '');
          const src = rel && !rel.external ? await this.zip.image(rel.target) : '';
          if (src) text += `<img src="${src}" alt="" style="max-width:100%">`;
          break;
        }
      }
    }
    if (!text) return '';
    const css = runCss(props);
    return css ? `<span style="${css}">${text}</span>` : text;
  }

  private async drawing(d: Element): Promise<string> {
    const blip = deep(d, 'a:blip')[0];
    const rel = this.rels.get(blip?.getAttribute('r:embed') || '');
    if (!rel || rel.external) return '';
    const src = await this.zip.image(rel.target);
    if (!src) return '';
    const ext = deep(d, 'wp:extent')[0];
    const w = ext ? Math.round(num(ext.getAttribute('cx')) / 9525) : 0;
    const h = ext ? Math.round(num(ext.getAttribute('cy')) / 9525) : 0;
    const anchored = deep(d, 'wp:anchor').length > 0;
    return `<img src="${src}" alt="" style="${w ? `width:${w}px;` : ''}${h ? `height:${h}px;` : ''}max-width:100%;object-fit:contain;${anchored ? 'display:block;margin:4px auto' : 'vertical-align:bottom'}">`;
  }

  private async table(t: Element): Promise<string> {
    this.prev = null;
    const tblPr = kid(t, 'w:tblPr');
    const styled = this.styleChain(val(kid(tblPr, 'w:tblStyle')) || undefined);
    const borders = kid(tblPr, 'w:tblBorders');
    const noBorders = borders && kids(borders).every(b => ['none', 'nil'].includes(val(b) || ''));
    const grid = kids(kid(t, 'w:tblGrid'), 'w:gridCol').map(g => num(g.getAttribute('w:w')) / 15);
    const jc = val(kid(tblPr, 'w:jc'));
    type Cell = { html: string; span: number; rows: number; css: string; skip?: boolean };
    const rows: Cell[][] = [];
    const origin: (Cell | undefined)[] = [];
    for (const tr of kids(t, 'w:tr')) {
      const row: Cell[] = [];
      let col = 0;
      for (const tc of kids(tr, 'w:tc')) {
        const tcPr = kid(tc, 'w:tcPr');
        const span = num(val(kid(tcPr, 'w:gridSpan')), 1) || 1;
        const vm = kid(tcPr, 'w:vMerge');
        if (vm && val(vm) !== 'restart' && origin[col]) {
          origin[col]!.rows++;
          col += span;
          continue;
        }
        const css: string[] = [];
        const fill = hex(kid(tcPr, 'w:shd')?.getAttribute('w:fill'));
        if (fill) css.push('background:' + fill);
        const va = val(kid(tcPr, 'w:vAlign')); if (va) css.push('vertical-align:' + (va === 'center' ? 'middle' : va));
        const width = grid.slice(col, col + span).reduce((a, b) => a + b, 0);
        if (width) css.push(`width:${Math.round(width)}px`);
        const cell: Cell = { html: await this.blocks(tc), span, rows: 1, css: css.join(';') };
        row.push(cell);
        for (let k = 0; k < span; k++) origin[col + k] = vm ? cell : undefined;
        col += span;
      }
      rows.push(row);
      void styled;
    }
    const body = rows.map(r => '<tr>' + r.map(c =>
      `<td${c.span > 1 ? ` colspan="${c.span}"` : ''}${c.rows > 1 ? ` rowspan="${c.rows}"` : ''} style="${c.css}">${c.html}</td>`).join('') + '</tr>').join('');
    return `<table class="rv-table${noBorders ? ' rv-noborder' : ''}" style="${jc === 'center' ? 'margin:0 auto;' : ''}">${body}</table>`;
  }
}

// ---------------------------------------------------------------------------
// Excel (.xlsx)
// ---------------------------------------------------------------------------
const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const colName = (i: number) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const BUILTIN: Record<number, string> = { 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 37: '#,##0', 38: '#,##0', 39: '#,##0.00', 40: '#,##0.00' };

function formatNumber(v: number, fmt: string, isDate: boolean): string {
  if (isDate) {
    const d = new Date(Math.round((v - 25569) * 86400000));
    const dd = String(d.getUTCDate()).padStart(2, '0'), mm = String(d.getUTCMonth() + 1).padStart(2, '0'), yy = d.getUTCFullYear();
    const time = v % 1 ? ` ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` : '';
    return /[dmy]/i.test(fmt) || !time ? `${dd}/${mm}/${yy}${/h/i.test(fmt) ? time : ''}` : time.trim();
  }
  const section = fmt.split(';')[0].replace(/"[^"]*"|\[[^\]]*\]|\\./g, m => m.startsWith('"') ? m : '');
  if (!fmt || fmt === 'General') return String(Math.round(v * 1e10) / 1e10);
  const percent = section.includes('%');
  const dec = (/\.(0+)/.exec(section)?.[1].length) ?? 0;
  const thousands = section.includes(',');
  const n = percent ? v * 100 : v;
  let out = Math.abs(n).toLocaleString('es-MX', { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: thousands });
  if (n < 0) out = '-' + out;
  const currency = /\$|€|£/.exec(fmt)?.[0];
  if (currency) out = out.startsWith('-') ? '-' + currency + out.slice(1) : currency + out;
  return out + (percent ? '%' : '');
}

async function renderXlsx(zip: Zip, maxRows = 400, maxCols = 40): Promise<{ name: string; html: string }[]> {
  const theme = await themeColors(zip, 'xl/theme/theme1.xml');
  const themeList = [theme['lt1'], theme['dk1'], theme['lt2'], theme['dk2'], theme['accent1'], theme['accent2'], theme['accent3'], theme['accent4'], theme['accent5'], theme['accent6']];
  const color = (el: Element | null) => {
    if (!el) return '';
    const rgb = hex(el.getAttribute('rgb'));
    if (rgb) return rgb;
    const th = el.getAttribute('theme');
    if (th !== null) return tint(themeList[num(th)] || '', num(el.getAttribute('tint')));
    const idx = el.getAttribute('indexed');
    return idx === '10' ? '#ff0000' : idx === '9' ? '#ffffff' : '';
  };
  // Textos compartidos
  const ss = await zip.xml('xl/sharedStrings.xml');
  const strings = deep(ss?.documentElement, 'si').map(si => deep(si, 't').map(t => t.textContent || '').join(''));
  // Estilos
  const st = (await zip.xml('xl/styles.xml'))?.documentElement;
  const numFmts = new Map<number, string>();
  for (const f of deep(st, 'numFmt')) numFmts.set(num(f.getAttribute('numFmtId')), f.getAttribute('formatCode') || '');
  const fonts = kids(deep(st, 'fonts')[0], 'font').map(f => ({
    b: !!kid(f, 'b') && kid(f, 'b')!.getAttribute('val') !== '0', i: !!kid(f, 'i'), u: !!kid(f, 'u'),
    sz: num(kid(f, 'sz')?.getAttribute('val'), 11), color: color(kid(f, 'color')), name: kid(f, 'name')?.getAttribute('val') || '',
  }));
  const fills = kids(deep(st, 'fills')[0], 'fill').map(f => {
    const pf = kid(f, 'patternFill');
    return pf && pf.getAttribute('patternType') && pf.getAttribute('patternType') !== 'none' ? color(kid(pf, 'fgColor')) : '';
  });
  const borders = kids(deep(st, 'borders')[0], 'border').map(b => {
    const side = (n: string) => { const s = kid(b, n); return s?.getAttribute('style') ? `1px solid ${color(kid(s, 'color')) || '#000'}` : ''; };
    return { l: side('left'), r: side('right'), t: side('top'), b: side('bottom') };
  });
  const xfs = kids(deep(st, 'cellXfs')[0], 'xf').map(x => ({
    numFmtId: num(x.getAttribute('numFmtId')), font: num(x.getAttribute('fontId')), fill: num(x.getAttribute('fillId')),
    border: num(x.getAttribute('borderId')), h: kid(x, 'alignment')?.getAttribute('horizontal') || '',
    v: kid(x, 'alignment')?.getAttribute('vertical') || '', wrap: kid(x, 'alignment')?.getAttribute('wrapText') === '1',
  }));
  const defaultFont = fonts[0];

  const wb = (await zip.xml('xl/workbook.xml'))?.documentElement;
  const rels = await zip.rels('xl/workbook.xml');
  const sheets: { name: string; html: string }[] = [];
  for (const sh of deep(wb, 'sheet')) {
    if (sh.getAttribute('state') === 'hidden') continue;
    const rel = rels.get(sh.getAttribute('r:id') || '');
    const doc = rel ? (await zip.xml(rel.target))?.documentElement : null;
    if (!doc) continue;
    const widths: number[] = [];
    for (const c of deep(doc, 'col')) {
      for (let i = num(c.getAttribute('min')) - 1; i < num(c.getAttribute('max')) && i < maxCols; i++) widths[i] = Math.round(num(c.getAttribute('width'), 8.43) * 7 + 5);
    }
    const cells = new Map<string, { text: string; css: string; num: boolean }>();
    const heights = new Map<number, number>();
    let maxR = 0, maxC = 0;
    for (const row of deep(doc, 'row')) {
      const r = num(row.getAttribute('r')) - 1;
      if (r >= maxRows) break;
      if (row.getAttribute('ht')) heights.set(r, Math.round(num(row.getAttribute('ht')) * 4 / 3));
      for (const c of kids(row, 'c')) {
        const ref = c.getAttribute('r') || '';
        const ci = colIndex(ref);
        if (ci >= maxCols) continue;
        const t = c.getAttribute('t') || 'n';
        const v = kid(c, 'v')?.textContent ?? '';
        const xf = xfs[num(c.getAttribute('s'))] || xfs[0];
        let text = '';
        let isNum = false;
        if (t === 's') text = strings[num(v)] ?? '';
        else if (t === 'inlineStr') text = deep(c, 't').map(x => x.textContent || '').join('');
        else if (t === 'b') text = v === '1' ? 'VERDADERO' : 'FALSO';
        else if (t === 'str' || t === 'e') text = v;
        else if (v !== '') {
          const fmt = numFmts.get(xf?.numFmtId ?? 0) || BUILTIN[xf?.numFmtId ?? 0] || 'General';
          const isDate = DATE_IDS.has(xf?.numFmtId ?? 0) || (/[dmy]/i.test(fmt.replace(/"[^"]*"|\[[^\]]*\]/g, '')) && !/^[#0.,%]+$/.test(fmt));
          text = formatNumber(Number(v), fmt, isDate);
          isNum = !isDate;
        }
        const css: string[] = [];
        if (xf) {
          const f = fonts[xf.font];
          if (f) {
            if (f.b) css.push('font-weight:700'); if (f.i) css.push('font-style:italic'); if (f.u) css.push('text-decoration:underline');
            if (f.sz && f.sz !== defaultFont?.sz) css.push(`font-size:${f.sz}pt`);
            if (f.color && f.color !== '#000000') css.push('color:' + f.color);
          }
          if (fills[xf.fill]) css.push('background:' + fills[xf.fill]);
          const b = borders[xf.border];
          if (b) { if (b.l) css.push('border-left:' + b.l); if (b.r) css.push('border-right:' + b.r); if (b.t) css.push('border-top:' + b.t); if (b.b) css.push('border-bottom:' + b.b); }
          if (xf.h) css.push('text-align:' + (xf.h === 'centerContinuous' ? 'center' : xf.h));
          else if (isNum) css.push('text-align:right');
          if (xf.v) css.push('vertical-align:' + (xf.v === 'center' ? 'middle' : xf.v));
          if (xf.wrap) css.push('white-space:pre-wrap');
        }
        if (text === '' && !css.length) continue;
        cells.set(`${r}:${ci}`, { text, css: css.join(';'), num: isNum });
        if (text !== '' || css.some(x => x.startsWith('background'))) { maxR = Math.max(maxR, r + 1); maxC = Math.max(maxC, ci + 1); }
      }
    }
    // Celdas combinadas
    const merges = new Map<string, { rs: number; cs: number }>();
    const hidden = new Set<string>();
    for (const m of deep(doc, 'mergeCell')) {
      const [a, b] = (m.getAttribute('ref') || '').split(':');
      if (!a || !b) continue;
      const r1 = num(/\d+/.exec(a)?.[0]) - 1, c1 = colIndex(a), r2 = num(/\d+/.exec(b)?.[0]) - 1, c2 = colIndex(b);
      merges.set(`${r1}:${c1}`, { rs: r2 - r1 + 1, cs: c2 - c1 + 1 });
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) hidden.add(`${r}:${c}`);
      maxR = Math.max(maxR, Math.min(r2 + 1, maxRows)); maxC = Math.max(maxC, Math.min(c2 + 1, maxCols));
    }
    maxR = Math.max(maxR, 1); maxC = Math.max(maxC, 1);
    const cols = Array.from({ length: maxC }, (_, i) => `<col style="width:${widths[i] || 64}px">`).join('');
    let html = `<table class="rv-sheet" style="font-family:${fontCss(defaultFont?.name)};font-size:${defaultFont?.sz || 11}pt"><colgroup><col style="width:40px">${cols}</colgroup>`;
    html += '<thead><tr><th class="rv-corner"></th>' + Array.from({ length: maxC }, (_, i) => `<th>${colName(i)}</th>`).join('') + '</tr></thead><tbody>';
    for (let r = 0; r < maxR; r++) {
      html += `<tr${heights.get(r) ? ` style="height:${heights.get(r)}px"` : ''}><th>${r + 1}</th>`;
      for (let c = 0; c < maxC; c++) {
        const key = `${r}:${c}`;
        if (hidden.has(key)) continue;
        const cell = cells.get(key); const m = merges.get(key);
        html += `<td${m ? ` rowspan="${Math.min(m.rs, maxRows - r)}" colspan="${Math.min(m.cs, maxC - c)}"` : ''}${cell?.css ? ` style="${cell.css}"` : ''}>${esc(cell?.text ?? '')}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    sheets.push({ name: sh.getAttribute('name') || `Hoja ${sheets.length + 1}`, html });
  }
  return sheets;
}

// ---------------------------------------------------------------------------
// PowerPoint (.pptx)
// ---------------------------------------------------------------------------
async function renderPptx(zip: Zip, maxSlides = 60): Promise<{ html: string; width: number; height: number; count: number }> {
  const pres = (await zip.xml('ppt/presentation.xml'))?.documentElement;
  const sz = deep(pres, 'p:sldSz')[0];
  const W = Math.round(num(sz?.getAttribute('cx'), 12192000) / 9525), H = Math.round(num(sz?.getAttribute('cy'), 6858000) / 9525);
  const presRels = await zip.rels('ppt/presentation.xml');
  const theme = await themeColors(zip, 'ppt/theme/theme1.xml');
  const font = await themeFont(zip, 'ppt/theme/theme1.xml');
  const slidePaths = deep(pres, 'p:sldId').map(s => presRels.get(s.getAttribute('r:id') || '')?.target).filter((p): p is string => !!p).slice(0, maxSlides);
  const fillColor = (el: Element | null): string => {
    const solid = el ? (el.nodeName === 'a:solidFill' ? el : kid(el, 'a:solidFill')) : null;
    if (!solid) return '';
    const srgb = kid(solid, 'a:srgbClr'); if (srgb) return hex(srgb.getAttribute('val'));
    const sch = kid(solid, 'a:schemeClr');
    if (sch) {
      const key = ({ tx1: 'dk1', tx2: 'dk2', bg1: 'lt1', bg2: 'lt2' } as Record<string, string>)[sch.getAttribute('val') || ''] || sch.getAttribute('val') || '';
      const lum = kid(sch, 'a:lumMod'); const off = kid(sch, 'a:lumOff');
      let c = theme[key] || '';
      if (c && off) c = tint(c, num(off.getAttribute('val')) / 100000);
      else if (c && lum) c = tint(c, num(lum.getAttribute('val')) / 100000 - 1);
      return c;
    }
    return '';
  };
  type Ph = { off?: [number, number]; ext?: [number, number]; sz?: number; algn?: string; anchor?: string; b?: boolean; color?: string };
  const placeholders = async (path: string) => {
    const map = new Map<string, Ph>();
    const doc = (await zip.xml(path))?.documentElement;
    for (const sp of deep(doc, 'p:sp')) {
      const ph = deep(sp, 'p:ph')[0];
      if (!ph) continue;
      const xfrm = deep(kid(sp, 'p:spPr'), 'a:xfrm')[0];
      const off = kid(xfrm, 'a:off'), ext = kid(xfrm, 'a:ext');
      const lvl = deep(sp, 'a:lvl1pPr')[0]; const defR = kid(lvl, 'a:defRPr');
      const entry: Ph = {
        off: off ? [num(off.getAttribute('x')), num(off.getAttribute('y'))] : undefined,
        ext: ext ? [num(ext.getAttribute('cx')), num(ext.getAttribute('cy'))] : undefined,
        sz: defR?.getAttribute('sz') ? num(defR.getAttribute('sz')) / 100 : undefined,
        algn: lvl?.getAttribute('algn') || undefined, anchor: deep(sp, 'a:bodyPr')[0]?.getAttribute('anchor') || undefined,
        b: defR?.getAttribute('b') === '1' || undefined, color: fillColor(kid(defR, 'a:solidFill')) || undefined,
      };
      const type = ph.getAttribute('type') || 'body';
      if (ph.getAttribute('idx')) map.set('idx:' + ph.getAttribute('idx'), entry);
      if (!map.has('type:' + type)) map.set('type:' + type, entry);
    }
    return map;
  };
  let html = '';
  for (const path of slidePaths) {
    const rels = await zip.rels(path);
    const layoutPath = Array.from(rels.values()).find(r => /slideLayout/.test(r.target))?.target;
    const layoutPh = layoutPath ? await placeholders(layoutPath) : new Map<string, Ph>();
    const layoutRels = layoutPath ? await zip.rels(layoutPath) : new Map();
    const masterPath = Array.from(layoutRels.values()).find((r: { target: string }) => /slideMaster/.test(r.target))?.target as string | undefined;
    const masterPh = masterPath ? await placeholders(masterPath) : new Map<string, Ph>();
    // Estilos de texto del patrón (título y cuerpo): alineación, tamaño, negrita y color por defecto.
    const masterDoc = masterPath ? (await zip.xml(masterPath))?.documentElement : undefined;
    const txStyle = (name: string): Ph => {
      const lvl = deep(deep(masterDoc, name)[0], 'a:lvl1pPr')[0]; const defR = kid(lvl, 'a:defRPr');
      return { algn: lvl?.getAttribute('algn') || undefined, sz: defR?.getAttribute('sz') ? num(defR.getAttribute('sz')) / 100 : undefined,
        b: defR?.getAttribute('b') === '1' || undefined, color: fillColor(kid(defR, 'a:solidFill')) || undefined };
    };
    const masterTitle = txStyle('p:titleStyle'), masterBody = txStyle('p:bodyStyle');
    const doc = (await zip.xml(path))?.documentElement;
    if (!doc) continue;
    // Fondo
    let bg = '#ffffff';
    const bgEl = deep(doc, 'p:bg')[0] || (layoutPath ? deep((await zip.xml(layoutPath))?.documentElement, 'p:bg')[0] : undefined)
      || (masterPath ? deep((await zip.xml(masterPath))?.documentElement, 'p:bg')[0] : undefined);
    let bgImage = '';
    if (bgEl) {
      const c = fillColor(deep(bgEl, 'a:solidFill')[0] || null); if (c) bg = c;
      const blip = deep(bgEl, 'a:blip')[0];
      if (blip && deep(doc, 'p:bg')[0]) { const rel = rels.get(blip.getAttribute('r:embed') || ''); if (rel) bgImage = await zip.image(rel.target); }
    }
    let shapes = '';
    const walk = async (tree: Element, tf: (x: number, y: number, w: number, h: number) => [number, number, number, number]) => {
      for (const el of kids(tree)) {
        if (el.nodeName === 'p:grpSp') {
          const x = deep(kid(el, 'p:grpSpPr'), 'a:xfrm')[0];
          const off = kid(x, 'a:off'), ext = kid(x, 'a:ext'), choff = kid(x, 'a:chOff'), chext = kid(x, 'a:chExt');
          if (off && ext && choff && chext) {
            const sx = num(ext.getAttribute('cx')) / (num(chext.getAttribute('cx')) || 1), sy = num(ext.getAttribute('cy')) / (num(chext.getAttribute('cy')) || 1);
            const ox = num(off.getAttribute('x')), oy = num(off.getAttribute('y')), cx = num(choff.getAttribute('x')), cy = num(choff.getAttribute('y'));
            await walk(el, (a, b, w, h) => tf(ox + (a - cx) * sx, oy + (b - cy) * sy, w * sx, h * sy));
          } else await walk(el, tf);
          continue;
        }
        if (el.nodeName !== 'p:sp' && el.nodeName !== 'p:pic') continue;
        const spPr = kid(el, 'p:spPr');
        const xfrm = deep(spPr, 'a:xfrm')[0];
        let off: [number, number] | undefined; let ext: [number, number] | undefined; let defSz: number | undefined;
        let phAlgn: string | undefined; let phAnchor: string | undefined; let phB: boolean | undefined; let phColor: string | undefined;
        if (xfrm) {
          const o = kid(xfrm, 'a:off'), e = kid(xfrm, 'a:ext');
          if (o) off = [num(o.getAttribute('x')), num(o.getAttribute('y'))];
          if (e) ext = [num(e.getAttribute('cx')), num(e.getAttribute('cy'))];
        }
        const ph = deep(el, 'p:ph')[0];
        let phType = '';
        if (ph) {
          phType = ph.getAttribute('type') || 'body';
          const keys = [ph.getAttribute('idx') ? 'idx:' + ph.getAttribute('idx') : '', 'type:' + phType].filter(Boolean);
          for (const src of [layoutPh, masterPh]) for (const k of keys) {
            const e = src.get(k);
            if (e) { off ??= e.off; ext ??= e.ext; defSz ??= e.sz; phAlgn ??= e.algn; phAnchor ??= e.anchor; phB ??= e.b; phColor ??= e.color; }
          }
          const ms = phType === 'title' || phType === 'ctrTitle' ? masterTitle : masterBody;
          defSz ??= ms.sz; phAlgn ??= ms.algn; phB ??= ms.b; phColor ??= ms.color;
        }
        if (!off || !ext) continue;
        const [x, y, w, h] = tf(off[0], off[1], ext[0], ext[1]);
        const box = `left:${(x / 9525).toFixed(1)}px;top:${(y / 9525).toFixed(1)}px;width:${(w / 9525).toFixed(1)}px;height:${(h / 9525).toFixed(1)}px`;
        if (el.nodeName === 'p:pic') {
          const rel = rels.get(deep(el, 'a:blip')[0]?.getAttribute('r:embed') || '');
          const src = rel && !rel.external ? await zip.image(rel.target) : '';
          if (src) shapes += `<img class="rv-shape" src="${src}" alt="" style="${box};object-fit:fill">`;
          continue;
        }
        const fill = fillColor(spPr);
        const isTitle = phType === 'title' || phType === 'ctrTitle';
        const baseSz = defSz ?? (isTitle ? 40 : phType === 'subTitle' ? 24 : ph ? 24 : 18);
        const body = kid(el, 'p:txBody');
        const anchor = kid(body, 'a:bodyPr')?.getAttribute('anchor') || phAnchor;
        let text = '';
        for (const p of kids(body, 'a:p')) {
          const pPr = kid(p, 'a:pPr');
          const algn = pPr?.getAttribute('algn') || phAlgn;
          const bullet = ph && !isTitle && phType !== 'subTitle' && phType !== 'ctrTitle' && !kid(pPr, 'a:buNone') && kids(p, 'a:r').length > 0 && phType === 'body';
          let line = '';
          for (const r of kids(p)) {
            if (r.nodeName === 'a:br') { line += '<br>'; continue; }
            if (r.nodeName !== 'a:r' && r.nodeName !== 'a:fld') continue;
            const rPr = kid(r, 'a:rPr');
            const css: string[] = [];
            const s = rPr?.getAttribute('sz'); css.push(`font-size:${s ? num(s) / 100 : baseSz}pt`);
            if (rPr?.getAttribute('b') === '1' || (phB && rPr?.getAttribute('b') !== '0')) css.push('font-weight:700');
            if (rPr?.getAttribute('i') === '1') css.push('font-style:italic');
            if (rPr?.getAttribute('u') && rPr.getAttribute('u') !== 'none') css.push('text-decoration:underline');
            const c = fillColor(kid(rPr, 'a:solidFill')) || phColor; if (c) css.push('color:' + c);
            const latin = kid(rPr, 'a:latin')?.getAttribute('typeface'); if (latin && !latin.startsWith('+')) css.push('font-family:' + fontCss(latin));
            line += `<span style="${css.join(';')}">${esc(kid(r, 'a:t')?.textContent)}</span>`;
          }
          const endSz = kid(p, 'a:endParaRPr')?.getAttribute('sz');
          text += `<p style="${algn ? 'text-align:' + ({ ctr: 'center', r: 'right', just: 'justify' } as Record<string, string>)[algn] + ';' : ''}font-size:${endSz ? num(endSz) / 100 : baseSz}pt">${bullet ? '• ' : ''}${line || '&nbsp;'}</p>`;
        }
        if (!text && !fill) continue;
        const justify = anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : isTitle && !anchor ? 'center' : 'flex-start';
        shapes += `<div class="rv-shape rv-text" style="${box};${fill ? 'background:' + fill + ';' : ''}justify-content:${justify}">${text}</div>`;
      }
    };
    const tree = deep(doc, 'p:spTree')[0];
    if (tree) await walk(tree, (a, b, w, h) => [a, b, w, h]);
    html += `<div class="rv-slide" style="width:${W}px;height:${H}px;background:${bg}${bgImage ? ` url('${bgImage}') center/cover` : ''};font-family:${fontCss(font)}">${shapes}</div>`;
  }
  return { html, width: W, height: H, count: slidePaths.length };
}

// ---------------------------------------------------------------------------
// CSV y texto
// ---------------------------------------------------------------------------
function parseCsv(text: string, maxRows = 500): string[][] {
  const sep = (text.split('\n')[0].match(/;/g)?.length || 0) > (text.split('\n')[0].match(/,/g)?.length || 0) ? ';' : ',';
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function csvHtml(text: string, maxRows = 500): string {
  const rows = parseCsv(text, maxRows);
  return '<table class="rv-table rv-csv">' + rows.map((r, i) => '<tr>' + r.map(c => i === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`).join('') + '</tr>').join('') + '</table>';
}

// ---------------------------------------------------------------------------
// PDF (pdf.js en assets/pdfjs, se carga solo cuando se necesita)
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pdfjs: Promise<any> | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadPdfJs(): Promise<any> {
  if (!pdfjs) {
    const base = document.baseURI;
    // import() con una dirección variable: el compilador no intenta empaquetarlo.
    const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<unknown>;
    pdfjs = dynamicImport(new URL('assets/pdfjs/pdf.min.mjs', base).href).then((m: any) => {
      m.GlobalWorkerOptions.workerSrc = new URL('assets/pdfjs/pdf.worker.min.mjs', base).href;
      return m;
    }).catch(error => { pdfjs = undefined; throw error; });
  }
  return pdfjs;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function openPdf(file: Blob): Promise<any> {
  const lib = await loadPdfJs();
  return lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pdfPageImage(pdf: any, n: number, width: number, type = 'image/jpeg'): Promise<string> {
  const page = await pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  const url = canvas.toDataURL(type, 0.85);
  page.cleanup();
  return url;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function downscale(file: Blob, max: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.8);
}

/** Miniatura: imagen (foto o primera página) o HTML de la primera página para mostrar reducido. */
export async function makeThumb(file: Blob, name: string): Promise<Thumb> {
  const ext = extOf(name);
  try {
    if (IMAGE_EXT.includes(ext) || file.type.startsWith('image/')) return { kind: 'img', src: await downscale(file, 320), fit: 'cover' };
    if (ext === 'pdf') {
      const pdf = await openPdf(file);
      try { return { kind: 'img', src: await pdfPageImage(pdf, 1, 240), fit: 'contain' }; } finally { void pdf.loadingTask?.destroy?.(); }
    }
    if (ext === 'docx') {
      const zip = Zip.open(new Uint8Array(await file.arrayBuffer()));
      if (!zip) return { kind: 'icon' };
      const r = new DocxRenderer(zip);
      const html = await r.render(60);
      return { kind: 'html', html, width: r.pageWidth, height: r.pageHeight, flavor: 'docx' };
    }
    if (ext === 'xlsx') {
      const zip = Zip.open(new Uint8Array(await file.arrayBuffer()));
      const sheets = zip ? await renderXlsx(zip, 30, 12) : [];
      return sheets.length ? { kind: 'html', html: sheets[0].html, width: 720, height: 560, flavor: 'xlsx' } : { kind: 'icon' };
    }
    if (ext === 'pptx') {
      const zip = Zip.open(new Uint8Array(await file.arrayBuffer()));
      const deck = zip ? await renderPptx(zip, 1) : null;
      return deck?.count ? { kind: 'html', html: deck.html, width: deck.width, height: deck.height, flavor: 'pptx' } : { kind: 'icon' };
    }
    if (ext === 'csv') return { kind: 'html', html: csvHtml(await file.slice(0, 20000).text(), 30), width: 720, height: 560, flavor: 'csv' };
    if (['txt', 'md'].includes(ext)) {
      return { kind: 'html', html: `<div class="rv-docx-page rv-plain" style="width:794px;min-height:1123px;padding:72px">${esc(await file.slice(0, 6000).text())}</div>`, width: 794, height: 1123, flavor: 'text' };
    }
  } catch { /* se muestra el icono */ }
  return { kind: 'icon' };
}

/** Vista completa con formato. onPdfPage recibe cada página de PDF conforme se dibuja. */
export async function renderFull(file: Blob, name: string, onPdfPage?: (pages: string[], total: number) => void): Promise<FullRender> {
  const ext = extOf(name);
  if (IMAGE_EXT.includes(ext) || file.type.startsWith('image/')) return { kind: 'image', src: URL.createObjectURL(file) };
  if (ext === 'pdf') {
    const pdf = await openPdf(file);
    const total = Math.min(pdf.numPages, 80);
    const pages: string[] = [];
    const width = Math.min(1400, Math.round(900 * Math.min(2, window.devicePixelRatio || 1)));
    (async () => {
      try {
        for (let i = 1; i <= total; i++) { pages.push(await pdfPageImage(pdf, i, width)); onPdfPage?.([...pages], total); }
      } finally { void pdf.loadingTask?.destroy?.(); }
    })();
    return { kind: 'pdf', pages, total };
  }
  if (ext === 'docx') {
    const zip = Zip.open(new Uint8Array(await file.arrayBuffer()));
    if (!zip) throw new Error('No se pudo abrir el documento de Word.');
    const r = new DocxRenderer(zip);
    const html = await r.render();
    return { kind: 'doc', html, flavor: 'docx', width: r.pageWidth };
  }
  if (ext === 'xlsx') {
    const zip = Zip.open(new Uint8Array(await file.arrayBuffer()));
    if (!zip) throw new Error('No se pudo abrir el libro de Excel.');
    return { kind: 'sheets', sheets: await renderXlsx(zip) };
  }
  if (ext === 'pptx') {
    const zip = Zip.open(new Uint8Array(await file.arrayBuffer()));
    if (!zip) throw new Error('No se pudo abrir la presentación.');
    const deck = await renderPptx(zip);
    return { kind: 'doc', html: deck.html, flavor: 'pptx', width: deck.width };
  }
  if (ext === 'csv') return { kind: 'doc', html: csvHtml(await file.text()), flavor: 'csv' };
  if (['txt', 'md'].includes(ext)) return { kind: 'doc', html: `<div class="rv-docx-page rv-plain" style="width:794px;min-height:600px;padding:56px">${esc((await file.slice(0, 400000).text()))}</div>`, flavor: 'text', width: 794 };
  return { kind: 'other' };
}
