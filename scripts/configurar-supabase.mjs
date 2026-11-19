// Escribe SUPABASE_URL y SUPABASE_KEY (variables del repositorio en GitHub) en
// src/environments/environment.prod.ts antes de compilar.
// Si las variables están vacías, deja el archivo como está (usa los valores ya escritos).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const archivo = fileURLToPath(new URL('../src/environments/environment.prod.ts', import.meta.url));
const url = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
const key = (process.env.SUPABASE_KEY || '').trim();

if (!url && !key) {
  console.log('SUPABASE_URL y SUPABASE_KEY vacías: se usan los valores de environment.prod.ts.');
  process.exit(0);
}
if (!url || !key) {
  console.error('Falta SUPABASE_URL o SUPABASE_KEY. Define las dos en Settings → Secrets and variables → Actions → Variables.');
  process.exit(1);
}
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) {
  console.error(`SUPABASE_URL no parece válida: ${url} (esperado https://xxxx.supabase.co)`);
  process.exit(1);
}

// Nunca publicar la clave secreta: quedaría visible para cualquiera en GitHub Pages.
let esSecreta = key.startsWith('sb_secret_');
if (key.startsWith('eyJ')) {
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString());
    esSecreta = payload.role === 'service_role';
  } catch { /* no es JWT legible: se acepta */ }
}
if (esSecreta) {
  console.error('SUPABASE_KEY es la clave SECRETA (service_role). Usa la clave pública (publishable / anon).');
  process.exit(1);
}

let texto = readFileSync(archivo, 'utf8');
const reemplazar = (campo, valor) => {
  const re = new RegExp(`(${campo}:\\s*)'[^']*'`);
  if (!re.test(texto)) { console.error(`No se encontró ${campo} en environment.prod.ts`); process.exit(1); }
  texto = texto.replace(re, `$1'${valor}'`);
};
reemplazar('supabaseUrl', url);
reemplazar('supabaseKey', key);
writeFileSync(archivo, texto);
console.log(`Supabase configurado: ${url}`);
