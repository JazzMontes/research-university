-- =====================================================================
-- URPMP · 03 · Usuarios, catálogos, propuestas y tablero (versión 3)
-- Flujo de propuestas (sin evaluador):
--  Estudiante registra → Investigador responsable revisa → Coordinación decide.
--  Investigador registra su propia propuesta → Coordinación decide.
--  Quien revisa puede: Aprobar · Solicitar cambios · Rechazar.
--  Cuando Coordinación aprueba se crea el proyecto automáticamente.
--  Con "Cambios solicitados" el autor corrige y reenvía en un solo paso;
--  la propuesta regresa a quien pidió los cambios.
--  El autor o Coordinación pueden cancelar (y reactivar si fue un error).
-- =====================================================================

create or replace function research.user_json(t research.users)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', t.id, 'name', t.name, 'username', t.username, 'email', t.email,
    'role', t.role, 'status', t.status, 'created_at', t.created_at, 'updated_at', t.updated_at,
    'temporary_password', coalesce(t.must_change_password, 0) = 1);
$$;

create or replace function research.valid_username(v text)
returns void language plpgsql
set search_path = research, extensions, pg_temp as $$
begin
  if v !~ '^[A-Za-z0-9._-]{3,80}$' then
    perform research.fail(422, 'El usuario debe tener al menos 3 caracteres: letras, números, punto, guion o guion bajo (sin espacios).');
  end if;
end $$;

create or replace function research.valid_email(v text)
returns void language plpgsql
set search_path = research, extensions, pg_temp as $$
begin
  if v <> '' and v !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then perform research.fail(422, 'Correo inválido.'); end if;
end $$;

-- Antes de cambiar el rol o desactivar una cuenta, se revisa que no deje trabajo sin dueño.
create or replace function research.user_can_leave(t research.users, new_role text, new_status text)
returns void language plpgsql
set search_path = research, extensions, pg_temp as $$
declare titles text;
begin
  if t.role in ('researcher', 'coordinator') and (new_role not in ('researcher', 'coordinator') or new_status = 'inactive') then
    select string_agg('«' || title || '»', ', ') into titles from research.projects
      where responsible_researcher_id = t.id and status in ('active', 'changes', 'closing');
    if titles is not null then
      perform research.fail(409, 'Es investigador responsable de ' || titles || '. Primero cambia el responsable desde el proyecto.');
    end if;
    select string_agg('«' || title || '»', ', ') into titles from research.proposals
      where responsible_researcher_id = t.id and author_id <> t.id and status = 'pending_researcher_review';
    if titles is not null then
      perform research.fail(409, 'Tiene propuestas de estudiantes por revisar: ' || titles || '. Pídele que las revise o que el autor cancele.');
    end if;
  end if;
  if new_status = 'inactive' then
    select string_agg(distinct '«' || p.title || '»', ', ') into titles
      from research.activities a join research.projects p on p.id = a.project_id
      where a.participant_id = t.id and a.status in ('pending', 'in_review', 'changes') and p.status in ('active', 'changes', 'closing');
    if titles is not null then
      perform research.fail(409, 'Tiene actividades sin terminar en ' || titles || '. Retíralo del equipo (sus actividades se reasignan) o reasígnalas primero.');
    end if;
  end if;
end $$;

create or replace function research.ep_users(u research.users, act text, d jsonb)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare
  t research.users; v_role text; v_pwd text; v_email text; v_status text; v_name text; v_username text;
begin
  if u.role <> 'coordinator' then perform research.fail(403, 'Solo Coordinación administra usuarios.'); end if;

  if act = 'list' then
    return research.ok(jsonb_build_object('items',
      (select coalesce(jsonb_agg(research.user_json(x) order by x.status, x.name, x.id), '[]') from research.users x where x.deleted_at is null)));
  end if;

  if act = 'create' then
    v_role := research.req_text(d, 'role', 30);
    if v_role not in ('student','researcher','coordinator') then perform research.fail(422, 'Rol inválido.'); end if;
    v_pwd := research.req_text(d, 'password', 72);
    if not research.valid_password(v_pwd) then perform research.fail(422, 'La contraseña necesita de 8 a 72 caracteres con mayúscula, minúscula y número.'); end if;
    v_email := research.opt_text(d, 'email', 254);
    perform research.valid_email(v_email);
    v_name := research.req_text(d, 'name', 150);
    v_username := research.req_text(d, 'username', 80);
    perform research.valid_username(v_username);
    if exists (select 1 from research.users where lower(username) = lower(v_username)) then
      perform research.fail(409, 'Ese nombre de usuario ya existe. Elige otro.');
    end if;
    if v_email <> '' and exists (select 1 from research.users where lower(email) = lower(v_email)) then
      perform research.fail(409, 'Ya hay una cuenta con ese correo. Revisa que no estés duplicando a la persona.');
    end if;
    -- La contraseña que pone Coordinación es temporal: se cambia en el primer inicio de sesión.
    insert into research.users (name, username, email, password_hash, role, must_change_password)
      values (v_name, v_username, nullif(v_email, ''), research.hash_password(v_pwd), v_role, 1)
      returning * into t;
    return research.ok(jsonb_build_object('user', research.user_json(t)), 201);
  end if;

  select * into t from research.users where id = research.req_id(d, 'user_id') and deleted_at is null for update;
  if t.id is null then perform research.fail(404, 'Usuario no encontrado.'); end if;

  if act = 'delete' then
    -- Eliminar definitivamente. Si la persona dejó historial (propuestas, actividades, documentos…),
    -- sus datos personales se borran y su nombre aparece como "Usuario eliminado" para no romper ese historial.
    if t.id = u.id then perform research.fail(409, 'No puedes eliminar tu propia cuenta.'); end if;
    perform research.user_can_leave(t, t.role, 'inactive');
    begin
      delete from research.user_sessions where user_id = t.id;
      delete from research.participants where user_id = t.id;
      delete from research.users where id = t.id;
      return research.ok(jsonb_build_object('deleted', t.id, 'mode', 'deleted'));
    exception when foreign_key_violation then
      update research.participants set is_active = 0, removed_at = coalesce(removed_at, now()) where user_id = t.id;
      update research.user_sessions set revoked_at = now() where user_id = t.id and revoked_at is null;
      delete from research.notifications where user_id = t.id;
      delete from research.assistant_chats where user_id = t.id;
      update research.users set name = 'Usuario eliminado', username = 'eliminado.' || t.id, email = null, avatar = null,
        password_hash = research.hash_password(encode(extensions.gen_random_bytes(18), 'hex') || 'Aa1'),
        status = 'inactive', must_change_password = 0, deleted_at = now(), updated_at = now() where id = t.id;
      return research.ok(jsonb_build_object('deleted', t.id, 'mode', 'anonymized'));
    end;
  end if;

  if act = 'update' then
    -- Un solo formulario: datos, rol y estado.
    v_name := research.req_text(d, 'name', 150);
    v_username := research.req_text(d, 'username', 80);
    perform research.valid_username(v_username);
    if exists (select 1 from research.users where lower(username) = lower(v_username) and id <> t.id) then
      perform research.fail(409, 'Ese nombre de usuario ya existe. Elige otro.');
    end if;
    v_email := research.opt_text(d, 'email', 254);
    perform research.valid_email(v_email);
    if v_email <> '' and exists (select 1 from research.users where lower(email) = lower(v_email) and id <> t.id) then
      perform research.fail(409, 'Ya hay otra cuenta con ese correo.');
    end if;
    v_role := coalesce(nullif(research.opt_text(d, 'role', 30), ''), t.role);
    if v_role not in ('student','researcher','coordinator') then perform research.fail(422, 'Rol inválido.'); end if;
    v_status := coalesce(nullif(research.opt_text(d, 'status', 10), ''), t.status);
    if v_status not in ('active', 'inactive') then perform research.fail(422, 'Estado inválido.'); end if;
    if t.id = u.id and v_role <> u.role then perform research.fail(409, 'No puedes cambiar tu propio rol.'); end if;
    if t.id = u.id and v_status = 'inactive' then perform research.fail(409, 'No puedes desactivar tu propia cuenta.'); end if;
    if v_role <> t.role or (v_status = 'inactive' and t.status = 'active') then
      perform research.user_can_leave(t, v_role, v_status);
    end if;
    update research.users set name = v_name, username = v_username, email = nullif(v_email, ''),
      role = v_role, status = v_status, updated_at = now() where id = t.id;
    if v_role <> t.role or v_status <> t.status then
      update research.user_sessions set revoked_at = now() where user_id = t.id and revoked_at is null;
    end if;
  elsif act = 'reset-password' then
    v_pwd := research.req_text(d, 'password', 72);
    if not research.valid_password(v_pwd) then perform research.fail(422, 'La contraseña necesita de 8 a 72 caracteres con mayúscula, minúscula y número.'); end if;
    update research.users set password_hash = research.hash_password(v_pwd), must_change_password = 1, updated_at = now() where id = t.id;
    update research.user_sessions set revoked_at = now() where user_id = t.id and revoked_at is null;
  else
    perform research.fail(404, 'Operación no disponible.');
  end if;

  select * into t from research.users where id = t.id;
  return research.ok(jsonb_build_object('user', research.user_json(t)));
end $$;

-- ------------------------------------------------------------------
create or replace function research.ep_catalogs(u research.users, act text, d jsonb)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare p research.projects;
begin
  if act = 'researchers' then
    return research.ok(jsonb_build_object('items', (
      -- Coordinación también puede ser investigadora responsable.
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name || case when role = 'coordinator' then ' (Coordinación)' else '' end)
                                order by name), '[]')
      from research.users where status = 'active' and role in ('researcher', 'coordinator') and deleted_at is null)));
  elsif act = 'participants' then
    p := research.project_access(u, research.req_id(d, 'project_id'));
    if coalesce(d ->> 'all', '') = '1' then
      perform research.project_lead(p, u);
      -- Cuentas que todavía no participan activamente (para "Agregar integrante").
      return research.ok(jsonb_build_object('items', (
        select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'role', x.role) order by x.name), '[]')
        from research.users x where x.status = 'active' and x.deleted_at is null
          and not exists (select 1 from research.participants t where t.project_id = p.id and t.user_id = x.id and t.is_active = 1))));
    end if;
    return research.ok(jsonb_build_object('items', (
      select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'role', x.role) order by x.name), '[]')
      from research.participants t join research.users x on x.id = t.user_id
      where t.project_id = p.id and t.is_active = 1 and x.status = 'active')));
  end if;
  perform research.fail(404, 'Catálogo no disponible.');
  return null;
end $$;

-- ------------------------------------------------------------------
create or replace function research.proposal_json(p research.proposals)
returns jsonb language sql stable
set search_path = research, extensions, pg_temp as $$
  select to_jsonb(p) - 'is_archived' - 'status_before_archive' - 'correction_pending_resubmit' || jsonb_build_object(
    'researcher_name', (select name from research.users where id = p.responsible_researcher_id),
    'author_name', (select name from research.users where id = p.author_id),
    'author_role', (select role from research.users where id = p.author_id),
    'project_id', (select id from research.projects where proposal_id = p.id),
    'project_status', (select status from research.projects where proposal_id = p.id),
    'file', (select jsonb_build_object('document_id', dd.id, 'filename', v.filename, 'size_bytes', v.size_bytes)
             from research.documents dd join research.document_versions v on v.document_id = dd.id
             where dd.proposal_id = p.id and dd.deleted_at is null order by v.id desc limit 1),
    'change_request', (select to_jsonb(c) || jsonb_build_object('requester_name', x.name)
                       from research.researcher_change_requests c join research.users x on x.id = c.requested_by
                       where c.proposal_id = p.id and c.status = 'pending' order by c.id desc limit 1),
    -- Última observación de quien revisó (se muestra al autor para corregir).
    'last_observation', (select jsonb_build_object('details', h.details, 'actor_name', x.name, 'action', h.action, 'created_at', h.created_at)
                         from research.proposal_history h left join research.users x on x.id = h.actor_id
                         where h.proposal_id = p.id and h.details is not null
                           and h.action in ('review_changes_requested', 'review_rejected', 'review_approved', 'cancelled')
                         order by h.id desc limit 1));
$$;

create or replace function research.proposal_history_add(pid integer, actor integer, act text, before_s text, after_s text, details text default null)
returns void language sql
set search_path = research, extensions, pg_temp as $$
  insert into research.proposal_history (proposal_id, actor_id, action, previous_status, new_status, details)
  values (pid, actor, act, before_s, after_s, nullif(details, ''));
$$;

-- La propuesta aprobada se convierte en proyecto (con su archivo, si tenía).
create or replace function research.proposal_to_project(p research.proposals, actor integer)
returns integer language plpgsql
set search_path = research, extensions, pg_temp as $$
declare new_project integer;
begin
  if not exists (select 1 from research.users where id = p.responsible_researcher_id and role in ('researcher', 'coordinator') and status = 'active') then
    perform research.fail(409, 'El investigador responsable ya no está activo. Cambia al responsable o solicita cambios al autor.');
  end if;
  insert into research.projects (proposal_id, title, description, objectives, responsible_researcher_id)
    values (p.id, p.title, p.description, p.objectives, p.responsible_researcher_id) returning id into new_project;
  insert into research.participants (project_id, user_id, project_role)
    select new_project, x, case when x = p.responsible_researcher_id then 'Investigador responsable' else 'Autor de la propuesta' end
    from (select distinct unnest(array[p.responsible_researcher_id, p.author_id]) as x) s
    on conflict (project_id, user_id) do nothing;
  update research.documents set project_id = new_project, kind = 'project' where proposal_id = p.id and deleted_at is null;
  perform research.event_project(new_project, actor, 'project', new_project, 'created_from_proposal', jsonb_build_object('proposal_id', p.id));
  return new_project;
end $$;

-- Archivo opcional de la propuesta (se guarda como documento y pasa al proyecto al aprobarse).
create or replace function research.proposal_file_save(pid integer, actor integer, d jsonb)
returns void language plpgsql
set search_path = research, extensions, pg_temp as $$
declare did integer;
begin
  if coalesce(d ->> 'file_base64', '') = '' then return; end if;
  select id into did from research.documents where proposal_id = pid and deleted_at is null order by id desc limit 1;
  if did is null then
    insert into research.documents (proposal_id, title, kind, created_by)
      values (pid, coalesce(nullif(regexp_replace(research.req_text(d, 'filename', 255), '\.[^.]+$', ''), ''), 'Archivo de la propuesta'), 'proposal', actor)
      returning id into did;
  end if;
  perform research.save_version(did, actor, d);
end $$;

create or replace function research.proposal_set_researcher(p research.proposals, uid integer, actor integer, why text)
returns void language plpgsql
set search_path = research, extensions, pg_temp as $$
begin
  if p.status in ('approved', 'rejected', 'cancelled') then
    perform research.fail(409, case p.status when 'approved' then 'Ya es un proyecto: cambia al responsable desde el proyecto.' else 'La propuesta ya está cerrada.' end);
  end if;
  if uid = p.responsible_researcher_id then perform research.fail(422, 'Esa persona ya es la responsable.'); end if;
  perform research.active_role(uid, 'researcher');
  update research.proposals set responsible_researcher_id = uid, updated_at = now() where id = p.id;
  perform research.proposal_history_add(p.id, actor, 'researcher_changed', p.status, p.status,
    'Investigador responsable: ' || (select name from research.users where id = p.responsible_researcher_id) || ' → '
    || (select name from research.users where id = uid) || coalesce('. Motivo: ' || nullif(why, ''), ''));
end $$;

create or replace function research.ep_proposals(u research.users, act text, d jsonb)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare
  p research.proposals; pj research.projects; pid integer; researcher integer; v_status text; before_s text; after_s text;
  obs text; decision text; new_project integer; v_limit integer; v_page integer; v_total integer;
  v_search text; v_filter text; log_action text;
begin
  if act = 'list' then
    v_filter := coalesce(d ->> 'status', '');
    v_search := coalesce(btrim(d ->> 'search'), '');
    v_limit := greatest(1, least(100, coalesce(nullif(d ->> 'limit', '')::integer, 20)));
    v_page := greatest(1, least(100000, coalesce(nullif(d ->> 'page', '')::integer, 1)));
    select count(*) into v_total from research.proposals x
      where research.proposal_visible(u, x)
        and (v_filter = '' or x.status = v_filter or (v_filter = 'in_review' and x.status in ('pending_researcher_review', 'pending_coordinator')))
        and (v_search = '' or extensions.unaccent(lower(x.title)) like '%' || extensions.unaccent(lower(v_search)) || '%');
    return research.ok(jsonb_build_object('page', v_page, 'limit', v_limit, 'total', v_total, 'items', (
      select coalesce(jsonb_agg(research.proposal_json(y) order by y.id desc), '[]') from (
        select x.* from research.proposals x
        where research.proposal_visible(u, x)
          and (v_filter = '' or x.status = v_filter or (v_filter = 'in_review' and x.status in ('pending_researcher_review', 'pending_coordinator')))
          and (v_search = '' or extensions.unaccent(lower(x.title)) like '%' || extensions.unaccent(lower(v_search)) || '%')
        order by x.id desc limit v_limit offset (v_page - 1) * v_limit) y)));
  end if;

  if act = 'create' then
    researcher := case when u.role = 'student' then research.req_id(d, 'responsible_researcher_id') else u.id end;
    perform research.active_role(researcher, 'researcher');
    -- Estudiante → su investigador; investigador → Coordinación; Coordinación → proyecto directo (con justificación).
    v_status := case u.role when 'student' then 'pending_researcher_review' when 'researcher' then 'pending_coordinator' else 'approved' end;
    insert into research.proposals (title, description, objectives, author_id, responsible_researcher_id, status, justification)
      values (research.req_text(d, 'title', 250), research.req_text(d, 'description', 65535),
              research.req_text(d, 'objectives', 65535), u.id, researcher, v_status,
              case when u.role = 'coordinator' then research.req_text(d, 'justification', 65535) else nullif(research.opt_text(d, 'justification', 65535), '') end)
      returning * into p;
    pid := p.id;
    perform research.proposal_file_save(pid, u.id, d);
    perform research.proposal_history_add(pid, u.id, 'created', null, v_status, case u.role
      when 'student' then 'Enviada al investigador responsable.'
      when 'researcher' then 'Propuesta propia del investigador: pasa directo a Coordinación.'
      else 'Propuesta de Coordinación: se aprueba directamente como proyecto.' end);
    if v_status = 'approved' then new_project := research.proposal_to_project(p, u.id); end if;
    return research.ok(jsonb_build_object('proposal_id', pid, 'status', v_status, 'project_id', new_project), 201);
  end if;

  pid := research.req_id(d, 'proposal_id');
  select * into p from research.proposals where id = pid for update;
  if p.id is null or not research.proposal_visible(u, p) then perform research.fail(404, 'Propuesta no disponible.'); end if;
  before_s := p.status; after_s := before_s; obs := null; log_action := act;

  if act = 'detail' then
    return research.ok(jsonb_build_object('proposal', research.proposal_json(p)));
  elsif act = 'download-file' then
    return research.ok((select jsonb_build_object('filename', v.filename, 'mime', v.mime,
        'content_base64', replace(encode(v.content, 'base64'), E'\n', ''))
      from research.documents dd join research.document_versions v on v.document_id = dd.id
      where dd.proposal_id = pid and dd.deleted_at is null order by v.id desc limit 1));
  elsif act = 'change-researcher' then
    if u.role <> 'coordinator' then perform research.fail(403, 'Solo Coordinación cambia al investigador responsable.'); end if;
    perform research.proposal_set_researcher(p, research.req_id(d, 'researcher_id'), u.id, research.opt_text(d, 'reason', 2000));
    return research.ok(jsonb_build_object('proposal_id', pid, 'status', before_s));
  elsif act = 'history' then
    return research.ok(jsonb_build_object('items', (
      select coalesce(jsonb_agg(to_jsonb(h) || jsonb_build_object('actor_name', x.name, 'actor_role', x.role) order by h.id desc), '[]')
      from research.proposal_history h left join research.users x on x.id = h.actor_id where h.proposal_id = pid)));

  elsif act = 'update' then
    -- Corregir y reenviar en un solo paso.
    if p.author_id <> u.id then perform research.fail(403, 'Solo el autor puede corregir la propuesta.'); end if;
    if before_s <> 'changes_requested' then perform research.fail(409, 'La propuesta no tiene cambios solicitados.'); end if;
    update research.proposals set title = research.req_text(d, 'title', 250),
      description = research.req_text(d, 'description', 65535), objectives = research.req_text(d, 'objectives', 65535),
      updated_at = now() where id = pid;
    perform research.proposal_file_save(pid, u.id, d);
    after_s := coalesce(p.returns_to, case when u.role = 'student' then 'pending_researcher_review' else 'pending_coordinator' end);
    -- Si el estudiante eligió mal al investigador, lo corrige aquí; el nuevo investigador la revisa desde el inicio.
    if u.role = 'student' and research.has(d, 'responsible_researcher_id') then
      researcher := research.req_id(d, 'responsible_researcher_id');
      if researcher <> p.responsible_researcher_id then
        perform research.active_role(researcher, 'researcher');
        after_s := 'pending_researcher_review';
        update research.proposals set responsible_researcher_id = researcher where id = pid;
        obs := 'Nuevo investigador responsable: ' || (select name from research.users where id = researcher) || '. ';
      end if;
    end if;
    update research.proposals set returns_to = null where id = pid;
    obs := coalesce(obs, '') || case when after_s = 'pending_coordinator' then 'Corregida y reenviada a Coordinación.' else 'Corregida y reenviada al investigador responsable.' end;
    log_action := 'resubmit';

  elsif act = 'review' then
    -- Revisa quien tiene la propuesta en su bandeja: el investigador responsable o Coordinación.
    if before_s = 'pending_researcher_review' then
      if u.role not in ('researcher', 'coordinator') or p.responsible_researcher_id <> u.id then
        perform research.fail(403, 'Esta propuesta la revisa el investigador responsable.');
      end if;
    elsif before_s = 'pending_coordinator' then
      if u.role <> 'coordinator' then perform research.fail(403, 'Esta propuesta la revisa Coordinación.'); end if;
    else
      perform research.fail(409, 'La propuesta no está esperando revisión.');
    end if;
    decision := research.req_text(d, 'decision', 30);
    if decision not in ('approved', 'changes_requested', 'rejected') then perform research.fail(422, 'Decisión inválida.'); end if;
    obs := case when decision = 'approved' then research.opt_text(d, 'observations', 65535)
                else research.req_text(d, 'observations', 65535) end;
    after_s := case decision
      -- Si el responsable es de Coordinación, su aprobación ya es la final.
      when 'approved' then case when before_s = 'pending_researcher_review' and u.role <> 'coordinator' then 'pending_coordinator' else 'approved' end
      when 'changes_requested' then 'changes_requested' else 'rejected' end;
    if decision = 'changes_requested' then update research.proposals set returns_to = before_s where id = pid; end if;
    if after_s = 'approved' then new_project := research.proposal_to_project(p, u.id); end if;
    log_action := 'review_' || decision;

  elsif act = 'cancel' then
    -- Error humano típico: se envió una propuesta por equivocación o ya no se hará.
    if not (p.author_id = u.id or u.role = 'coordinator') then perform research.fail(403, 'Solo el autor o Coordinación pueden cancelar la propuesta.'); end if;
    if before_s in ('rejected', 'cancelled') then
      perform research.fail(409, case before_s when 'cancelled' then 'La propuesta ya está cancelada.' else 'La propuesta ya fue rechazada.' end);
    end if;
    obs := research.req_text(d, 'reason', 2000);
    -- Una propuesta aprobada ya es un proyecto: cancelarla también cancela el proyecto (si no se completó).
    if before_s = 'approved' then
      select * into pj from research.projects where proposal_id = pid for update;
      if pj.status = 'finalized' then
        perform research.fail(409, 'El proyecto de esta propuesta ya se completó; no se puede cancelar.');
      end if;
      if pj.id is not null and pj.status <> 'cancelled' then
        update research.closures set status = 'changes_requested', review_observations = 'Propuesta cancelada: ' || obs,
          reviewed_by = u.id, reviewed_at = now() where project_id = pj.id and status = 'pending';
        update research.projects set status = 'cancelled', status_note = 'Se canceló la propuesta: ' || obs, updated_at = now() where id = pj.id;
        perform research.event_project(pj.id, u.id, 'project', pj.id, 'cancelled', jsonb_build_object('reason', 'Se canceló la propuesta: ' || obs));
      end if;
    end if;
    after_s := 'cancelled';
    update research.proposals set status_before_cancel = before_s where id = pid;
    log_action := 'cancelled';

  elsif act = 'reactivate' then
    -- Deshace una cancelación hecha por error: vuelve exactamente a donde estaba.
    if not (p.author_id = u.id or u.role = 'coordinator') then perform research.fail(403, 'Solo el autor o Coordinación pueden reactivar la propuesta.'); end if;
    if before_s <> 'cancelled' then perform research.fail(409, 'La propuesta no está cancelada.'); end if;
    after_s := coalesce(p.status_before_cancel, case when (select role from research.users where id = p.author_id) = 'student'
                                                       then 'pending_researcher_review' else 'pending_coordinator' end);
    -- Si era un proyecto, se reabre (solo si se canceló junto con la propuesta).
    if after_s = 'approved' then
      select * into pj from research.projects where proposal_id = pid for update;
      if pj.id is not null and pj.status = 'cancelled' then
        if not exists (select 1 from research.users where id = pj.responsible_researcher_id and role in ('researcher', 'coordinator') and status = 'active') then
          perform research.fail(409, 'El investigador responsable del proyecto ya no está activo. Pide a Coordinación que lo cambie antes de reactivar.');
        end if;
        update research.projects set status = 'active', status_note = null, updated_at = now() where id = pj.id;
        perform research.event_project(pj.id, u.id, 'project', pj.id, 'reopened', jsonb_build_object('before', 'cancelled', 'reason', 'Se reactivó la propuesta.'));
      end if;
    end if;
    if after_s = 'pending_researcher_review' then perform research.active_role(p.responsible_researcher_id, 'researcher'); end if;
    update research.proposals set status_before_cancel = null where id = pid;
    obs := 'Reactivada.';
    log_action := 'reactivated';
  else
    perform research.fail(404, 'Operación no disponible.');
  end if;

  if before_s <> after_s then update research.proposals set status = after_s, updated_at = now() where id = pid; end if;
  perform research.proposal_history_add(pid, u.id, log_action, before_s, after_s, obs);
  return research.ok(jsonb_build_object('proposal_id', pid, 'status', after_s, 'project_id', new_project));
end $$;

-- ------------------------------------------------------------------
-- Tablero: lo que cada persona tiene que hacer, sin buscarlo en el menú.
-- ------------------------------------------------------------------
create or replace function research.activity_brief(a research.activities)
returns jsonb language sql stable
set search_path = research, extensions, pg_temp as $$
  select jsonb_build_object('id', a.id, 'description', a.description, 'status', a.status, 'deadline', a.deadline,
    'deadline_status', research.deadline_status(a.status, a.deadline), 'project_id', a.project_id,
    'project_title', (select title from research.projects where id = a.project_id),
    'participant_name', (select name from research.users where id = a.participant_id));
$$;

create or replace function research.ep_dashboard(u research.users)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare todo jsonb := '[]'::jsonb; stats jsonb; charts jsonb; n integer; mine jsonb := '[]'; review jsonb := '[]';
        requests jsonb := '[]'; vis integer[];
begin
  -- Proyectos que esta persona puede ver (Coordinación: todos).
  select coalesce(array_agg(p.id), '{}') into vis from research.projects p where research.project_visible(u, p.id);

  select count(*) into n from research.proposals where author_id = u.id and status = 'changes_requested';
  if n > 0 then todo := todo || jsonb_build_object('label', 'Propuestas que debes corregir', 'count', n, 'link', 'proposals', 'filter', 'changes_requested', 'tone', 'changes'); end if;
  select coalesce(jsonb_agg(research.activity_brief(a) order by a.deadline), '[]') into mine
    from research.activities a join research.projects p on p.id = a.project_id
    where a.participant_id = u.id and a.status in ('pending', 'changes', 'in_review') and p.status in ('active', 'changes');

  if u.role in ('researcher', 'coordinator') then
    select count(*) into n from research.proposals where responsible_researcher_id = u.id and author_id <> u.id and status = 'pending_researcher_review';
    if n > 0 then todo := todo || jsonb_build_object('label', 'Propuestas de estudiantes por revisar', 'count', n, 'link', 'proposals', 'filter', 'pending_researcher_review', 'tone', 'progress'); end if;
    select count(*) into n from research.projects where responsible_researcher_id = u.id and status = 'changes';
    if n > 0 then todo := todo || jsonb_build_object('label', 'Proyectos con cambios pedidos por Coordinación', 'count', n, 'link', 'projects', 'filter', 'changes', 'tone', 'changes'); end if;
    select coalesce(jsonb_agg(research.activity_brief(a) order by a.updated_at), '[]') into review
      from research.activities a join research.projects p on p.id = a.project_id
      where p.responsible_researcher_id = u.id and a.status = 'in_review' and p.status in ('active', 'changes');
  end if;
  if u.role = 'coordinator' then
    select count(*) into n from research.proposals where status = 'pending_coordinator';
    if n > 0 then todo := todo || jsonb_build_object('label', 'Propuestas esperando tu decisión', 'count', n, 'link', 'proposals', 'filter', 'pending_coordinator', 'tone', 'progress'); end if;
    select count(*) into n from research.projects where status = 'closing';
    if n > 0 then todo := todo || jsonb_build_object('label', 'Solicitudes de cierre por revisar', 'count', n, 'link', 'projects', 'filter', 'closing', 'tone', 'progress'); end if;
    select coalesce(jsonb_agg(research.change_request_json(c) order by c.id), '[]') into requests
      from research.researcher_change_requests c where c.status = 'pending';
  end if;

  stats := jsonb_build_array(
    jsonb_build_object('label', 'Proyectos en curso', 'link', 'projects', 'filter', 'open', 'value',
      (select count(*) from research.projects p where p.id = any(vis) and p.status in ('active', 'changes', 'closing'))),
    jsonb_build_object('label', 'Proyectos completados', 'link', 'projects', 'filter', 'finalized', 'value',
      (select count(*) from research.projects p where p.id = any(vis) and p.status = 'finalized')),
    jsonb_build_object('label', 'Propuestas en revisión', 'link', 'proposals', 'filter', 'in_review', 'value',
      (select count(*) from research.proposals x where x.status in ('pending_researcher_review', 'pending_coordinator') and research.proposal_visible(u, x))));

  -- Datos para las gráficas del inicio.
  charts := jsonb_build_object(
    'projects', (select coalesce(jsonb_object_agg(status, total), '{}') from (
        select status, count(*) total from research.projects where id = any(vis) group by status) s),
    'proposals', (select coalesce(jsonb_object_agg(status, total), '{}') from (
        select status, count(*) total from research.proposals x where research.proposal_visible(u, x) group by status) s),
    'activities', (select coalesce(jsonb_object_agg(status, total), '{}') from (
        select a.status, count(*) total from research.activities a join research.projects p on p.id = a.project_id
        where a.project_id = any(vis) and a.status <> 'cancelled' and p.status <> 'cancelled' group by a.status) s),
    'overdue', (select count(*) from research.activities a join research.projects p on p.id = a.project_id
        where a.project_id = any(vis) and a.status in ('pending', 'changes', 'in_review') and a.deadline < current_date and p.status in ('active', 'changes')),
    'progress', (select coalesce(jsonb_agg(x order by (x ->> 'percent')::int desc, x ->> 'title'), '[]') from (
        select jsonb_build_object('id', p.id, 'title', p.title, 'status', p.status,
          'percent', case when count(a.id) = 0 then 0 else round(100.0 * count(a.id) filter (where a.status = 'completed') / count(a.id)) end,
          'done', count(a.id) filter (where a.status = 'completed'), 'total', count(a.id)) x
        from research.projects p left join research.activities a on a.project_id = p.id and a.status <> 'cancelled'
        where p.id = any(vis) and p.status in ('active', 'changes', 'closing')
        group by p.id order by p.updated_at desc limit 8) t),
    'monthly', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'),
        'proposals', (select count(*) from research.proposals x where date_trunc('month', x.created_at) = m and research.proposal_visible(u, x)),
        'projects', (select count(*) from research.projects p where date_trunc('month', p.created_at) = m and p.id = any(vis))) order by m), '[]')
      from generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') m),
    'upcoming', (select coalesce(jsonb_agg(research.activity_brief(a) order by a.deadline), '[]') from (
        select a.* from research.activities a join research.projects p on p.id = a.project_id
        where a.project_id = any(vis) and a.status in ('pending', 'changes') and p.status in ('active', 'changes')
          and a.deadline between current_date and current_date + 14
          and (u.role = 'coordinator' or a.participant_id = u.id or p.responsible_researcher_id = u.id)
        order by a.deadline limit 6) a));

  return research.ok(jsonb_build_object('stats', stats, 'todo', todo, 'my_activities', mine, 'to_review', review,
    'charts', charts, 'change_requests', requests));
end $$;
