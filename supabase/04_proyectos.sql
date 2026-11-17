-- =====================================================================
-- URPMP · 04 · Proyectos (diagrama 3)
-- 1 Inicio (propuesta aprobada → proyecto) · 2 Configurar proyecto
-- 3 Formar equipo · 4 Planificar actividades e hitos · 5 Ejecución
-- 6 Seguimiento · 7 Solicitud de cierre · 8 Revisión de cierre
-- =====================================================================

create or replace function research.history_items(pid integer, v_entity text, eid integer)
returns jsonb language sql stable
set search_path = research, extensions, pg_temp as $$
  select coalesce(jsonb_agg(to_jsonb(h) || jsonb_build_object('actor_name', x.name) order by h.id desc), '[]')
  from research.project_history h join research.users x on x.id = h.actor_id
  where h.project_id = pid and (v_entity is null or (h.entity = v_entity and h.entity_id = eid));
$$;

-- ------------------------------------------------------------------
create or replace function research.ep_projects(u research.users, act text, d jsonb, is_post boolean)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare p research.projects; pid integer; uid integer; v_start date; v_end date;
begin
  if act = 'list' then return research.ok(jsonb_build_object('items', research.project_list(u))); end if;
  pid := research.req_id(d, 'project_id');
  p := research.project_access(u, pid, is_post);

  if act = 'detail' then
    return research.ok(jsonb_build_object('item', research.project_json(p) || jsonb_build_object(
      'participants', (select coalesce(jsonb_agg(jsonb_build_object('user_id', t.user_id, 'name', x.name, 'role', x.role,
                         'project_role', t.project_role, 'is_active', t.is_active) order by t.is_active desc, x.name), '[]')
                       from research.participants t join research.users x on x.id = t.user_id where t.project_id = pid),
      'pending_closure', exists (select 1 from research.closures c where c.project_id = pid and c.status = 'pending'),
      'last_closure', (select to_jsonb(c) from research.closures c where c.project_id = pid order by c.id desc limit 1))));
  elsif act = 'history' then
    return research.ok(jsonb_build_object('items', research.history_items(pid, null, null)));
  elsif act = 'update' then
    -- Paso 2 del diagrama 3: el investigador responsable configura el proyecto.
    perform research.project_lead(p, u);
    perform research.project_active(p);
    v_start := research.opt_date(d, 'start_date');
    v_end := research.opt_date(d, 'end_date');
    if v_start is not null and v_end is not null and v_end < v_start then
      perform research.fail(422, 'La fecha de término debe ser posterior a la fecha de inicio.');
    end if;
    update research.projects set
      title = case when d ? 'title' then research.req_text(d, 'title', 250) else title end,
      description = case when d ? 'description' then research.req_text(d, 'description', 65535) else description end,
      objectives = case when d ? 'objectives' then research.req_text(d, 'objectives', 65535) else objectives end,
      start_date = case when d ? 'start_date' then v_start else start_date end,
      end_date = case when d ? 'end_date' then v_end else end_date end,
      updated_at = now()
    where id = pid;
    perform research.event_project(pid, u.id, 'project', pid, 'configured',
      jsonb_build_object('title', d -> 'title', 'start_date', v_start, 'end_date', v_end));
    return research.ok(jsonb_build_object('project_id', pid));
  elsif act = 'change-researcher' then
    if u.role <> 'coordinator' then perform research.fail(403, 'Solo Coordinación puede cambiar al responsable.'); end if;
    perform research.project_active(p);
    uid := research.req_id(d, 'researcher_id');
    perform research.active_role(uid, 'researcher');
    update research.projects set responsible_researcher_id = uid, updated_at = now() where id = pid;
    insert into research.participants (project_id, user_id, project_role) values (pid, uid, 'Investigador responsable')
      on conflict (project_id, user_id) do update set is_active = 1, removed_at = null, project_role = 'Investigador responsable';
    perform research.event_project(pid, u.id, 'project', pid, 'change-researcher',
      jsonb_build_object('before', p.responsible_researcher_id, 'after', uid));
    return research.ok(jsonb_build_object('project_id', pid));
  end if;
  perform research.fail(404, 'Operación no disponible.');
  return null;
end $$;

-- ------------------------------------------------------------------
create or replace function research.ep_participants(u research.users, act text, d jsonb, is_post boolean)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare
  t research.participants; p research.projects; pid integer; uid integer; target integer;
  a record; reassign jsonb; v_role text;
begin
  if research.has(d, 'participant_record_id') then
    select * into t from research.participants where id = research.req_id(d, 'participant_record_id');
    if t.id is null then perform research.fail(404, 'Registro no disponible.'); end if;
    pid := t.project_id;
  else
    pid := research.req_id(d, 'project_id');
  end if;
  p := research.project_access(u, pid, is_post);

  if act = 'list' then
    return research.ok(jsonb_build_object('items', (
      select coalesce(jsonb_agg(to_jsonb(x) || jsonb_build_object('name', us.name, 'role', us.role,
        'pending_activities', (select count(*) from research.activities a2 where a2.project_id = pid and a2.participant_id = x.user_id and a2.status <> 'completed'))
        order by x.is_active desc, us.name), '[]')
      from research.participants x join research.users us on us.id = x.user_id where x.project_id = pid)));
  elsif act = 'detail' then
    if t.id is null then perform research.fail(404, 'Registro no disponible.'); end if;
    return research.ok(jsonb_build_object('item', to_jsonb(t) || (select jsonb_build_object('name', name, 'role', role) from research.users where id = t.user_id)));
  elsif act = 'history' then
    return research.ok(jsonb_build_object('items', research.history_items(pid, 'participant', coalesce(t.user_id, 0))));
  end if;

  perform research.project_active(p);
  perform research.project_lead(p, u);
  uid := case when t.id is not null and not research.has(d, 'user_id') then t.user_id else research.req_id(d, 'user_id') end;

  if act = 'add' then
    v_role := research.opt_text(d, 'project_role', 80);
    perform 1 from research.users where id = uid and role in ('student', 'researcher') and status = 'active' for update;
    if not found then perform research.fail(422, 'Solo se pueden agregar estudiantes o investigadores activos.'); end if;
    insert into research.participants (project_id, user_id, project_role) values (pid, uid, nullif(v_role, ''))
      on conflict (project_id, user_id) do update set is_active = 1, removed_at = null,
        project_role = coalesce(nullif(excluded.project_role, ''), research.participants.project_role);
  elsif act = 'update' then
    -- Asigna o cambia el rol dentro del proyecto (diagrama 3, paso 3).
    perform research.participant_valid(pid, uid);
    v_role := research.req_text(d, 'project_role', 80);
    update research.participants set project_role = v_role where project_id = pid and user_id = uid;
  elsif act = 'remove' then
    if uid = p.responsible_researcher_id then perform research.fail(409, 'No puedes retirar al investigador responsable del proyecto.'); end if;
    perform research.participant_valid(pid, uid);
    reassign := coalesce(d -> 'reassignments', '{}'::jsonb);
    if jsonb_typeof(reassign) = 'string' then
      begin reassign := (reassign #>> '{}')::jsonb; exception when others then reassign := null; end;
    end if;
    if reassign is null or jsonb_typeof(reassign) <> 'object' then
      perform research.fail(422, 'Indica a quién pasa cada actividad pendiente.');
    end if;
    for a in select id, description from research.activities where project_id = pid and participant_id = uid and status <> 'completed' for update loop
      if not research.has(reassign, a.id::text) then
        perform research.fail(422, 'Elige a quién pasa la actividad «' || left(a.description, 60) || '» antes de retirar al participante.');
      end if;
      target := research.req_id(reassign, a.id::text);
      if target = uid then perform research.fail(422, 'Reasigna las actividades a otro participante.'); end if;
      perform research.participant_valid(pid, target);
      update research.activities set participant_id = target, updated_at = now() where id = a.id;
      perform research.event_project(pid, u.id, 'activity', a.id, 'reassign', jsonb_build_object('before', uid, 'after', target));
    end loop;
    update research.participants set is_active = 0, removed_at = now() where project_id = pid and user_id = uid;
  else
    perform research.fail(404, 'Operación no disponible.');
  end if;
  perform research.event_project(pid, u.id, 'participant', uid, act, jsonb_build_object('user', (select name from research.users where id = uid), 'project_role', d -> 'project_role'));
  return research.ok(jsonb_build_object('id', uid, 'project_id', pid));
end $$;

-- ------------------------------------------------------------------
create or replace function research.activity_json(a research.activities)
returns jsonb language sql stable
set search_path = research, extensions, pg_temp as $$
  select to_jsonb(a) || jsonb_build_object(
    'participant_name', (select name from research.users where id = a.participant_id),
    'deadline_status', research.deadline_status(a.status, a.deadline),
    'evidence_count', (select count(*) from research.documents dd where dd.activity_id = a.id and dd.kind = 'evidence' and dd.deleted_at is null),
    'milestones', (select coalesce(jsonb_agg(m.description), '[]') from research.milestone_activities ma
                   join research.milestones m on m.id = ma.milestone_id where ma.activity_id = a.id));
$$;

create or replace function research.ep_activities(u research.users, act text, d jsonb, is_post boolean)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare
  a research.activities; p research.projects; pid integer; eid integer; uid integer;
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
      select coalesce(jsonb_agg(research.activity_json(x) order by x.deadline, x.id), '[]')
      from research.activities x where x.project_id = pid
        and (coalesce(d ->> 'mine', '') <> '1' or x.participant_id = u.id))));
  elsif act = 'detail' then
    if a.id is null then perform research.fail(404, 'Actividad no disponible.'); end if;
    return research.ok(jsonb_build_object('item', research.activity_json(a)));
  elsif act = 'history' then
    return research.ok(jsonb_build_object('items', research.history_items(pid, 'activity', coalesce(a.id, 0))));
  end if;

  perform research.project_active(p);
  before := case when a.id is null then null else to_jsonb(a) end;
  eid := a.id;

  if act in ('create', 'update', 'reassign') then
    perform research.project_lead(p, u);
    uid := research.req_id(d, 'participant_id');
    perform research.participant_valid(pid, uid);
    if act = 'create' then
      insert into research.activities (project_id, description, participant_id, deadline)
        values (pid, research.req_text(d, 'description', 65535), uid, research.req_date(d, 'deadline')) returning id into eid;
    else
      if a.id is null then perform research.fail(404, 'Actividad no disponible.'); end if;
      if a.status = 'completed' then perform research.fail(409, 'La actividad ya fue completada y aceptada.'); end if;
      if act = 'reassign' then
        update research.activities set participant_id = uid, updated_at = now() where id = eid;
      else
        update research.activities set description = research.req_text(d, 'description', 65535), participant_id = uid,
          deadline = research.req_date(d, 'deadline'), updated_at = now() where id = eid;
      end if;
    end if;
  elsif act in ('start', 'submit', 'review') then
    if a.id is null then perform research.fail(404, 'Actividad no disponible.'); end if;
    if act = 'review' then
      -- Paso 6: el investigador responsable revisa y acepta.
      perform research.project_lead(p, u);
      if a.status <> 'in_review' then perform research.fail(409, 'La actividad no está en revisión.'); end if;
      decision := research.req_text(d, 'decision', 30);
      if decision not in ('approved', 'changes_requested') then perform research.fail(422, 'Decisión inválida.'); end if;
      next_s := case when decision = 'approved' then 'completed' else 'in_progress' end;
      obs := case when decision = 'changes_requested' then research.req_text(d, 'observations', 65535) else research.opt_text(d, 'observations', 65535) end;
    else
      -- Paso 5: el participante asignado realiza y entrega.
      if a.participant_id <> u.id or u.role not in ('student', 'researcher') then
        perform research.fail(403, 'Solo el participante asignado puede trabajar esta actividad.');
      end if;
      if act = 'start' and a.status <> 'pending' then perform research.fail(409, 'La actividad ya fue iniciada.'); end if;
      if act = 'submit' and a.status <> 'in_progress' then perform research.fail(409, 'Primero comienza la actividad.'); end if;
      next_s := case when act = 'start' then 'in_progress' else 'in_review' end;
      obs := case when act = 'submit' then nullif(research.opt_text(d, 'comment', 65535), '') else a.observations end;
    end if;
    update research.activities set status = next_s, observations = obs, updated_at = now() where id = eid;
  else
    perform research.fail(404, 'Operación no disponible.');
  end if;
  perform research.event_project(pid, u.id, 'activity', eid, act,
    jsonb_build_object('before', before, 'input', d - 'file_base64' - 'text_content'));
  return research.ok(jsonb_build_object('id', eid, 'project_id', pid));
end $$;

-- ------------------------------------------------------------------
create or replace function research.milestone_json(m research.milestones)
returns jsonb language sql stable
set search_path = research, extensions, pg_temp as $$
  select to_jsonb(m) || jsonb_build_object(
    'activity_ids', (select coalesce(jsonb_agg(ma.activity_id order by ma.activity_id), '[]') from research.milestone_activities ma where ma.milestone_id = m.id),
    'activity_count', (select count(*) from research.milestone_activities ma where ma.milestone_id = m.id),
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
  m research.milestones; p research.projects; pid integer; eid integer; ids integer[]; x jsonb; total integer; pending integer;
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
  elsif act = 'detail' then
    if m.id is null then perform research.fail(404, 'Hito no disponible.'); end if;
    return research.ok(jsonb_build_object('item', research.milestone_json(m)));
  elsif act = 'history' then
    return research.ok(jsonb_build_object('items', research.history_items(pid, 'milestone', coalesce(m.id, 0))));
  end if;

  perform research.project_active(p);
  perform research.project_lead(p, u);
  eid := m.id;

  if act in ('create', 'update') then
    x := d -> 'activity_ids';
    if jsonb_typeof(x) = 'string' or jsonb_typeof(x) = 'number' then x := jsonb_build_array(x); end if;
    if x is null or jsonb_typeof(x) <> 'array' or jsonb_array_length(x) = 0 then
      perform research.fail(422, 'Asocia al menos una actividad al hito.');
    end if;
    select array_agg(distinct research.req_id(jsonb_build_object('id', e), 'id')) into ids from jsonb_array_elements(x) e;
    if (select count(*) from research.activities where id = any(ids) and project_id = pid) <> cardinality(ids) then
      perform research.fail(422, 'Una de las actividades no pertenece al proyecto.');
    end if;
    if act = 'create' then
      insert into research.milestones (project_id, description, target_date)
        values (pid, research.req_text(d, 'description', 65535), research.req_date(d, 'target_date')) returning id into eid;
    else
      if m.id is null then perform research.fail(404, 'Hito no disponible.'); end if;
      update research.milestones set description = research.req_text(d, 'description', 65535),
        target_date = research.req_date(d, 'target_date'), status = 'pending' where id = eid;
      delete from research.milestone_activities where milestone_id = eid;
    end if;
    insert into research.milestone_activities (milestone_id, activity_id) select eid, unnest(ids);
  elsif act = 'achieve' then
    if m.id is null then perform research.fail(404, 'Hito no disponible.'); end if;
    if m.status = 'achieved' then perform research.fail(409, 'El hito ya está marcado como alcanzado.'); end if;
    select count(*), count(*) filter (where a.status <> 'completed') into total, pending
      from research.milestone_activities ma join research.activities a on a.id = ma.activity_id where ma.milestone_id = eid;
    if total = 0 or pending > 0 then perform research.fail(409, 'Todas las actividades del hito deben estar completadas y aceptadas (faltan ' || pending || ').'); end if;
    update research.milestones set status = 'achieved' where id = eid;
  else
    perform research.fail(404, 'Operación no disponible.');
  end if;
  perform research.event_project(pid, u.id, 'milestone', eid, act, jsonb_build_object('input', d));
  return research.ok(jsonb_build_object('id', eid, 'project_id', pid));
end $$;

-- ------------------------------------------------------------------
create or replace function research.closure_json(c research.closures)
returns jsonb language sql stable
set search_path = research, extensions, pg_temp as $$
  select to_jsonb(c) || jsonb_build_object(
    'title', (select title from research.projects where id = c.project_id),
    'requester_name', (select name from research.users where id = c.requested_by),
    'reviewer_name', (select name from research.users where id = c.reviewed_by),
    'project', (select research.project_json(p) from research.projects p where p.id = c.project_id));
$$;

create or replace function research.ep_closures(u research.users, act text, d jsonb, is_post boolean)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare c research.closures; p research.projects; pid integer; eid integer; decision text; obs text;
begin
  if act = 'list' and not research.has(d, 'project_id') then
    -- Coordinación ve todas las solicitudes; los demás, las de sus proyectos.
    return research.ok(jsonb_build_object('items', (
      select coalesce(jsonb_agg(research.closure_json(x) order by (x.status = 'pending') desc, x.id desc), '[]')
      from research.closures x where research.project_visible(u, x.project_id))));
  end if;
  if research.has(d, 'closure_id') then
    select * into c from research.closures where id = research.req_id(d, 'closure_id') for update;
    if c.id is null then perform research.fail(404, 'Solicitud no disponible.'); end if;
    pid := c.project_id;
  else
    pid := research.req_id(d, 'project_id');
  end if;
  p := research.project_access(u, pid, is_post);

  if act = 'list' then
    return research.ok(jsonb_build_object('items', (
      select coalesce(jsonb_agg(research.closure_json(x) order by x.id desc), '[]') from research.closures x where x.project_id = pid)));
  elsif act = 'detail' then
    if c.id is null then perform research.fail(404, 'Solicitud no disponible.'); end if;
    return research.ok(jsonb_build_object('item', research.closure_json(c)));
  elsif act = 'history' then
    return research.ok(jsonb_build_object('items', research.history_items(pid, 'closure', coalesce(c.id, 0))));
  elsif act = 'request' then
    -- Paso 7: el investigador responsable solicita el cierre cuando el trabajo concluyó.
    perform research.project_lead(p, u);
    perform research.project_active(p);
    insert into research.closures (project_id, requested_by, observations)
      values (pid, u.id, nullif(research.opt_text(d, 'observations', 65535), '')) returning id into eid;
    update research.projects set status = 'closing', updated_at = now() where id = pid;
  elsif act = 'review' then
    -- Paso 8: Coordinación revisa; si no aprueba, indica lo pendiente y el proyecto continúa.
    if u.role <> 'coordinator' then perform research.fail(403, 'Solo Coordinación revisa el cierre.'); end if;
    if c.id is null or c.status <> 'pending' or p.status <> 'closing' then perform research.fail(409, 'No hay una solicitud de cierre pendiente.'); end if;
    decision := research.req_text(d, 'decision', 30);
    if decision not in ('approved', 'changes_requested') then perform research.fail(422, 'Decisión inválida.'); end if;
    obs := case when decision = 'changes_requested' then research.req_text(d, 'observations', 65535) else research.opt_text(d, 'observations', 65535) end;
    eid := c.id;
    update research.closures set status = decision, review_observations = nullif(obs, ''), reviewed_by = u.id, reviewed_at = now() where id = eid;
    update research.projects set status = case when decision = 'approved' then 'finalized' else 'active' end, updated_at = now() where id = pid;
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
  select count(*), count(*) filter (where status = 'completed') into total, done from research.activities where project_id = pid;
  return research.project_json(p) || jsonb_build_object(
    'progress', case when total = 0 then 0 else round(done * 100.0 / total, 2) end,
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
    ids := d -> 'project_ids';
    if jsonb_typeof(ids) in ('string', 'number') then ids := jsonb_build_array(ids); end if;
    if ids is null or jsonb_typeof(ids) <> 'array' or jsonb_array_length(ids) = 0 then
      -- Sin selección: todos los proyectos.
      select coalesce(jsonb_agg(id order by id), '[]') into ids from research.projects;
    end if;
    if jsonb_array_length(ids) > 100 then perform research.fail(422, 'Selecciona máximo 100 proyectos.'); end if;
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
