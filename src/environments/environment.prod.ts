/*
 * Configuración de producción (GitHub Pages).
 * - Con supabaseUrl y supabaseKey: la app usa Supabase (public.research_api).
 * - Vacíos: usa el backend PHP en apiBaseUrl (solo funciona servido desde XAMPP).
 * La clave pública (publishable / anon) puede ir aquí; NUNCA la clave secret / service_role.
 * El flujo de GitHub Actions rellena estos valores con las variables SUPABASE_URL y SUPABASE_KEY.
 */
export const environment = {
  production: true,
  apiBaseUrl: '/research-university/backend',
  supabaseUrl: 'https://xdxyaclzvtcmpepqhlgb.supabase.co',
  supabaseKey: 'sb_publishable_2TLOT3KyPC28FTTigNHO7A_5T4ESlRn',
};

