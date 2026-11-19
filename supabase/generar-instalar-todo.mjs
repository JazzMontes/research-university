// Regenera supabase/instalar_todo.sql uniendo 01..07 (para instalar a mano en el SQL Editor).
// Uso: node supabase/generar-instalar-todo.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const partes = readdirSync(dir).filter((f) => /^0[1-9]_.*\.sql$/.test(f)).sort();
const cabecera = `-- =====================================================================
-- URPMP · INSTALACIÓN COMPLETA PARA SUPABASE (versión 3)
-- Copia TODO este archivo en Supabase → SQL Editor → New query → Run.
-- Se puede volver a ejecutar para actualizar: NO borra datos.
-- Generado a partir de: ${partes.join(', ')}
-- =====================================================================
`;
const cuerpo = partes.map((f) => `\n-- >>>>>>>>>> ${f}\n${readFileSync(dir + f, 'utf8').trim()}\n`).join('');
writeFileSync(dir + 'instalar_todo.sql', cabecera + cuerpo);
console.log(`instalar_todo.sql generado desde ${partes.length} archivos.`);
