/*
 * Extrae el texto de un .docx o .xlsx en el navegador para que el asistente de IA pueda consultarlo.
 * (En PHP lo hacía ZipArchive en el servidor; Supabase no puede abrir archivos ZIP.)
 * Usa el descompresor nativo del navegador (DecompressionStream), sin librerías extra.
 */
const MAX_TEXT = 500000;

export async function extractOfficeText(file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  const entry = ext === 'docx' ? 'word/document.xml' : ext === 'xlsx' ? 'xl/sharedStrings.xml' : null;
  if (!entry || typeof DecompressionStream === 'undefined') return '';
  try {
    const xml = await readZipEntry(new Uint8Array(await file.arrayBuffer()), entry);
    if (!xml) return '';
    const text = xml
      .replace(/<\/w:p>|<\/si>|<w:br\s*\/>|<w:tab\s*\/>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&amp;/g, '&')
      .replace(/\u0000/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text.slice(0, MAX_TEXT);
  } catch {
    return '';
  }
}

async function readZipEntry(buf: Uint8Array, name: string): Promise<string | null> {
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
    if (view.getUint32(ptr, true) !== 0x02014b50) return null;
    const method = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const nameLength = view.getUint16(ptr + 28, true);
    const extraLength = view.getUint16(ptr + 30, true);
    const commentLength = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const entryName = decoder.decode(buf.subarray(ptr + 46, ptr + 46 + nameLength));
    if (entryName === name) {
      const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
      const data = new Uint8Array(buf.subarray(start, start + compressedSize));
      if (method === 0) return decoder.decode(data);
      if (method !== 8) return null;
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return await new Response(stream).text();
    }
    ptr += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}
