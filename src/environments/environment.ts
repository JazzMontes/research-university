/*
 * Configuración de desarrollo (ionic serve / ng serve).
 * - Deja supabaseUrl y supabaseKey vacíos para trabajar con el backend PHP de XAMPP.
 * - Escríbelos para probar en local contra Supabase.
 */
export const environment = {
  production: false,
  apiBaseUrl: 'http://localhost/research-university/backend',
  supabaseUrl: 'https://xdxyaclzvtcmpepqhlgb.supabase.co',
  supabaseKey: 'sb_publishable_2TLOT3KyPC28FTTigNHO7A_5T4ESlRn',
};
