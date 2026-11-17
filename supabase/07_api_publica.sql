-- =====================================================================
-- URPMP · 07 · API pública: public.research_api(ruta, metodo, datos, token)
-- Es la ÚNICA función que la app (GitHub Pages) puede llamar.
-- Recibe la misma ruta que usaba PHP ("proposals/create.php") y responde
-- { status, body } con los mismos códigos HTTP (200, 401, 403, 404, 409, 422…).
-- =====================================================================

create or replace function research.route_method(m text, a text)
returns text language sql immutable as $$
  select case m || '/' || a
    when 'api/health' then 'GET'
    when 'auth/login' then 'POST' when 'auth/logout' then 'POST' when 'auth/session' then 'GET'
    when 'users/list' then 'GET' when 'users/detail' then 'GET' when 'users/create' then 'POST' when 'users/update' then 'POST'
    when 'users/change-status' then 'POST' when 'users/change-role' then 'POST' when 'users/reset-password' then 'POST'
    when 'catalogs/roles' then 'GET' when 'catalogs/researchers' then 'GET' when 'catalogs/evaluators' then 'GET'
    when 'catalogs/participants' then 'GET'
    when 'proposals/list' then 'GET' when 'proposals/detail' then 'GET' when 'proposals/history' then 'GET'
    when 'proposals/create' then 'POST' when 'proposals/update' then 'POST' when 'proposals/resubmit' then 'POST'
    when 'proposals/review' then 'POST' when 'proposals/archive' then 'POST'
    when 'evaluations/assign' then 'POST' when 'evaluations/submit' then 'POST' when 'evaluations/assignments' then 'GET'
    when 'dashboard/summary' then 'GET'
    when 'projects/list' then 'GET' when 'projects/detail' then 'GET' when 'projects/history' then 'GET'
    when 'projects/update' then 'POST' when 'projects/change-researcher' then 'POST'
    when 'monitoring/list' then 'GET' when 'monitoring/detail' then 'GET'
    when 'participants/list' then 'GET' when 'participants/detail' then 'GET' when 'participants/history' then 'GET'
    when 'participants/add' then 'POST' when 'participants/remove' then 'POST' when 'participants/update' then 'POST'
    when 'activities/list' then 'GET' when 'activities/detail' then 'GET' when 'activities/history' then 'GET'
    when 'activities/create' then 'POST' when 'activities/update' then 'POST' when 'activities/reassign' then 'POST'
    when 'activities/start' then 'POST' when 'activities/submit' then 'POST' when 'activities/review' then 'POST'
    when 'milestones/list' then 'GET' when 'milestones/detail' then 'GET' when 'milestones/history' then 'GET'
    when 'milestones/create' then 'POST' when 'milestones/update' then 'POST' when 'milestones/achieve' then 'POST'
    when 'documents/list' then 'GET' when 'documents/detail' then 'GET' when 'documents/versions' then 'GET'
    when 'documents/download' then 'GET' when 'documents/upload' then 'POST' when 'documents/upload-version' then 'POST'
    when 'documents/update' then 'POST' when 'documents/delete' then 'POST' when 'documents/set-block' then 'POST'
    when 'documents/set-restriction' then 'POST'
    when 'evidence/list' then 'GET' when 'evidence/versions' then 'GET' when 'evidence/download' then 'GET'
    when 'evidence/upload' then 'POST'
    when 'institutional-documents/list' then 'GET' when 'institutional-documents/detail' then 'GET'
    when 'institutional-documents/versions' then 'GET' when 'institutional-documents/download' then 'GET'
    when 'institutional-documents/upload' then 'POST' when 'institutional-documents/update' then 'POST'
    when 'institutional-documents/delete' then 'POST'
    when 'closures/list' then 'GET' when 'closures/detail' then 'GET' when 'closures/history' then 'GET'
    when 'closures/request' then 'POST' when 'closures/review' then 'POST'
    when 'reports/project' then 'POST' when 'reports/general' then 'POST'
    when 'assistant/context' then 'POST' when 'assistant/query' then 'POST'
    else null end;
$$;

create or replace function public.research_api(ruta text, metodo text default 'GET', datos jsonb default '{}'::jsonb, token text default null)
returns jsonb
language plpgsql
security definer
set search_path = research, extensions, pg_temp
set timezone to 'America/Mexico_City'
as $$
declare
  m text; a text; method text := upper(coalesce(metodo, 'GET')); expected text; u research.users;
  is_post boolean; d jsonb := coalesce(datos, '{}'::jsonb); v_state text; v_msg text;
begin
  if ruta is null or ruta !~ '^[a-z-]+/[a-z-]+\.php$' then
    return research.ok(jsonb_build_object('message', 'Operación no disponible.'), 404);
  end if;
  m := split_part(ruta, '/', 1);
  a := regexp_replace(split_part(ruta, '/', 2), '\.php$', '');
  expected := research.route_method(m, a);
  if expected is null then return research.ok(jsonb_build_object('message', 'Operación no disponible.'), 404); end if;
  if expected <> method then return research.ok(jsonb_build_object('message', 'Método no permitido.'), 405); end if;
  if jsonb_typeof(d) <> 'object' then return research.ok(jsonb_build_object('message', 'Envía un objeto JSON.'), 400); end if;
  is_post := method = 'POST';

  begin
    if m = 'api' then
      return research.ok(jsonb_build_object('status', 'ok', 'database', 'connected', 'version', 2));
    elsif m = 'auth' and a = 'login' then
      return research.auth_login(d);
    elsif m = 'auth' and a = 'logout' then
      return research.auth_logout(token);
    end if;

    u := research.require_user(token);

    return case
      when m = 'auth' then research.ok(jsonb_build_object('user', research.public_user(u)))
      when m = 'users' then research.ep_users(u, a, d)
      when m = 'catalogs' then research.ep_catalogs(u, a, d)
      when m in ('proposals', 'evaluations') then research.ep_proposals(u, m, a, d)
      when m = 'dashboard' then research.ep_dashboard(u)
      when m in ('projects', 'monitoring') then research.ep_projects(u, a, d, is_post)
      when m = 'participants' then research.ep_participants(u, a, d, is_post)
      when m = 'activities' then research.ep_activities(u, a, d, is_post)
      when m = 'milestones' then research.ep_milestones(u, a, d, is_post)
      when m = 'closures' then research.ep_closures(u, a, d, is_post)
      when m in ('documents', 'evidence', 'institutional-documents') then research.ep_documents(u, m, a, d, is_post)
      when m = 'reports' then research.ep_reports(u, a, d)
      when m = 'assistant' then research.ep_assistant(u, a, d)
      else research.ok(jsonb_build_object('message', 'Módulo no disponible.'), 404)
    end;
  exception when others then
    -- Cualquier error deshace TODO lo que hizo la operación (transacción).
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state like 'RS%' then
      return research.ok(jsonb_build_object('message', v_msg), substr(v_state, 3)::integer);
    elsif v_state = '23505' then
      return research.ok(jsonb_build_object('message', 'El registro ya existe.'), 409);
    elsif v_state = '23503' then
      return research.ok(jsonb_build_object('message', 'El registro está relacionado con otro que no existe o no se puede modificar.'), 409);
    elsif v_state in ('22001', '22003') then
      return research.ok(jsonb_build_object('message', 'Un valor es demasiado largo o está fuera de rango.'), 422);
    elsif v_state in ('22P02', '22007', '22008') then
      return research.ok(jsonb_build_object('message', 'Revisa el formato de los datos enviados.'), 422);
    end if;
    raise warning 'research_api % falló: % %', ruta, v_state, v_msg;
    return research.ok(jsonb_build_object('message', 'No se pudo completar la operación. Intenta de nuevo.', 'code', v_state), 500);
  end;
end $$;

-- ------------------------------------------------------------------
-- Funciones de administración (solo desde el SQL Editor de Supabase)
-- ------------------------------------------------------------------
create or replace function research.crear_coordinador_inicial(nombre text, usuario text, correo text, contrasena text)
returns text language plpgsql
set search_path = research, extensions, pg_temp as $$
begin
  if not research.valid_password(contrasena) then
    raise exception 'La contraseña necesita de 8 a 72 caracteres con mayúscula, minúscula y número.';
  end if;
  if exists (select 1 from research.users where lower(username) = lower(usuario)) then
    raise exception 'El usuario % ya existe.', usuario;
  end if;
  insert into research.users (name, username, email, password_hash, role)
    values (nombre, usuario, nullif(correo, ''), research.hash_password(contrasena), 'coordinator');
  return 'Cuenta de Coordinación creada: ' || usuario;
end $$;

create or replace function research.restablecer_contrasena(usuario text, nueva text)
returns text language plpgsql
set search_path = research, extensions, pg_temp as $$
begin
  if not research.valid_password(nueva) then
    raise exception 'La contraseña necesita de 8 a 72 caracteres con mayúscula, minúscula y número.';
  end if;
  update research.users set password_hash = research.hash_password(nueva), status = 'active', updated_at = now()
    where lower(username) = lower(usuario);
  if not found then raise exception 'No existe el usuario %.', usuario; end if;
  update research.user_sessions set revoked_at = now() where revoked_at is null
    and user_id = (select id from research.users where lower(username) = lower(usuario));
  return 'Contraseña actualizada para ' || usuario;
end $$;

-- ------------------------------------------------------------------
-- Permisos: el esquema research queda cerrado; solo research_api es pública.
-- ------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then return; end if;
  execute 'revoke all on schema research from public, anon, authenticated';
  execute 'revoke all on all tables in schema research from public, anon, authenticated';
  execute 'revoke all on all sequences in schema research from public, anon, authenticated';
  execute 'revoke execute on all functions in schema research from public, anon, authenticated';
  execute 'alter default privileges in schema research revoke execute on functions from public, anon, authenticated';
  execute 'revoke execute on function public.research_api(text, text, jsonb, text) from public';
  execute 'grant execute on function public.research_api(text, text, jsonb, text) to anon, authenticated';
end $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then return; end if;
  -- Subir archivos de hasta 5 MB puede tardar más que el límite por defecto (3 s) de Supabase.
  execute 'alter role anon set statement_timeout = ''30s''';
  execute 'alter role authenticated set statement_timeout = ''30s''';
  perform pg_notify('pgrst', 'reload config');
  perform pg_notify('pgrst', 'reload schema');
exception when insufficient_privilege then
  raise notice 'No se pudieron ajustar algunos permisos (%). La API funciona igual.', sqlerrm;
end $$;
