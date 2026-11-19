-- =====================================================================
-- URPMP · 04 · Proyectos (versión 3)
-- Estados del proyecto (color en la app):
--   active    En proceso        (amarillo)  se trabaja normalmente
--   changes   En cambios        (azul)      Coordinación devolvió el cierre con pendientes; se sigue trabajando
--   closing   Cierre solicitado (amarillo)  solo lectura hasta que Coordinación responda
--   finalized Completado        (verde)     solo lectura; Coordinación puede reabrir
--   cancelled Cancelado         (rojo)      solo lectura; Coordinación puede reabrir
-- Todo se administra desde el detalle del proyecto (equipo, actividades,
-- hitos, documentos, cierre y reporte).
-- =====================================================================

create or replace function research.history_items(pid integer, v_entity text, eid integer)
returns jsonb language sql stable
set search_path = research, extensions, pg_temp as $$
  select coalesce(jsonb_agg(to_jsonb(h) || jsonb_build_object('actor_name', x.name) order by h.id desc), '[]')
  from (select * from research.project_history
        where project_id = pid and (v_entity is null or (entity = v_entity and entity_id = eid))
        order by id desc limit 200) h
  join research.users x on x.id = h.actor_id;
$$;

-- Cambia al investigador responsable; el anterior sigue en el equipo como investigador.
create or replace function research.project_set_researcher(p research.projects, uid integer, actor integer, why text default '')
returns void language plpgsql
set search_path = research, extensions, pg_temp as $$
begin
  if p.status not in ('active', 'changes', 'closing') then perform research.fail(409, 'Reabre el proyecto antes de cambiar al responsable.'); end if;
  if uid = p.responsible_researcher_id then perform research.fail(422, 'Esa persona ya es la responsable.'); end if;
  perform research.active_role(uid, 'researcher');
  update research.projects set responsible_researcher_id = uid, updated_at = now() where id = p.id;
  update research.participants set project_role = 'Investigador'
    where project_id = p.id and user_id = p.responsible_researcher_id and project_role = 'Investigador responsable';
  insert into research.participants (project_id, user_id, project_role) values (p.id, uid, 'Investigador responsable')
    on conflict (project_id, user_id) do update set is_active = 1, removed_at = null, project_role = 'Investigador responsable';
  perform research.event_project(p.id, actor, 'project', p.id, 'change-researcher', jsonb_build_object(
    'before', (select name from research.users where id = p.responsible_researcher_id),
    'after', (select name from research.users where id = uid), 'reason', nullif(why, '')));
end $$;

-- ------------------------------------------------------------------
create or replace function research.ep_projects(u research.users, act text, d jsonb, is_post boolean)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare p research.projects; pid integer; uid integer; v_start date; v_end date; v_reason text;
begin
  if act = 'list' then return research.ok(jsonb_build_object('items', research.project_list(u))); end if;
  pid := research.req_id(d, 'project_id');
  p := research.project_access(u, pid, is_post);

  if act = 'detail' then
    return research.ok(jsonb_build_object('item', research.project_json(p) || jsonb_build_object(
      'participants', (select coalesce(jsonb_agg(jsonb_build_object('user_id', t.user_id, 'name', x.name, 'role', x.role,
                         'project_role', t.project_role, 'is_active', t.is_active, 'joined_at', t.joined_at, 'removed_at', t.removed_at,
                         'pending_activities', (select count(*) from research.activities a where a.project_id = pid
                                                and a.participant_id = t.user_id and a.status in ('pending', 'in_review', 'changes')))
                         order by t.is_active desc, x.name), '[]')
                       from research.participants t join research.users x on x.id = t.user_id where t.project_id = pid),
      'change_request', (select to_jsonb(c) || jsonb_build_object('requester_name', x.name)
                         from research.researcher_change_requests c join research.users x on x.id = c.requested_by
                         where c.project_id = pid and c.status = 'pending' order by c.id desc limit 1),
      'last_closure', (select to_jsonb(c) || jsonb_build_object('requester_name', (select name from research.users where id = c.requested_by),
                                                                'reviewer_name', (select name from research.users where id = c.reviewed_by))
                       from research.closures c where c.project_id = pid order by c.id desc limit 1))));
  elsif act = 'history' then
    return research.ok(jsonb_build_object('items', research.history_items(pid, null, null)));
  elsif act = 'update' then
    -- El investigador responsable configura datos y fechas.
    perform research.project_lead(p, u);
    perform research.project_active(p);
    v_start := research.opt_date(d, 'start_date');
    v_end := research.opt_date(d, 'end_date');
    if v_start is not null and v_end is not null and v_end < v_start then
      perform research.fail(422, 'La fecha de término debe ser posterior a la fecha de inicio.');
    end if;
    update research.projects set
      title = research.req_text(d, 'title', 250),
      description = research.req_text(d, 'description', 65535),
      objectives = research.req_text(d, 'objectives', 65535),
      start_date = v_start, end_date = v_end, updated_at = now()
    where id = pid;
    perform research.event_project(pid, u.id, 'project', pid, 'configured',
      jsonb_build_object('title', d -> 'title', 'start_date', v_start, 'end_date', v_end));
    return research.ok(jsonb_build_object('project_id', pid));
  end if;

  if u.role <> 'coordinator' then perform research.fail(403, 'Solo Coordinación puede hacer este cambio.'); end if;

  if act = 'change-researcher' then
    perform research.project_set_researcher(p, research.req_id(d, 'researcher_id'), u.id, research.opt_text(d, 'reason', 2000));
  elsif act = 'cancel' then
    if p.status in ('finalized', 'cancelled') then perform research.fail(409, 'El proyecto ya está ' || case p.status when 'cancelled' then 'cancelado.' else 'completado.' end); end if;
    v_reason := research.req_text(d, 'reason', 2000);
    -- Si había una solicitud de cierre pendiente, se responde automáticamente.
    update research.closures set status = 'changes_requested', review_observations = 'Proyecto cancelado: ' || v_reason,
      reviewed_by = u.id, reviewed_at = now() where project_id = pid and status = 'pending';
    update research.projects set status = 'cancelled', status_note = v_reason, updated_at = now() where id = pid;
    perform research.event_project(pid, u.id, 'project', pid, 'cancelled', jsonb_build_object('reason', v_reason));
  elsif act = 'reopen' then
    -- Corrige un cierre o una cancelación hechos por error.
    if p.status not in ('finalized', 'cancelled') then perform research.fail(409, 'El proyecto ya está abierto.'); end if;
    if not exists (select 1 from research.users where id = p.responsible_researcher_id and role in ('researcher', 'coordinator') and status = 'active') then
      perform research.fail(409, 'El investigador responsable ya no está activo. Reactiva su cuenta o, después de reabrir, cambia al responsable.');
    end if;
    v_reason := research.req_text(d, 'reason', 2000);
    update research.projects set status = 'active', status_note = null, updated_at = now() where id = pid;
    perform research.event_project(pid, u.id, 'project', pid, 'reopened', jsonb_build_object('before', p.status, 'reason', v_reason));
  else
    perform research.fail(404, 'Operación no disponible.');
  end if;
  return research.ok(jsonb_build_object('project_id', pid));
end $$;

-- ------------------------------------------------------------------
-- Equipo: agregar, cambiar rol en el proyecto y retirar.
-- Retirar no borra nada: la persona queda en el historial y se puede reincorporar.
-- ------------------------------------------------------------------
create or replace function research.ep_participants(u research.users, act text, d jsonb, is_post boolean)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare
  p research.projects; pid integer; uid integer; target integer; a record; v_role text; moved integer := 0;
begin
  pid := research.req_id(d, 'project_id');
  p := research.project_access(u, pid, is_post);
  perform research.project_active(p);
  perform research.project_lead(p, u);
  uid := research.req_id(d, 'user_id');

  if act = 'add' then
    v_role := research.opt_text(d, 'project_role', 80);
    perform 1 from research.users where id = uid and role in ('student', 'researcher', 'coordinator') and status = 'active' for update;
    if not found then perform research.fail(422, 'Solo se pueden agregar cuentas activas.'); end if;
    if exists (select 1 from research.participants where project_id = pid and user_id = uid and is_active = 1) then
      perform research.fail(409, 'Esa persona ya está en el equipo.');
    end if;
    insert into research.participants (project_id, user_id, project_role) values (pid, uid, nullif(v_role, ''))
      on conflict (project_id, user_id) do update set is_active = 1, removed_at = null,
        project_role = coalesce(nullif(excluded.project_role, ''), research.participants.project_role);
  elsif act = 'update' then
    perform research.participant_valid(pid, uid);
    if uid = p.responsible_researcher_id then perform research.fail(409, 'El rol del investigador responsable no se cambia aquí.'); end if;
    v_role := research.opt_text(d, 'project_role', 80);
    update research.participants set project_role = nullif(v_role, '') where project_id = pid and user_id = uid;
  elsif act = 'remove' then
    if uid = p.responsible_researcher_id then
      perform research.fail(409, 'No puedes retirar al investigador responsable. Coordinación puede cambiar al responsable primero.');
    end if;
    if not exists (select 1 from research.participants where project_id = pid and user_id = uid and is_active = 1) then
      perform research.fail(409, 'Esa persona ya no está en el equipo.');
    end if;
    -- Sus actividades sin terminar pasan a otra persona (por defecto, al investigador responsable).
    target := case when research.has(d, 'reassign_to') then research.req_id(d, 'reassign_to') else p.responsible_researcher_id end;
    if target = uid then perform research.fail(422, 'Elige a otra persona para recibir sus actividades.'); end if;
    for a in select id from research.activities where project_id = pid and participant_id = uid
             and status in ('pending', 'in_review', 'changes') for update loop
      if moved = 0 then perform research.participant_valid(pid, target); end if;
      update research.activities set participant_id = target, updated_at = now() where id = a.id;
      perform research.event_project(pid, u.id, 'activity', a.id, 'reassign', jsonb_build_object(
        'before', (select name from research.users where id = uid), 'after', (select name from research.users where id = target)));
      moved := moved + 1;
    end loop;
    update research.participants set is_active = 0, removed_at = now() where project_id = pid and user_id = uid;
  else
    perform research.fail(404, 'Operación no disponible.');
  end if;
  perform research.event_project(pid, u.id, 'participant', uid, act, jsonb_build_object(
    'user', (select name from research.users where id = uid), 'project_role', d -> 'project_role', 'activities_moved', moved));
  return research.ok(jsonb_build_object('id', uid, 'project_id', pid, 'activities_moved', moved));
end $$;

-- ------------------------------------------------------------------
-- Actividades: Pendiente → (Entregar) En revisión → Aceptar = Completada
--                                                 → Pedir cambios = Cambios solicitados → Entregar…
-- El responsable del proyecto puede reabrir una actividad aceptada por error (pedir cambios)
-- o cancelar una actividad creada por error.
-- ------------------------------------------------------------------
create or replace function research.activity_json(a research.activities)
returns jsonb language sql stable
set search_path = research, extensions, pg_temp as $$
  select to_jsonb(a) || jsonb_build_object(
    'participant_name', (select name from research.users where id = a.participant_id),
    'project_title', (select title from research.projects where id = a.project_id),
    'deadline_status', research.deadline_status(a.status, a.deadline),
    'evidence_count', (select count(*) from research.documents dd where dd.activity_id = a.id and dd.kind = 'evidence' and dd.deleted_at is null),
    'milestones', (select coalesce(jsonb_agg(m.description), '[]') from research.milestone_activities ma
                   join research.milestones m on m.id = ma.milestone_id where ma.activity_id = a.id));
$$;

create or replace function research.ep_activities(u research.users, act text, d jsonb, is_post boolean)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare
  a research.activities; p research.projects; pid integer; eid integer; uid integer; v_deadline date;
  decision text; next_s text; obs text; before jsonb;
begin
  if research.has(d, 'activity_id') then
    if is_post then select * into a from research.activities where id = research.req_id(d, 'activity_id') for update;
    else select * into a from research.activities where id = research.req_id(d, 'activity_id'); end if;
    if a.id is null then perform research.fail(404, 'Actividad no disponible.'); end if;
    pid := a.project_id;
  else
    pid := research.req_id(d, 'project_id');
  end if;
  p := research.project_access(u, pid, is_post);

  if act = 'list' then
    return research.ok(jsonb_build_object('items', (
      select coalesce(jsonb_agg(research.activity_json(x) order by (x.status = 'cancelled'), x.deadline, x.id), '[]')
      from research.activities x where x.project_id = pid)));
  elsif act = 'detail' then
    if a.id is null then perform research.fail(404, 'Actividad no disponible.'); end if;
    return research.ok(jsonb_build_object('item', research.activity_json(a) || jsonb_build_object(
      'project_status', p.status, 'lead_id', p.responsible_researcher_id,
      'history', research.history_items(pid, 'activity', a.id))));
  end if;

  perform research.project_active(p);
  before := case when a.id is null then null else to_jsonb(a) end;
  eid := a.id;

  if act in ('create', 'update') then
    perform research.project_lead(p, u);
    uid := research.req_id(d, 'participant_id');
    perform research.participant_valid(pid, uid);
    v_deadline := research.req_date(d, 'deadline');
    if act = 'create' then
      if v_deadline < current_date then perform research.fail(422, 'La fecha límite ya pasó. Revisa el año y el mes.'); end if;
      insert into research.activities (project_id, description, participant_id, deadline)
        values (pid, research.req_text(d, 'description', 65535), uid, v_deadline) returning id into eid;
    else
      if a.id is null then perform research.fail(404, 'Actividad no disponible.'); end if;
      if a.status in ('completed', 'cancelled') then perform research.fail(409, 'La actividad está cerrada; ya no se edita.'); end if;
      if v_deadline < current_date and v_deadline <> a.deadline then perform research.fail(422, 'La nueva fecha límite ya pasó.'); end if;
      update research.activities set description = research.req_text(d, 'description', 65535), participant_id = uid,
        deadline = v_deadline, updated_at = now() where id = eid;
    end if;
  elsif act = 'submit' then
    if a.id is null then perform research.fail(404, 'Actividad no disponible.'); end if;
    if a.participant_id <> u.id then perform research.fail(403, 'Solo la persona asignada puede entregar esta actividad.'); end if;
    if a.status not in ('pending', 'changes') then
      perform research.fail(409, case a.status when 'in_review' then 'Ya la entregaste; espera la revisión.' else 'La actividad está cerrada.' end);
    end if;
    update research.activities set status = 'in_review', observations = nullif(research.opt_text(d, 'comment', 65535), ''), updated_at = now() where id = eid;
  elsif act = 'review' then
    if a.id is null then perform research.fail(404, 'Actividad no disponible.'); end if;
    perform research.project_lead(p, u);
    decision := research.req_text(d, 'decision', 30);
    if decision not in ('approved', 'changes_requested') then perform research.fail(422, 'Decisión inválida.'); end if;
    if not (a.status = 'in_review' or (a.status = 'completed' and decision = 'changes_requested')) then
      perform research.fail(409, 'La actividad no está esperando revisión.');
    end if;
    next_s := case when decision = 'approved' then 'completed' else 'changes' end;
    obs := case when decision = 'changes_requested' then research.req_text(d, 'observations', 65535) else research.opt_text(d, 'observations', 65535) end;
    update research.activities set status = next_s, observations = nullif(obs, ''), updated_at = now() where id = eid;
  elsif act = 'cancel' then
    if a.id is null then perform research.fail(404, 'Actividad no disponible.'); end if;
    perform research.project_lead(p, u);
    if a.status in ('completed', 'cancelled') then perform research.fail(409, 'La actividad ya está cerrada.'); end if;
    obs := research.req_text(d, 'reason', 2000);
    update research.activities set status = 'cancelled', observations = obs, updated_at = now() where id = eid;
  else
    perform research.fail(404, 'Operación no disponible.');
  end if;
  perform research.event_project(pid, u.id, 'activity', eid, act,
    jsonb_build_object('before', before, 'input', d - 'file_base64' - 'text_content'));
  return research.ok(jsonb_build_object('id', eid, 'project_id', pid));
end $$;

-- ------------------------------------------------------------------
-- Hitos: se alcanzan solos cuando todas sus actividades están completadas.
-- ------------------------------------------------------------------
create or replace function research.milestone_json(m research.milestones)
returns jsonb language sql stable
set search_path = research, extensions, pg_temp as $$
  select to_jsonb(m) || jsonb_build_object(
    'status', research.milestone_status(m.id),
    'activity_ids', (select coalesce(jsonb_agg(ma.activity_id order by ma.activity_id), '[]') from research.milestone_activities ma where ma.milestone_id = m.id),
    'activity_count', (select count(*) from research.milestone_activities ma join research.activities a on a.id = ma.activity_id
                       where ma.milestone_id = m.id and a.status <> 'cancelled'),
    'completed_count', (select count(*) from research.milestone_activities ma join research.activities a on a.id = ma.activity_id
                        where ma.milestone_id = m.id and a.status = 'completed'),
    'activities', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'description', a.description, 'status', a.status,
                     'participant_name', x.name, 'deadline', a.deadline) order by a.deadline), '[]')
                   from research.milestone_activities ma join research.activities a on a.id = ma.activity_id
                   join research.users x on x.id = a.participant_id where ma.milestone_id = m.id));
$$;

create or replace function research.ep_milestones(u research.users, act text, d jsonb, is_post boolean)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare
  m research.milestones; p research.projects; pid integer; eid integer; ids integer[]; x jsonb;
begin
  if research.has(d, 'milestone_id') then
    select * into m from research.milestones where id = research.req_id(d, 'milestone_id');
    if m.id is null then perform research.fail(404, 'Hito no disponible.'); end if;
    pid := m.project_id;
  else
    pid := research.req_id(d, 'project_id');
  end if;
  p := research.project_access(u, pid, is_post);

  if act = 'list' then
    return research.ok(jsonb_build_object('items', (
      select coalesce(jsonb_agg(research.milestone_json(y) order by y.target_date, y.id), '[]') from research.milestones y where y.project_id = pid)));
  end if;

  perform research.project_active(p);
  perform research.project_lead(p, u);
  eid := m.id;

  if act in ('create', 'update') then
    -- Las actividades son opcionales: se pueden vincular después.
    x := coalesce(d -> 'activity_ids', '[]'::jsonb);
    if jsonb_typeof(x) in ('string', 'number') then x := jsonb_build_array(x); end if;
    if jsonb_typeof(x) <> 'array' then perform research.fail(422, 'Revisa las actividades del hito.'); end if;
    select coalesce(array_agg(distinct research.req_id(jsonb_build_object('id', e), 'id')), '{}') into ids from jsonb_array_elements(x) e;
    if (select count(*) from research.activities where id = any(ids) and project_id = pid) <> cardinality(ids) then
      perform research.fail(422, 'Una de las actividades no pertenece al proyecto.');
    end if;
    if act = 'create' then
      insert into research.milestones (project_id, description, target_date)
        values (pid, research.req_text(d, 'description', 65535), research.req_date(d, 'target_date')) returning id into eid;
    else
      if m.id is null then perform research.fail(404, 'Hito no disponible.'); end if;
      update research.milestones set description = research.req_text(d, 'description', 65535),
        target_date = research.req_date(d, 'target_date') where id = eid;
      delete from research.milestone_activities where milestone_id = eid;
    end if;
    insert into research.milestone_activities (milestone_id, activity_id) select eid, unnest(ids);
  elsif act = 'delete' then
    -- Borrar un hito no toca sus actividades.
    if m.id is null then perform research.fail(404, 'Hito no disponible.'); end if;
    delete from research.milestone_activities where milestone_id = eid;
    delete from research.milestones where id = eid;
  else
    perform research.fail(404, 'Operación no disponible.');
  end if;
  perform research.event_project(pid, u.id, 'milestone', eid, act,
    jsonb_build_object('description', coalesce(d ->> 'description', m.description)));
  return research.ok(jsonb_build_object('id', eid, 'project_id', pid));
end $$;

-- ------------------------------------------------------------------
-- Cierre: el responsable solicita → Coordinación aprueba (Completado)
-- o pide cambios (En cambios, se sigue trabajando y se vuelve a solicitar).
-- ------------------------------------------------------------------
create or replace function research.ep_closures(u research.users, act text, d jsonb, is_post boolean)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare c research.closures; p research.projects; pid integer; eid integer; decision text; obs text; n integer;
begin
  pid := research.req_id(d, 'project_id');
  p := research.project_access(u, pid, is_post);

  if act = 'request' then
    perform research.project_lead(p, u);
    perform research.project_active(p);
    select count(*) into n from research.activities where project_id = pid and status in ('pending', 'in_review', 'changes');
    if n > 0 then
      perform research.fail(409, 'Hay ' || n || ' actividad(es) sin terminar. Revísalas, complétalas o cancélalas antes de solicitar el cierre.');
    end if;
    insert into research.closures (project_id, requested_by, observations)
      values (pid, u.id, nullif(research.opt_text(d, 'observations', 65535), '')) returning id into eid;
    update research.projects set status = 'closing', status_note = null, updated_at = now() where id = pid;
  elsif act = 'review' then
    if u.role <> 'coordinator' then perform research.fail(403, 'Solo Coordinación revisa el cierre.'); end if;
    select * into c from research.closures where project_id = pid and status = 'pending' order by id desc limit 1 for update;
    if c.id is null or p.status <> 'closing' then perform research.fail(409, 'No hay una solicitud de cierre pendiente.'); end if;
    decision := research.req_text(d, 'decision', 30);
    if decision not in ('approved', 'changes_requested') then perform research.fail(422, 'Decisión inválida.'); end if;
    obs := case when decision = 'changes_requested' then research.req_text(d, 'observations', 65535) else research.opt_text(d, 'observations', 65535) end;
    eid := c.id;
    update research.closures set status = decision, review_observations = nullif(obs, ''), reviewed_by = u.id, reviewed_at = now() where id = eid;
    update research.projects set status = case when decision = 'approved' then 'finalized' else 'changes' end,
      status_note = case when decision = 'approved' then null else obs end, updated_at = now() where id = pid;
  else
    perform research.fail(404, 'Operación no disponible.');
  end if;
  perform research.event_project(pid, u.id, 'closure', eid, act, jsonb_build_object('input', d));
  return research.ok(jsonb_build_object('id', eid, 'project_id', pid));
end $$;

-- ------------------------------------------------------------------
create or replace function research.project_report(u research.users, pid integer)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare p research.projects; total integer; done integer;
begin
  p := research.project_access(u, pid);
  if u.role <> 'coordinator' then perform research.project_lead(p, u); end if;
  select count(*) filter (where status <> 'cancelled'), count(*) filter (where status = 'completed') into total, done
    from research.activities where project_id = pid;
  return research.project_json(p) || jsonb_build_object(
    'progress', case when total = 0 then 0 else round(done * 100.0 / total, 0) end,
    'participants', (select coalesce(jsonb_agg(jsonb_build_object('user_id', t.user_id, 'name', x.name, 'role', x.role,
                       'project_role', t.project_role, 'is_active', t.is_active, 'joined_at', t.joined_at, 'removed_at', t.removed_at)
                       order by t.is_active desc, x.name), '[]')
                     from research.participants t join research.users x on x.id = t.user_id where t.project_id = pid),
    'activities', (select coalesce(jsonb_agg(research.activity_json(a) order by a.deadline), '[]') from research.activities a where a.project_id = pid),
    'milestones', (select coalesce(jsonb_agg(research.milestone_json(m) - 'activities' order by m.target_date), '[]') from research.milestones m where m.project_id = pid),
    'documents', (select coalesce(jsonb_agg(jsonb_build_object('title', dd.title, 'kind', dd.kind,
                    'version', (select max(version) from research.document_versions v where v.document_id = dd.id)) order by dd.id), '[]')
                  from research.documents dd where dd.project_id = pid and dd.deleted_at is null),
    'closures', (select coalesce(jsonb_agg(to_jsonb(c) order by c.id), '[]') from research.closures c where c.project_id = pid));
end $$;

create or replace function research.ep_reports(u research.users, act text, d jsonb)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare ids jsonb; reports jsonb := '[]'; e jsonb;
begin
  if u.role not in ('researcher', 'coordinator') then perform research.fail(403, 'Tu rol no genera reportes.'); end if;
  if act = 'general' then
    if u.role <> 'coordinator' then perform research.fail(403, 'Solo Coordinación genera reportes generales.'); end if;
    select coalesce(jsonb_agg(id order by id), '[]') into ids from research.projects;
    if jsonb_array_length(ids) > 200 then
      select coalesce(jsonb_agg(id order by id desc), '[]') into ids from (select id from research.projects order by id desc limit 200) s;
    end if;
  elsif act = 'project' then
    ids := jsonb_build_array(research.req_id(d, 'project_id'));
  else
    perform research.fail(404, 'Reporte no disponible.');
  end if;
  for e in select value from jsonb_array_elements(ids) loop
    reports := reports || research.project_report(u, research.req_id(jsonb_build_object('id', e), 'id'));
  end loop;
  return research.ok(jsonb_build_object('generated_at', now(), 'generated_by', u.name, 'projects', reports));
end $$;
