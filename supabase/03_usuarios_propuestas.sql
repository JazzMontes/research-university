-- =====================================================================
-- URPMP · 03 · Usuarios, catálogos, propuestas, evaluaciones y tablero
-- Flujo (diagrama 1):
--  Estudiante registra → investigador revisa (aprueba / pide cambios / rechaza)
--  → Coordinación asigna evaluador (puede archivar/desarchivar)
--  → Evaluador aprueba (se crea el proyecto) / pide modificaciones / rechaza.
--  El investigador puede registrar su propia propuesta (va directo a Coordinación).
-- =====================================================================

create or replace function research.user_json(t research.users)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', t.id, 'name', t.name, 'username', t.username, 'email', t.email,
    'role', t.role, 'status', t.status, 'created_at', t.created_at, 'updated_at', t.updated_at);
$$;

create or replace function research.ep_users(u research.users, act text, d jsonb)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare
  t research.users; new_id integer; v_role text; v_pwd text; v_email text; v_status text; v_name text; v_username text;
begin
  if u.role <> 'coordinator' then perform research.fail(403, 'Solo Coordinación administra usuarios.'); end if;

  if act = 'list' then
    return research.ok(jsonb_build_object('items',
      (select coalesce(jsonb_agg(research.user_json(x) order by x.name, x.id), '[]') from research.users x)));
  end if;

  if act = 'create' then
    v_role := research.req_text(d, 'role', 30);
    if v_role not in ('student','researcher','evaluator','coordinator') then perform research.fail(422, 'Rol inválido.'); end if;
    v_pwd := research.req_text(d, 'password', 72);
    if not research.valid_password(v_pwd) then perform research.fail(422, 'La contraseña necesita de 8 a 72 caracteres con mayúscula, minúscula y número.'); end if;
    v_email := research.opt_text(d, 'email', 254);
    if v_email <> '' and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then perform research.fail(422, 'Correo inválido.'); end if;
    v_name := research.req_text(d, 'name', 150);
    v_username := research.req_text(d, 'username', 80);
    if v_username !~ '^[A-Za-z0-9._-]{3,80}$' then perform research.fail(422, 'El usuario debe tener al menos 3 caracteres: letras, números, punto, guion o guion bajo.'); end if;
    if exists (select 1 from research.users where lower(username) = lower(v_username)) then
      perform research.fail(409, 'Ese nombre de usuario ya existe.');
    end if;
    insert into research.users (name, username, email, password_hash, role)
      values (v_name, v_username, nullif(v_email, ''), research.hash_password(v_pwd), v_role)
      returning * into t;
    return research.ok(jsonb_build_object('user', research.user_json(t)), 201);
  end if;

  select * into t from research.users where id = research.req_id(d, 'user_id') for update;
  if t.id is null then perform research.fail(404, 'Usuario no encontrado.'); end if;

  if act = 'detail' then return research.ok(jsonb_build_object('user', research.user_json(t))); end if;

  if act = 'update' then
    v_email := case when d ? 'email' then research.opt_text(d, 'email', 254) else coalesce(t.email, '') end;
    if v_email <> '' and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then perform research.fail(422, 'Correo inválido.'); end if;
    v_username := research.req_text(d, 'username', 80);
    if v_username !~ '^[A-Za-z0-9._-]{3,80}$' then perform research.fail(422, 'El usuario debe tener al menos 3 caracteres: letras, números, punto, guion o guion bajo.'); end if;
    if exists (select 1 from research.users where lower(username) = lower(v_username) and id <> t.id) then
      perform research.fail(409, 'Ese nombre de usuario ya existe.');
    end if;
    update research.users set name = research.req_text(d, 'name', 150), username = v_username,
      email = nullif(v_email, ''), updated_at = now() where id = t.id;
  elsif act = 'change-status' then
    v_status := research.req_text(d, 'status', 10);
    if v_status not in ('active', 'inactive') then perform research.fail(422, 'Estado inválido.'); end if;
    if t.id = u.id and v_status = 'inactive' then perform research.fail(409, 'No puedes desactivar tu propia cuenta.'); end if;
    update research.users set status = v_status, updated_at = now() where id = t.id;
  elsif act = 'change-role' then
    v_role := research.req_text(d, 'role', 30);
    if v_role not in ('student','researcher','evaluator','coordinator') then perform research.fail(422, 'Rol inválido.'); end if;
    if t.id = u.id and v_role <> u.role then perform research.fail(409, 'No puedes cambiar tu propio rol.'); end if;
    if v_role <> t.role then
      if t.role = 'researcher' and (
           (select count(*) from research.projects where responsible_researcher_id = t.id and status <> 'finalized') +
           (select count(*) from research.proposals where responsible_researcher_id = t.id and status not in ('approved','rejected'))) > 0 then
        perform research.fail(409, 'Primero reasigna los proyectos y propuestas pendientes de este investigador.');
      end if;
      if v_role not in ('student','researcher') and exists (
           select 1 from research.participants x join research.projects p on p.id = x.project_id
           where x.user_id = t.id and x.is_active = 1 and p.status <> 'finalized') then
        perform research.fail(409, 'Primero retira esta cuenta de los proyectos en los que participa.');
      end if;
      if t.role = 'evaluator' and exists (
           select 1 from research.evaluation_assignments a join research.proposals p on p.id = a.proposal_id
           where a.evaluator_id = t.id and a.is_active = 1 and p.status in ('under_evaluation','changes_requested_evaluator')) then
        perform research.fail(409, 'La cuenta tiene evaluaciones pendientes.');
      end if;
    end if;
    update research.users set role = v_role, updated_at = now() where id = t.id;
  elsif act = 'reset-password' then
    v_pwd := research.req_text(d, 'password', 72);
    if not research.valid_password(v_pwd) then perform research.fail(422, 'La contraseña necesita de 8 a 72 caracteres con mayúscula, minúscula y número.'); end if;
    update research.users set password_hash = research.hash_password(v_pwd), updated_at = now() where id = t.id;
  else
    perform research.fail(404, 'Operación no disponible.');
  end if;

  if act in ('change-status', 'change-role', 'reset-password') then
    update research.user_sessions set revoked_at = now() where user_id = t.id and revoked_at is null;
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
  if act = 'roles' then
    if u.role <> 'coordinator' then perform research.fail(403, 'Acceso denegado.'); end if;
    return research.ok(jsonb_build_object('items', jsonb_build_array(
      jsonb_build_object('value', 'student', 'label', 'Estudiante'),
      jsonb_build_object('value', 'researcher', 'label', 'Investigador'),
      jsonb_build_object('value', 'evaluator', 'label', 'Evaluador'),
      jsonb_build_object('value', 'coordinator', 'label', 'Coordinador'))));
  elsif act in ('researchers', 'evaluators') then
    if (act = 'researchers' and u.role not in ('student', 'coordinator', 'researcher'))
       or (act = 'evaluators' and u.role <> 'coordinator') then
      perform research.fail(403, 'Acceso denegado.');
    end if;
    return research.ok(jsonb_build_object('items', (
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]')
      from research.users where status = 'active' and role = case act when 'researchers' then 'researcher' else 'evaluator' end)));
  elsif act = 'participants' then
    p := research.project_access(u, research.req_id(d, 'project_id'));
    if coalesce(d ->> 'all', '') = '1' then
      perform research.project_lead(p, u);
      -- Cuentas que todavía no participan activamente (para "Agregar participante").
      return research.ok(jsonb_build_object('items', (
        select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'role', x.role) order by x.name), '[]')
        from research.users x where x.role in ('student', 'researcher') and x.status = 'active'
          and not exists (select 1 from research.participants t where t.project_id = p.id and t.user_id = x.id and t.is_active = 1))));
    end if;
    return research.ok(jsonb_build_object('items', (
      select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'role', x.role) order by x.name), '[]')
      from research.participants t join research.users x on x.id = t.user_id
      where t.project_id = p.id and t.is_active = 1 and x.status = 'active' and x.role in ('student', 'researcher'))));
  end if;
  perform research.fail(404, 'Catálogo no disponible.');
  return null;
end $$;

-- ------------------------------------------------------------------
create or replace function research.proposal_json(p research.proposals)
returns jsonb language sql stable
set search_path = research, extensions, pg_temp as $$
  select to_jsonb(p) || jsonb_build_object(
    'researcher_name', (select name from research.users where id = p.responsible_researcher_id),
    'author_name', (select name from research.users where id = p.author_id),
    'project_id', (select id from research.projects where proposal_id = p.id),
    'evaluator_name', (select x.name from research.evaluation_assignments a join research.users x on x.id = a.evaluator_id
                       where a.proposal_id = p.id and a.is_active = 1 order by a.id desc limit 1));
$$;

create or replace function research.proposal_history_add(pid integer, actor integer, act text, before_s text, after_s text, details text default null)
returns void language sql
set search_path = research, extensions, pg_temp as $$
  insert into research.proposal_history (proposal_id, actor_id, action, previous_status, new_status, details)
  values (pid, actor, act, before_s, after_s, details);
$$;

create or replace function research.ep_proposals(u research.users, module text, act text, d jsonb)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare
  p research.proposals; pid integer; researcher integer; v_status text; before_s text; after_s text;
  obs text; decision text; evaluator integer; new_project integer; v_archive boolean; was_archived boolean;
  v_limit integer; v_page integer; v_total integer; v_search text; v_filter_status text; v_filter_archived text;
  log_action text; changed integer := 0;
begin
  -- Lista de asignaciones de evaluación (vista "Evaluaciones").
  if act = 'assignments' and not research.has(d, 'proposal_id') then
    return research.ok(jsonb_build_object('items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', a.id, 'proposal_id', a.proposal_id, 'assigned_at', a.assigned_at, 'is_active', a.is_active,
        'title', x.title, 'status', x.status, 'is_archived', x.is_archived,
        'evaluator_name', ev.name, 'author_name', au.name,
        'decision', (select e.decision from research.evaluations e where e.proposal_id = a.proposal_id
                     and e.evaluator_id = a.evaluator_id order by e.id desc limit 1)) order by a.id desc), '[]')
      from research.evaluation_assignments a
      join research.proposals x on x.id = a.proposal_id
      join research.users ev on ev.id = a.evaluator_id
      join research.users au on au.id = x.author_id
      where research.proposal_visible(u, x) and (u.role <> 'evaluator' or (a.evaluator_id = u.id and a.is_active = 1)))));
  end if;

  if act = 'list' then
    v_filter_status := coalesce(d ->> 'status', '');
    v_filter_archived := coalesce(d ->> 'archived', '');
    if v_filter_archived not in ('', '0', '1') then perform research.fail(422, 'archived debe ser 0 o 1.'); end if;
    v_search := coalesce(btrim(d ->> 'search'), '');
    v_limit := greatest(1, least(100, coalesce(nullif(d ->> 'limit', '')::integer, 20)));
    v_page := greatest(1, least(100000, coalesce(nullif(d ->> 'page', '')::integer, 1)));
    select count(*) into v_total from research.proposals x
      where research.proposal_visible(u, x)
        and (v_filter_status = '' or x.status = v_filter_status)
        and (v_filter_archived = '' or x.is_archived = v_filter_archived::smallint)
        and (v_search = '' or extensions.unaccent(lower(x.title)) like '%' || extensions.unaccent(lower(v_search)) || '%');
    return research.ok(jsonb_build_object('page', v_page, 'limit', v_limit, 'total', v_total, 'items', (
      select coalesce(jsonb_agg(research.proposal_json(y) order by y.id desc), '[]') from (
        select x.* from research.proposals x
        where research.proposal_visible(u, x)
          and (v_filter_status = '' or x.status = v_filter_status)
          and (v_filter_archived = '' or x.is_archived = v_filter_archived::smallint)
          and (v_search = '' or extensions.unaccent(lower(x.title)) like '%' || extensions.unaccent(lower(v_search)) || '%')
        order by x.id desc limit v_limit offset (v_page - 1) * v_limit) y)));
  end if;

  if act = 'create' then
    if u.role not in ('student', 'researcher') then perform research.fail(403, 'Solo estudiantes e investigadores registran propuestas.'); end if;
    researcher := case when u.role = 'student' then research.req_id(d, 'responsible_researcher_id') else u.id end;
    perform research.active_role(researcher, 'researcher');
    v_status := case when u.role = 'student' then 'pending_researcher_review' else 'pending_coordinator' end;
    insert into research.proposals (title, description, objectives, author_id, responsible_researcher_id, status)
      values (research.req_text(d, 'title', 250), research.req_text(d, 'description', 65535),
              research.req_text(d, 'objectives', 65535), u.id, researcher, v_status)
      returning id into pid;
    perform research.proposal_history_add(pid, u.id, 'created', null, v_status,
      case when u.role = 'student' then 'Enviada al investigador responsable.' else 'Propuesta propia del investigador: pasa directo a Coordinación.' end);
    return research.ok(jsonb_build_object('proposal_id', pid, 'status', v_status), 201);
  end if;

  pid := research.req_id(d, 'proposal_id');
  select * into p from research.proposals where id = pid for update;
  if p.id is null or not research.proposal_visible(u, p) then perform research.fail(404, 'Propuesta no disponible.'); end if;
  before_s := p.status; after_s := before_s; obs := null; log_action := act;
  was_archived := p.is_archived = 1;

  if act = 'detail' then
    return research.ok(jsonb_build_object('proposal', research.proposal_json(p)));
  elsif act = 'history' then
    return research.ok(jsonb_build_object('items', (
      select coalesce(jsonb_agg(to_jsonb(h) || jsonb_build_object('actor_name', x.name, 'actor_role', x.role) order by h.id desc), '[]')
      from research.proposal_history h left join research.users x on x.id = h.actor_id where h.proposal_id = pid)));
  elsif act = 'assignments' then
    return research.ok(jsonb_build_object('items', (
      select coalesce(jsonb_agg(to_jsonb(a) || jsonb_build_object('evaluator_name', x.name) order by a.id desc), '[]')
      from research.evaluation_assignments a join research.users x on x.id = a.evaluator_id
      where a.proposal_id = pid and (u.role <> 'evaluator' or (a.evaluator_id = u.id and a.is_active = 1)))));
  end if;

  if was_archived and act <> 'archive' then
    perform research.fail(409, 'La propuesta está archivada. Coordinación debe desarchivarla para continuar.');
  end if;

  if act = 'submit' then
    if module <> 'evaluations' or u.role <> 'evaluator' then perform research.fail(403, 'Solo el evaluador asignado puede evaluar.'); end if;
    if before_s <> 'under_evaluation' then perform research.fail(409, 'La propuesta no está en evaluación.'); end if;
    decision := research.req_text(d, 'decision', 30);
    if decision not in ('approved', 'changes_requested', 'rejected') then perform research.fail(422, 'Decisión inválida.'); end if;
    obs := research.req_text(d, 'observations', 65535);
    insert into research.evaluations (proposal_id, evaluator_id, decision, observations) values (pid, u.id, decision, obs);
    after_s := case decision when 'approved' then 'approved' when 'changes_requested' then 'changes_requested_evaluator' else 'rejected' end;
    if decision = 'approved' then
      -- La propuesta aprobada se convierte directamente en proyecto (diagramas 1 y 3).
      insert into research.projects (proposal_id, title, description, objectives, responsible_researcher_id)
        values (pid, p.title, p.description, p.objectives, p.responsible_researcher_id) returning id into new_project;
      perform research.event_project(new_project, u.id, 'project', new_project, 'created_from_proposal', jsonb_build_object('proposal_id', pid));
      insert into research.participants (project_id, user_id, project_role)
        select new_project, x, case when x = p.responsible_researcher_id then 'Investigador responsable' else 'Autor de la propuesta' end
        from (select distinct unnest(array[p.responsible_researcher_id, p.author_id]) as x) s
        on conflict (project_id, user_id) do nothing;
    end if;
    log_action := 'evaluation_' || decision;
  elsif act in ('update', 'resubmit') then
    if p.author_id <> u.id then perform research.fail(403, 'Solo el autor puede corregir la propuesta.'); end if;
    if before_s not in ('changes_requested_researcher', 'changes_requested_evaluator') then
      perform research.fail(409, 'La propuesta no tiene cambios solicitados.');
    end if;
    if act = 'update' then
      if d ? 'title' then update research.proposals set title = research.req_text(d, 'title', 250) where id = pid; changed := changed + 1; end if;
      if d ? 'description' then update research.proposals set description = research.req_text(d, 'description', 65535) where id = pid; changed := changed + 1; end if;
      if d ? 'objectives' then update research.proposals set objectives = research.req_text(d, 'objectives', 65535) where id = pid; changed := changed + 1; end if;
      if changed = 0 then perform research.fail(422, 'Envía al menos un campo para corregir.'); end if;
      update research.proposals set correction_pending_resubmit = 1, updated_at = now() where id = pid;
    else
      if p.correction_pending_resubmit <> 1 then perform research.fail(409, 'Guarda primero las correcciones y después reenvía.'); end if;
      after_s := case when before_s = 'changes_requested_researcher' then 'pending_researcher_review' else 'under_evaluation' end;
      update research.proposals set correction_pending_resubmit = 0 where id = pid;
      obs := case when after_s = 'under_evaluation' then 'Reenviada al evaluador asignado.' else 'Reenviada al investigador responsable.' end;
    end if;
  elsif act = 'review' then
    if u.role <> 'researcher' or p.responsible_researcher_id <> u.id or p.author_id = u.id then
      perform research.fail(403, 'Solo el investigador responsable puede revisar esta propuesta.');
    end if;
    if before_s <> 'pending_researcher_review' then perform research.fail(409, 'La revisión del investigador no está pendiente.'); end if;
    decision := research.req_text(d, 'decision', 30);
    if decision not in ('approved', 'changes_requested', 'rejected') then perform research.fail(422, 'Decisión inválida.'); end if;
    obs := research.req_text(d, 'observations', 65535);
    after_s := case decision when 'approved' then 'pending_coordinator' when 'changes_requested' then 'changes_requested_researcher' else 'rejected' end;
    insert into research.proposal_reviews (proposal_id, researcher_id, decision, observations) values (pid, u.id, decision, obs);
    log_action := 'review_' || decision;
  elsif act = 'archive' then
    if u.role <> 'coordinator' then perform research.fail(403, 'Solo Coordinación archiva propuestas.'); end if;
    v_archive := research.req_bool(d, 'archived');
    if v_archive = was_archived then
      return research.ok(jsonb_build_object('proposal_id', pid, 'status', before_s));
    end if;
    if v_archive then
      update research.proposals set is_archived = 1, status_before_archive = before_s where id = pid;
      log_action := 'archived';
      obs := research.opt_text(d, 'observations', 2000);
    else
      after_s := coalesce(p.status_before_archive, before_s);
      update research.proposals set is_archived = 0, status_before_archive = null where id = pid;
      log_action := 'unarchived';
    end if;
  elsif act = 'assign' then
    if u.role <> 'coordinator' then perform research.fail(403, 'Solo Coordinación asigna evaluadores.'); end if;
    if before_s <> 'pending_coordinator' then perform research.fail(409, 'La propuesta no está pendiente de Coordinación.'); end if;
    evaluator := research.req_id(d, 'evaluator_id');
    perform research.active_role(evaluator, 'evaluator');
    if evaluator = p.author_id then perform research.fail(422, 'El evaluador no puede ser el autor de la propuesta.'); end if;
    update research.evaluation_assignments set is_active = 0 where proposal_id = pid and is_active = 1;
    insert into research.evaluation_assignments (proposal_id, evaluator_id, assigned_by) values (pid, evaluator, u.id);
    after_s := 'under_evaluation';
    obs := 'Evaluador: ' || (select name from research.users where id = evaluator);
  else
    perform research.fail(404, 'Operación no disponible.');
  end if;

  if before_s <> after_s then update research.proposals set status = after_s, updated_at = now() where id = pid; end if;
  perform research.proposal_history_add(pid, u.id, log_action, before_s, after_s, obs);
  return research.ok(jsonb_build_object('proposal_id', pid, 'status', after_s, 'project_id', new_project));
end $$;

-- ------------------------------------------------------------------
-- Tablero: contadores y "pendientes para ti" según el rol.
-- ------------------------------------------------------------------
create or replace function research.ep_dashboard(u research.users)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare projects jsonb; todo jsonb := '[]'::jsonb; n integer;
begin
  projects := research.project_list(u);

  if u.role = 'student' or u.role = 'researcher' then
    select count(*) into n from research.proposals where author_id = u.id and is_archived = 0
      and status in ('changes_requested_researcher', 'changes_requested_evaluator');
    if n > 0 then todo := todo || jsonb_build_object('label', 'Propuestas con cambios solicitados', 'count', n, 'link', 'proposals'); end if;
    select count(*) into n from research.activities a join research.projects p on p.id = a.project_id
      where a.participant_id = u.id and a.status in ('pending', 'in_progress') and p.status = 'active';
    if n > 0 then todo := todo || jsonb_build_object('label', 'Mis actividades por realizar', 'count', n, 'link', 'activities'); end if;
  end if;
  if u.role = 'researcher' then
    select count(*) into n from research.proposals where responsible_researcher_id = u.id and author_id <> u.id
      and status = 'pending_researcher_review' and is_archived = 0;
    if n > 0 then todo := todo || jsonb_build_object('label', 'Propuestas de estudiantes por revisar', 'count', n, 'link', 'proposals'); end if;
    select count(*) into n from research.activities a join research.projects p on p.id = a.project_id
      where p.responsible_researcher_id = u.id and a.status = 'in_review' and p.status = 'active';
    if n > 0 then todo := todo || jsonb_build_object('label', 'Actividades entregadas por revisar', 'count', n, 'link', 'activities'); end if;
  end if;
  if u.role = 'coordinator' then
    select count(*) into n from research.proposals where status = 'pending_coordinator' and is_archived = 0;
    if n > 0 then todo := todo || jsonb_build_object('label', 'Propuestas por asignar evaluador', 'count', n, 'link', 'proposals'); end if;
    select count(*) into n from research.closures where status = 'pending';
    if n > 0 then todo := todo || jsonb_build_object('label', 'Solicitudes de cierre por revisar', 'count', n, 'link', 'closures'); end if;
  end if;
  if u.role = 'evaluator' then
    select count(*) into n from research.evaluation_assignments a join research.proposals p on p.id = a.proposal_id
      where a.evaluator_id = u.id and a.is_active = 1 and p.status = 'under_evaluation' and p.is_archived = 0;
    if n > 0 then todo := todo || jsonb_build_object('label', 'Propuestas por evaluar', 'count', n, 'link', 'evaluations'); end if;
  end if;

  return research.ok(jsonb_build_object(
    'counts', jsonb_build_array(
      (select count(*) from research.proposals x where research.proposal_visible(u, x)),
      (select count(*) from jsonb_array_elements(projects) e where e ->> 'status' = 'active'),
      case when u.role = 'student'
        then (select count(*) from research.activities a where a.participant_id = u.id and a.status <> 'completed')
        else (select coalesce(sum((e ->> 'total_activities')::int - (e ->> 'completed_activities')::int), 0) from jsonb_array_elements(projects) e) end,
      jsonb_array_length(projects)),
    'projects', projects,
    'todo', todo));
end $$;
