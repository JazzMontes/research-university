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

-- Eliminar un proyecto por completo (solo Coordinación): proyecto, su propuesta y todo lo que cuelga de ellos.
create or replace function research.project_counts(p research.projects)
returns jsonb language sql stable
set search_path = research, extensions, pg_temp as $$
  select jsonb_build_object(
    'title', p.title, 'status', p.status,
    'activities', (select count(*) from research.activities where project_id = p.id),
    'milestones', (select count(*) from research.milestones where project_id = p.id),
    'documents', (select count(*) from research.documents where (project_id = p.id or proposal_id = p.proposal_id) and kind <> 'evidence'),
    'evidence', (select count(*) from research.documents where project_id = p.id and kind = 'evidence'),
    'members', (select count(*) from research.participants where project_id = p.id and is_active = 1));
$$;

-- Tablas de versiones anteriores (p. ej. evaluaciones de la v2) que todavía apuntan a propuestas o proyectos:
-- se limpian antes de borrar, para que la base no lo impida. Las tablas actuales se borran aparte.
create or replace function research.purge_refs(target text, ids integer[])
returns void language plpgsql
set search_path = research, extensions, pg_temp as $$
declare r record;
begin
  if ids is null or cardinality(ids) = 0 then return; end if;
  for r in select c.conrelid::regclass::text tbl, a.attname col
           from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
           where c.contype = 'f' and c.confrelid = to_regclass(target) and array_length(c.conkey, 1) = 1
             and c.conrelid::regclass::text not in ('research.projects', 'research.documents', 'research.proposal_history',
               'research.researcher_change_requests', 'research.participants', 'research.activities', 'research.milestones',
               'research.closures', 'research.project_history', 'research.milestone_activities', 'research.document_versions',
               'research.document_chunks')
  loop
    execute format('delete from %s where %I = any($1)', r.tbl, r.col) using ids;
  end loop;
end $$;

create or replace function research.project_purge(p research.projects)
returns void language plpgsql
set search_path = research, extensions, pg_temp as $$
declare acts integer[]; docs integer[];
begin
  select coalesce(array_agg(id), '{}') into acts from research.activities where project_id = p.id;
  select coalesce(array_agg(id), '{}') into docs from research.documents
    where project_id = p.id or proposal_id = p.proposal_id or activity_id = any(acts);
  delete from research.notifications where link = 'projects/' || p.id or link = 'proposals/' || p.proposal_id
    or link = any(select 'activities/' || unnest(acts));
  perform research.purge_refs('research.documents', docs);
  perform research.purge_refs('research.activities', acts);
  perform research.purge_refs('research.projects', array[p.id]);
  perform research.purge_refs('research.proposals', array[p.proposal_id]);
  delete from research.document_chunks where document_id = any(docs);
  delete from research.document_versions where document_id = any(docs);
  delete from research.documents where id = any(docs);
  delete from research.milestone_activities where activity_id = any(acts)
    or milestone_id in (select id from research.milestones where project_id = p.id);
  delete from research.milestones where project_id = p.id;
  delete from research.activities where project_id = p.id;
  delete from research.closures where project_id = p.id;
  delete from research.project_history where project_id = p.id;
  delete from research.participants where project_id = p.id;
  delete from research.researcher_change_requests where project_id = p.id or proposal_id = p.proposal_id;
  update research.assistant_log set project_id = null where project_id = p.id;
  delete from research.projects where id = p.id;
  delete from research.proposal_history where proposal_id = p.proposal_id;
  delete from research.proposals where id = p.proposal_id;
end $$;

-- ------------------------------------------------------------------
-- Eliminar por completo una propuesta. Si ya era proyecto, se usa project_purge (borra ambos).
-- ------------------------------------------------------------------
create or replace function research.proposal_purge(x research.proposals, actor integer)
returns void language plpgsql
set search_path = research, extensions, pg_temp as $$
declare p research.projects; docs integer[];
begin
  select * into p from research.projects where proposal_id = x.id;
  if p.id is not null then
    perform research.notify(array_remove(research.team_ids(p.id), actor), 'Se eliminó el proyecto «' || p.title || '»',
      'Se eliminó por completo junto con su propuesta, actividades y documentos.', 'projects', 'cancelled');
    insert into research.deleted_items (kind, title, details, deleted_by) values ('project', p.title, research.project_counts(p), actor);
    perform research.project_purge(p);
    return;
  end if;
  perform research.notify(array_remove(array[x.author_id, x.responsible_researcher_id], actor), 'Se eliminó la propuesta «' || x.title || '»',
    null, 'proposals', 'cancelled');
  select coalesce(array_agg(id), '{}') into docs from research.documents where proposal_id = x.id;
  delete from research.notifications where link = 'proposals/' || x.id;
  perform research.purge_refs('research.documents', docs);
  perform research.purge_refs('research.proposals', array[x.id]);
  delete from research.document_chunks where document_id = any(docs);
  delete from research.document_versions where document_id = any(docs);
  delete from research.documents where id = any(docs);
  delete from research.researcher_change_requests where proposal_id = x.id;
  delete from research.proposal_history where proposal_id = x.id;
  delete from research.proposals where id = x.id;
  insert into research.deleted_items (kind, title, details, deleted_by)
    values ('proposal', x.title, jsonb_build_object('status', x.status, 'author', (select name from research.users where id = x.author_id)), actor);
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
                         'can_manage', t.can_manage, 'is_creator', t.user_id = p.creator_id,
                         'pending_activities', (select count(*) from research.activities a where a.project_id = pid
                                                and a.participant_id = t.user_id and a.status in ('pending', 'in_review', 'changes')))
                         order by t.is_active desc, x.name), '[]')
                       from research.participants t join research.users x on x.id = t.user_id where t.project_id = pid),
      'i_can_manage', research.can_manage(p, u),
      'creator_name', (select name from research.users where id = p.creator_id),
      'is_creator', p.creator_id = u.id,
      'change_request', (select research.change_request_json(c) from research.researcher_change_requests c
                         where c.project_id = pid and c.status = 'pending' order by c.id desc limit 1),
      'last_closure', (select to_jsonb(c) || jsonb_build_object('requester_name', (select name from research.users where id = c.requested_by),
                                                                'reviewer_name', (select name from research.users where id = c.reviewed_by))
                       from research.closures c where c.project_id = pid order by c.id desc limit 1))));
  elsif act = 'history' then
    return research.ok(jsonb_build_object('items', research.history_items(pid, null, null)));
  elsif act = 'color' then
    -- Color para distinguir el proyecto: responsable, quien gestiona el plan o Coordinación. Vacío = color automático.
    if u.role <> 'coordinator' and not research.can_manage(p, u) then
      perform research.fail(403, 'Solo el investigador responsable o Coordinación cambian el color.');
    end if;
    if coalesce(d ->> 'color', '') <> '' and (d ->> 'color') !~ '^#[0-9A-Fa-f]{6}$' then perform research.fail(422, 'Color no válido.'); end if;
    update research.projects set color = nullif(lower(d ->> 'color'), '') where id = pid;
    return research.ok(jsonb_build_object('project_id', pid, 'color', research.project_color_by_id(pid)));
  elsif act = 'update' then
    -- El investigador responsable configura datos y fechas.
    perform research.project_lead(p, u);
    perform research.project_active(p);
    -- El inicio no se edita: es el día en que se aprobó la propuesta. Solo se ajusta el término estimado.
    v_start := p.start_date;
    v_end := research.opt_date(d, 'end_date');
    if v_end is not null and v_start is not null and v_end < v_start then
      perform research.fail(422, 'El término estimado no puede ser antes del inicio del proyecto (' || to_char(v_start, 'DD/MM/YYYY') || ').');
    end if;
    update research.projects set
      title = research.req_text(d, 'title', 250),
      description = research.req_text(d, 'description', 65535),
      objectives = research.req_text(d, 'objectives', 65535),
      end_date = v_end, updated_at = now()
    where id = pid;
    perform research.event_project(pid, u.id, 'project', pid, 'configured',
      jsonb_build_object('title', d -> 'title', 'end_date', v_end));
    return research.ok(jsonb_build_object('project_id', pid));
  end if;

  if u.role <> 'coordinator' then perform research.fail(403, 'Solo Coordinación puede hacer este cambio.'); end if;

  if act = 'delete-impact' then
    return research.ok(jsonb_build_object('impact', research.project_counts(p)));
  elsif act = 'delete' then
    -- Se confirma escribiendo ELIMINAR; no se puede deshacer.
    if upper(btrim(coalesce(d ->> 'confirm', ''))) <> 'ELIMINAR' then
      perform research.fail(422, 'Escribe ELIMINAR para confirmar.');
    end if;
    perform research.notify(array_remove(research.team_ids(pid), u.id), 'Se eliminó el proyecto «' || p.title || '»',
      'Coordinación lo eliminó por completo junto con sus actividades y documentos.', 'projects', 'cancelled');
    insert into research.deleted_items (kind, title, details, deleted_by) values ('project', p.title, research.project_counts(p), u.id);
    perform research.project_purge(p);
    return research.ok(jsonb_build_object('deleted', pid));
  end if;

  if act = 'change-researcher' then
    perform research.project_set_researcher(p, research.req_id(d, 'researcher_id'), u.id, research.opt_text(d, 'reason', 2000));
  elsif act = 'cancel' then
    if p.status in ('finalized', 'cancelled') then perform research.fail(409, 'El proyecto ya está ' || case p.status when 'cancelled' then 'cancelado.' else 'completado.' end); end if;
    v_reason := research.req_text(d, 'reason', 2000);
    -- Si había una solicitud de cierre pendiente, se responde automáticamente.
    update research.closures set status = 'changes_requested', review_observations = 'Proyecto cancelado: ' || v_reason,
      reviewed_by = u.id, reviewed_at = now() where project_id = pid and status = 'pending';
    update research.projects set status = 'cancelled', status_note = v_reason, finished_on = research.today(), updated_at = now() where id = pid;
    perform research.event_project(pid, u.id, 'project', pid, 'cancelled', jsonb_build_object('reason', v_reason));
    perform research.change_requests_cleanup();
    -- La propuesta de origen también queda cancelada (y vuelve a "Aprobada" si se reabre el proyecto).
    if exists (select 1 from research.proposals where id = p.proposal_id and status = 'approved') then
      update research.proposals set status = 'cancelled', status_before_cancel = 'approved', updated_at = now() where id = p.proposal_id;
      perform research.proposal_history_add(p.proposal_id, u.id, 'cancelled', 'approved', 'cancelled', 'Se canceló el proyecto: ' || v_reason);
    end if;
  elsif act = 'reopen' then
    -- Corrige un cierre o una cancelación hechos por error.
    if p.status not in ('finalized', 'cancelled') then perform research.fail(409, 'El proyecto ya está abierto.'); end if;
    if not exists (select 1 from research.users where id = p.responsible_researcher_id and role in ('researcher', 'coordinator') and status = 'active') then
      perform research.fail(409, 'El investigador responsable ya no está activo. Reactiva su cuenta o, después de reabrir, cambia al responsable.');
    end if;
    v_reason := research.req_text(d, 'reason', 2000);
    update research.projects set status = 'active', status_note = null, finished_on = null, updated_at = now() where id = pid;
    perform research.event_project(pid, u.id, 'project', pid, 'reopened', jsonb_build_object('before', p.status, 'reason', v_reason));
    -- Si el proyecto se había cancelado junto con su propuesta, la propuesta vuelve a "Aprobada".
    if exists (select 1 from research.proposals where id = p.proposal_id and status = 'cancelled' and status_before_cancel = 'approved') then
      update research.proposals set status = 'approved', status_before_cancel = null, updated_at = now() where id = p.proposal_id;
      perform research.proposal_history_add(p.proposal_id, u.id, 'reactivated', 'cancelled', 'approved', 'Se reabrió el proyecto: ' || v_reason);
    end if;
  else
    perform research.fail(404, 'Operación no disponible.');
  end if;
  return research.ok(jsonb_build_object('project_id', pid));
end $$;

-- ------------------------------------------------------------------
-- Equipo: agregar, cambiar rol en el proyecto y retirar.
-- Retirar no borra nada: la persona queda en el historial y se puede reincorporar.
-- ------------------------------------------------------------------
-- Cambia a quien figura como creador(a) del proyecto (la única persona que puede pedir cambio de investigador).
-- Recibe también los permisos del plan de trabajo; el investigador responsable puede quitárselos después.
create or replace function research.project_set_creator(pid integer, new_creator integer, actor integer, why text)
returns void language plpgsql
set search_path = research, extensions, pg_temp as $$
declare p research.projects; before_name text;
begin
  select * into p from research.projects where id = pid;
  if p.creator_id is not distinct from new_creator then return; end if;
  before_name := (select name from research.users where id = p.creator_id);
  update research.projects set creator_id = new_creator, updated_at = now() where id = pid;
  if new_creator <> p.responsible_researcher_id then
    update research.participants set can_manage = 1 where project_id = pid and user_id = new_creator and is_active = 1;
  end if;
  perform research.event_project(pid, actor, 'project', pid, 'creator_changed', jsonb_build_object(
    'before', before_name, 'after', (select name from research.users where id = new_creator), 'reason', why));
  perform research.notify(array[new_creator], 'Ahora eres creador(a) del proyecto «' || p.title || '»',
    coalesce(why, '') || '. Puedes gestionar el plan de trabajo y eres quien puede solicitar el cambio de investigador.',
    'projects/' || pid, 'done');
end $$;

create or replace function research.ep_participants(u research.users, act text, d jsonb, is_post boolean)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare
  p research.projects; pid integer; uid integer; target integer; a record; v_role text; moved integer := 0;
begin
  pid := research.req_id(d, 'project_id');
  p := research.project_access(u, pid, is_post);
  perform research.project_active(p);
  if act = 'leave' then
    -- Cualquier integrante (menos el investigador responsable) puede salir; si es quien creó el proyecto, deja a otra persona.
    if p.responsible_researcher_id = u.id then
      perform research.fail(409, 'Eres el investigador responsable: tu salida la aprueba Coordinación. Usa «Salir del proyecto» y propone a quién deja en tu lugar.');
    end if;
    if not exists (select 1 from research.participants where project_id = pid and user_id = u.id and is_active = 1) then
      perform research.fail(409, 'Ya no estás en el equipo.');
    end if;
    uid := u.id;
  else
    perform research.project_lead(p, u);
    uid := research.req_id(d, 'user_id');
  end if;

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
  elsif act = 'permissions' then
    perform research.participant_valid(pid, uid);
    if uid = p.responsible_researcher_id then perform research.fail(409, 'El investigador responsable ya tiene todos los permisos.'); end if;
    update research.participants set can_manage = research.req_bool(d, 'can_manage')::int where project_id = pid and user_id = uid;
    perform research.notify(array[uid],
      case when research.req_bool(d, 'can_manage') then 'Ahora puedes gestionar el plan de trabajo de «' || p.title || '»'
           else 'Ya no gestionas el plan de trabajo de «' || p.title || '»' end,
      case when research.req_bool(d, 'can_manage') then 'Puedes crear, editar y revisar actividades e hitos del proyecto.' end,
      'projects/' || pid, case when research.req_bool(d, 'can_manage') then 'done' else 'changes' end);
    d := d || jsonb_build_object('can_manage', research.req_bool(d, 'can_manage'));
  elsif act = 'update' then
    perform research.participant_valid(pid, uid);
    if uid = p.responsible_researcher_id then perform research.fail(409, 'El rol del investigador responsable no se cambia aquí.'); end if;
    v_role := research.opt_text(d, 'project_role', 80);
    update research.participants set project_role = nullif(v_role, '') where project_id = pid and user_id = uid;
  elsif act in ('remove', 'leave') then
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
    if uid = p.creator_id then
      if not research.has(d, 'new_creator_id') then
        perform research.fail(422, case when act = 'leave' then 'Creaste este proyecto: antes de salir elige quién queda como creador(a).'
                                        else 'Esta persona creó el proyecto: elige quién queda como creador(a).' end);
      end if;
      if research.req_id(d, 'new_creator_id') = uid then perform research.fail(422, 'Elige a otra persona del equipo como creador(a).'); end if;
      perform research.participant_valid(pid, research.req_id(d, 'new_creator_id'));
    end if;
    update research.participants set is_active = 0, removed_at = now(), can_manage = 0 where project_id = pid and user_id = uid;
    if uid = p.creator_id then
      perform research.project_set_creator(pid, research.req_id(d, 'new_creator_id'), u.id,
        case when act = 'leave' then (select name from research.users where id = uid) || ' salió del proyecto' else 'Se retiró del equipo a quien lo creó' end);
    end if;
    if act = 'leave' then
      perform research.notify(array_remove(array[p.responsible_researcher_id], u.id), u.name || ' salió del proyecto «' || p.title || '»',
        case when moved > 0 then 'Sus ' || moved || ' actividad(es) sin terminar pasaron a ' || (select name from research.users where id = target) || '.' end,
        'projects/' || pid, 'changes');
    end if;
  else
    perform research.fail(404, 'Operación no disponible.');
  end if;
  perform research.event_project(pid, u.id, 'participant', uid, act, jsonb_build_object(
    'user', (select name from research.users where id = uid), 'project_role', d -> 'project_role', 'activities_moved', moved,
    'can_manage', d -> 'can_manage'));
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
    'project_color', research.project_color_by_id(a.project_id),
    'participant_name', (select name from research.users where id = a.participant_id),
    'project_title', (select title from research.projects where id = a.project_id),
    'deadline_status', research.deadline_status(a.status, a.deadline),
    'created_on', (a.created_at at time zone 'America/Mexico_City')::date,
    'evidence_count', (select count(*) from research.documents dd where dd.activity_id = a.id and dd.kind = 'evidence' and dd.deleted_at is null),
    'milestones', (select coalesce(jsonb_agg(m.description), '[]') from research.milestone_activities ma
                   join research.milestones m on m.id = ma.milestone_id where ma.activity_id = a.id),
    -- Cada actividad pertenece a un hito (o a ninguno): así se muestran juntos en el plan de trabajo.
    'milestone_id', (select min(ma.milestone_id) from research.milestone_activities ma where ma.activity_id = a.id),
    'materials', (select coalesce(jsonb_agg(jsonb_build_object('id', dd.id, 'title', dd.title, 'filename', v.filename,
                    'uploaded_by_name', x.name, 'updated_at', v.created_at) order by dd.id), '[]')
                  from research.documents dd
                  join lateral (select * from research.document_versions vv where vv.document_id = dd.id order by vv.version desc limit 1) v on true
                  join research.users x on x.id = v.uploaded_by
                  where dd.activity_id = a.id and dd.kind = 'project' and dd.deleted_at is null));
$$;

-- Hito de la actividad: uno solo (o ninguno, con milestone_id vacío).
create or replace function research.activity_set_milestone(pid integer, aid integer, d jsonb)
returns void language plpgsql
set search_path = research, extensions, pg_temp as $$
declare mid integer;
begin
  if not (d ? 'milestone_id') then return; end if;
  if coalesce(d ->> 'milestone_id', '') = '' then
    delete from research.milestone_activities where activity_id = aid;
    return;
  end if;
  mid := research.req_id(d, 'milestone_id');
  if not exists (select 1 from research.milestones where id = mid and project_id = pid) then
    perform research.fail(422, 'Ese hito no pertenece al proyecto.');
  end if;
  delete from research.milestone_activities where activity_id = aid;
  insert into research.milestone_activities (milestone_id, activity_id) values (mid, aid);
end $$;

-- Material de apoyo opcional que el responsable adjunta a la actividad.
-- Material de apoyo: uno (filename/file_base64) o varios a la vez (files: [{filename, file_base64, title}]).
create or replace function research.activity_material_save(pid integer, aid integer, actor integer, d jsonb)
returns void language plpgsql
set search_path = research, extensions, pg_temp as $$
declare did integer; f jsonb;
begin
  for f in select value from jsonb_array_elements(case when jsonb_typeof(d -> 'files') = 'array' then d -> 'files' else jsonb_build_array(d) end) loop
    continue when coalesce(f ->> 'file_base64', '') = '';
    insert into research.documents (project_id, activity_id, title, kind, created_by)
      values (pid, aid, coalesce(nullif(btrim(left(f ->> 'title', 250)), ''),
        nullif(regexp_replace(research.req_text(f, 'filename', 255), '\.[^.]+$', ''), ''), 'Material de la actividad'), 'project', actor)
      returning id into did;
    perform research.save_version(did, actor, f);
  end loop;
end $$;

-- Si una actividad termina después de la meta de su hito, el hito se aplaza solo: se avisa una vez por fecha.
create or replace function research.milestone_postpone_check(aid integer)
returns void language plpgsql
set search_path = research, extensions, pg_temp as $$
declare m research.milestones; due date; p research.projects;
begin
  select ms.* into m from research.milestones ms join research.milestone_activities ma on ma.milestone_id = ms.id where ma.activity_id = aid limit 1;
  if m.id is null or m.target_date is null then return; end if;
  due := research.milestone_due(m.id);
  if due is null or due <= m.target_date then return; end if;
  select * into p from research.projects where id = m.project_id;
  perform research.notify(array(select x from unnest(research.team_ids(p.id)) x where research.can_manage(p, (select us from research.users us where us.id = x))),
    '📅 El hito «' || left(m.description, 120) || '» se aplazó al ' || to_char(due, 'DD/MM/YYYY'),
    'Una de sus actividades termina después de la meta (' || to_char(m.target_date, 'DD/MM/YYYY') || '). Proyecto «' || p.title || '».',
    'projects/' || p.id, 'changes', 'postpone:' || m.id || ':' || due);
end $$;

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
      'project_status', p.status, 'lead_id', p.responsible_researcher_id, 'i_can_manage', research.can_manage(p, u),
      'history', research.history_items(pid, 'activity', a.id))));
  end if;

  perform research.project_active(p);
  before := case when a.id is null then null else to_jsonb(a) end;
  eid := a.id;

  if act in ('create', 'update') then
    perform research.project_manager(p, u);
    uid := research.req_id(d, 'participant_id');
    perform research.participant_valid(pid, uid);
    -- La fecha es opcional y estimada; si se escribe, no puede ser anterior al día en que se crea la actividad.
    v_deadline := research.opt_date(d, 'deadline');
    if act = 'create' then
      if v_deadline < research.today() then perform research.fail(422, 'La fecha de entrega no puede ser anterior a hoy (' || to_char(research.today(), 'DD/MM/YYYY') || ').'); end if;
      insert into research.activities (project_id, description, participant_id, deadline)
        values (pid, research.req_text(d, 'description', 65535), uid, v_deadline) returning id into eid;
    else
      if a.id is null then perform research.fail(404, 'Actividad no disponible.'); end if;
      if a.status in ('completed', 'cancelled') then perform research.fail(409, 'La actividad está cerrada; ya no se edita.'); end if;
      if v_deadline < (a.created_at at time zone 'America/Mexico_City')::date then
        perform research.fail(422, 'La fecha de entrega no puede ser anterior al día en que se creó la actividad (' || to_char((a.created_at at time zone 'America/Mexico_City')::date, 'DD/MM/YYYY') || ').');
      end if;
      if v_deadline < research.today() and v_deadline is distinct from a.deadline then
        perform research.fail(422, 'La nueva fecha de entrega no puede ser anterior a hoy (' || to_char(research.today(), 'DD/MM/YYYY') || ').');
      end if;
      update research.activities set description = research.req_text(d, 'description', 65535), participant_id = uid,
        deadline = v_deadline, updated_at = now() where id = eid;
    end if;
    perform research.activity_set_milestone(pid, eid, d);
    perform research.activity_material_save(pid, eid, u.id, d);
    perform research.milestone_postpone_check(eid);
  elsif act = 'submit' then
    if a.id is null then perform research.fail(404, 'Actividad no disponible.'); end if;
    if a.participant_id <> u.id then perform research.fail(403, 'Solo la persona asignada puede entregar esta actividad.'); end if;
    if a.status not in ('pending', 'changes') then
      perform research.fail(409, case a.status when 'in_review' then 'Ya la entregaste; espera la revisión.' else 'La actividad está cerrada.' end);
    end if;
    update research.activities set status = 'in_review', observations = nullif(research.opt_text(d, 'comment', 65535), ''), updated_at = now() where id = eid;
  elsif act = 'review' then
    if a.id is null then perform research.fail(404, 'Actividad no disponible.'); end if;
    perform research.project_manager(p, u);
    if a.participant_id = u.id and p.responsible_researcher_id <> u.id then
      perform research.fail(403, 'Tu propia actividad la revisa el investigador responsable u otra persona con permiso.');
    end if;
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
    perform research.project_manager(p, u);
    if a.status in ('completed', 'cancelled') then perform research.fail(409, 'La actividad ya está cerrada.'); end if;
    obs := research.req_text(d, 'reason', 2000);
    update research.activities set status = 'cancelled', observations = obs, updated_at = now() where id = eid;
  elsif act = 'set-milestone' then
    -- Mover una actividad a un hito (arrastrándola o eligiéndola desde el hito), o sacarla ("Sin hito").
    if a.id is null then perform research.fail(404, 'Actividad no disponible.'); end if;
    perform research.project_manager(p, u);
    if a.status = 'cancelled' then perform research.fail(409, 'La actividad está cancelada.'); end if;
    if not (d ? 'milestone_id') then d := d || jsonb_build_object('milestone_id', ''); end if;
    perform research.activity_set_milestone(pid, eid, d);
    perform research.milestone_postpone_check(eid);
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
    'due_date', research.milestone_due(m.id),
    'postponed', research.milestone_due(m.id) > m.target_date,
    'activity_ids', (select coalesce(jsonb_agg(ma.activity_id order by ma.activity_id), '[]') from research.milestone_activities ma where ma.milestone_id = m.id),
    'activity_count', (select count(*) from research.milestone_activities ma join research.activities a on a.id = ma.activity_id
                       where ma.milestone_id = m.id and a.status <> 'cancelled'),
    'completed_count', (select count(*) from research.milestone_activities ma join research.activities a on a.id = ma.activity_id
                        where ma.milestone_id = m.id and a.status = 'completed'),
    'activities', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'description', a.description, 'status', a.status,
                     'participant_name', x.name, 'deadline', a.deadline) order by a.deadline nulls last), '[]')
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
      select coalesce(jsonb_agg(research.milestone_json(y) order by research.milestone_due(y.id) nulls last, y.id), '[]') from research.milestones y where y.project_id = pid)));
  end if;

  perform research.project_active(p);
  perform research.project_manager(p, u);
  eid := m.id;

  if act in ('create', 'update') then
    -- Las actividades se vinculan desde cada actividad; si aquí no se mandan, se conservan las que ya tiene.
    x := coalesce(d -> 'activity_ids', '[]'::jsonb);
    if jsonb_typeof(x) in ('string', 'number') then x := jsonb_build_array(x); end if;
    if jsonb_typeof(x) <> 'array' then perform research.fail(422, 'Revisa las actividades del hito.'); end if;
    select coalesce(array_agg(distinct research.req_id(jsonb_build_object('id', e), 'id')), '{}') into ids from jsonb_array_elements(x) e;
    if (select count(*) from research.activities where id = any(ids) and project_id = pid) <> cardinality(ids) then
      perform research.fail(422, 'Una de las actividades no pertenece al proyecto.');
    end if;
    if research.opt_date(d, 'target_date') < coalesce(p.start_date, research.today()) then
      perform research.fail(422, 'La fecha meta no puede ser antes del inicio del proyecto (' || to_char(coalesce(p.start_date, research.today()), 'DD/MM/YYYY') || ').');
    end if;
    if act = 'create' then
      insert into research.milestones (project_id, description, target_date)
        values (pid, research.req_text(d, 'description', 65535), research.opt_date(d, 'target_date')) returning id into eid;
    else
      if m.id is null then perform research.fail(404, 'Hito no disponible.'); end if;
      update research.milestones set description = research.req_text(d, 'description', 65535),
        target_date = research.opt_date(d, 'target_date') where id = eid;
      if d ? 'activity_ids' then delete from research.milestone_activities where milestone_id = eid; end if;
    end if;
    if d ? 'activity_ids' then
      -- Una actividad pertenece a un solo hito: se quita de los demás.
      delete from research.milestone_activities where activity_id = any(ids) and milestone_id <> eid;
      insert into research.milestone_activities (milestone_id, activity_id) select eid, unnest(ids) on conflict do nothing;
    end if;
  elsif act = 'assign' then
    -- Pasa actividades a este hito (o las deja sin hito si no se indica hito). Sirve para arrastrar y soltar.
    x := coalesce(d -> 'activity_ids', '[]'::jsonb);
    if jsonb_typeof(x) in ('string', 'number') then x := jsonb_build_array(x); end if;
    if jsonb_typeof(x) <> 'array' or jsonb_array_length(x) = 0 then perform research.fail(422, 'Elige al menos una actividad.'); end if;
    select coalesce(array_agg(distinct research.req_id(jsonb_build_object('id', e), 'id')), '{}') into ids from jsonb_array_elements(x) e;
    if (select count(*) from research.activities where id = any(ids) and project_id = pid) <> cardinality(ids) then
      perform research.fail(422, 'Una de las actividades no pertenece al proyecto.');
    end if;
    delete from research.milestone_activities where activity_id = any(ids) and milestone_id is distinct from m.id;
    if m.id is not null then
      insert into research.milestone_activities (milestone_id, activity_id) select m.id, unnest(ids) on conflict do nothing;
    end if;
    perform research.event_project(pid, u.id, 'milestone', coalesce(m.id, 0), 'assign', jsonb_build_object(
      'description', coalesce(m.description, 'Sin hito'),
      'activities', (select string_agg(description, ', ') from research.activities where id = any(ids))));
    return research.ok(jsonb_build_object('milestone_id', m.id, 'activity_ids', to_jsonb(ids)));
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
      status_note = case when decision = 'approved' then null else obs end,
      finished_on = case when decision = 'approved' then research.today() else null end, updated_at = now() where id = pid;
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
    'milestones', (select coalesce(jsonb_agg(research.milestone_json(m) - 'activities' order by research.milestone_due(m.id) nulls last), '[]') from research.milestones m where m.project_id = pid),
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

-- ------------------------------------------------------------------
-- Eventos importantes del calendario.
-- ------------------------------------------------------------------
create or replace function research.event_visible(u research.users, e research.calendar_events)
returns boolean language sql stable
set search_path = research, extensions, pg_temp as $$
  select e.project_id is null or research.project_visible(u, e.project_id);
$$;

-- Quiénes reciben avisos del evento: todos (sin proyecto) o el equipo del proyecto y Coordinación.
create or replace function research.event_audience(e research.calendar_events)
returns integer[] language plpgsql stable
set search_path = research, extensions, pg_temp as $$
begin
  if e.project_id is null then
    return (select coalesce(array_agg(id), '{}') from research.users where status = 'active' and deleted_at is null);
  end if;
  return research.team_ids(e.project_id) || research.coordinator_ids();
end $$;

create or replace function research.event_when(e research.calendar_events)
returns text language sql stable as $$
  select to_char(e.event_date, 'DD/MM/YYYY') || case when e.event_time is null then ' (todo el día)'
         else ' a las ' || to_char(e.event_time, 'HH24:MI') end;
$$;

create or replace function research.event_starts(e research.calendar_events)
returns timestamptz language sql stable as $$
  select (e.event_date + coalesce(e.event_time, time '00:00')) at time zone 'America/Mexico_City';
$$;

create or replace function research.event_json(u research.users, e research.calendar_events)
returns jsonb language sql stable
set search_path = research, extensions, pg_temp as $$
  select jsonb_build_object('id', e.id, 'title', e.title, 'description', e.description, 'location', e.location,
    'event_date', e.event_date, 'event_time', to_char(e.event_time, 'HH24:MI'),
    'project_id', e.project_id, 'project_title', p.title, 'project_color', case when p.id is null then null else research.project_color(p) end,
    'created_by', e.created_by, 'created_by_name', coalesce(c.name, 'Usuario eliminado'),
    'can_edit', u.role = 'coordinator' or e.created_by = u.id)
  from (select 1) x
  left join research.projects p on p.id = e.project_id
  left join research.users c on c.id = e.created_by;
$$;

-- Proyectos a los que alguien puede ligar un evento: Coordinación, a cualquiera en curso; un investigador, a los suyos.
create or replace function research.event_projects(u research.users)
returns jsonb language sql stable
set search_path = research, extensions, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'color', research.project_color(p)) order by p.title), '[]')
  from research.projects p
  where p.status in ('active', 'changes', 'closing')
    and (u.role = 'coordinator' or (u.role = 'researcher' and p.responsible_researcher_id = u.id));
$$;

create or replace function research.event_save(u research.users, d jsonb)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare e research.calendar_events; old research.calendar_events; v_id integer; v_title text; v_desc text; v_loc text;
        v_date date; v_time_txt text; v_time time; v_pid integer; aud integer[]; moved boolean;
begin
  if u.role not in ('coordinator', 'researcher') then
    perform research.fail(403, 'Solo Coordinación o investigadores pueden agregar eventos al calendario.');
  end if;
  if research.has(d, 'event_id') then
    v_id := research.req_id(d, 'event_id');
    select * into old from research.calendar_events where id = v_id;
    if not found then perform research.fail(404, 'El evento ya no existe.'); end if;
    if u.role <> 'coordinator' and old.created_by is distinct from u.id then
      perform research.fail(403, 'Solo quien creó el evento o Coordinación pueden cambiarlo.');
    end if;
  end if;
  v_title := research.req_text(d, 'title', 160);
  v_desc := research.opt_text(d, 'description', 2000);
  v_loc := research.opt_text(d, 'location', 200);
  v_date := research.req_date(d, 'event_date');
  v_time_txt := research.opt_text(d, 'event_time', 5);
  if v_time_txt <> '' then
    if v_time_txt !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then perform research.fail(422, 'Escribe la hora como HH:MM (por ejemplo 16:30).'); end if;
    v_time := v_time_txt::time;
  end if;
  if research.has(d, 'project_id') and coalesce(d ->> 'project_id', '') not in ('', '0') then
    v_pid := research.req_id(d, 'project_id');
    if not exists (select 1 from jsonb_array_elements(research.event_projects(u)) x where (x ->> 'id')::int = v_pid)
       and v_pid is distinct from old.project_id then
      perform research.fail(422, 'Solo puedes ligar el evento a un proyecto en curso que tú administres.');
    end if;
  end if;
  moved := old.id is null or old.event_date is distinct from v_date or old.event_time is distinct from v_time;
  if moved and (v_date < research.today() or (v_date = research.today() and v_time is not null and v_time < (now() at time zone 'America/Mexico_City')::time)) then
    perform research.fail(422, 'La fecha y hora del evento ya pasaron.');
  end if;
  if old.id is null then
    insert into research.calendar_events (title, description, location, event_date, event_time, project_id, created_by)
    values (v_title, v_desc, v_loc, v_date, v_time, v_pid, u.id) returning * into e;
    perform research.notify(array_remove(research.event_audience(e), u.id), '📌 Nuevo evento: ' || left(e.title, 150),
      research.event_when(e) || case when e.location <> '' then ' · ' || e.location else '' end
        || case when e.description <> '' then E'\n' || left(e.description, 300) else '' end
        || E'\nLo agregó ' || u.name || '.',
      'calendar', 'changes', 'evnew:' || e.id);
  else
    update research.calendar_events set title = v_title, description = v_desc, location = v_loc, event_date = v_date,
      event_time = v_time, project_id = v_pid, updated_at = now() where id = old.id returning * into e;
    if moved then
      delete from research.notifications where dedupe_key ~ ('^ev(3|1|0|h):' || e.id || ':');
      perform research.notify(array_remove(research.event_audience(e), u.id), '🔁 Cambió la fecha del evento «' || left(e.title, 140) || '»',
        'Ahora es el ' || research.event_when(e) || case when e.location <> '' then ' · ' || e.location else '' end || '.',
        'calendar', 'changes', 'evmove:' || e.id || ':' || e.event_date || ':' || coalesce(e.event_time::text, ''));
    end if;
  end if;
  return research.ok(jsonb_build_object('event', research.event_json(u, e)));
end $$;

create or replace function research.event_delete(u research.users, d jsonb)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare e research.calendar_events;
begin
  select * into e from research.calendar_events where id = research.req_id(d, 'event_id');
  if not found then perform research.fail(404, 'El evento ya no existe.'); end if;
  if u.role <> 'coordinator' and e.created_by is distinct from u.id then
    perform research.fail(403, 'Solo quien creó el evento o Coordinación pueden eliminarlo.');
  end if;
  if research.event_starts(e) > now() - interval '1 day' then
    perform research.notify(array_remove(research.event_audience(e), u.id), '✖ Se canceló el evento «' || left(e.title, 140) || '»',
      'Era el ' || research.event_when(e) || '.', 'calendar', 'cancelled', 'evdel:' || e.id);
  end if;
  delete from research.notifications where dedupe_key ~ ('^ev(3|1|0|h):' || e.id || ':');
  delete from research.calendar_events where id = e.id;
  return research.ok(jsonb_build_object('deleted', e.id));
end $$;

-- ------------------------------------------------------------------
-- Calendario: actividades y hitos con fecha en un rango, más las actividades abiertas sin fecha.
-- scope = 'mine' (mis actividades) o 'all' (todo lo de los proyectos que puedo ver).
-- ------------------------------------------------------------------
create or replace function research.ep_calendar(u research.users, act text, d jsonb)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare v_from date; v_to date; v_scope text := coalesce(d ->> 'scope', 'mine'); vis integer[];
begin
  if act = 'event-save' then return research.event_save(u, d); end if;
  if act = 'event-delete' then return research.event_delete(u, d); end if;
  if act <> 'list' then perform research.fail(404, 'Operación no disponible.'); end if;
  v_from := coalesce(research.opt_date(d, 'from'), date_trunc('month', research.today())::date - 7);
  v_to := coalesce(research.opt_date(d, 'to'), v_from + 49);
  if v_to < v_from or v_to - v_from > 200 then perform research.fail(422, 'Rango de fechas no válido.'); end if;
  select coalesce(array_agg(p.id), '{}') into vis from research.projects p
    where research.project_visible(u, p.id) and p.status <> 'cancelled';
  return research.ok(jsonb_build_object(
    'activities', (select coalesce(jsonb_agg(research.activity_brief(a) || jsonb_build_object(
                     'participant_id', a.participant_id,
                     'milestone', (select m.description from research.milestone_activities ma join research.milestones m on m.id = ma.milestone_id where ma.activity_id = a.id limit 1))
                     order by a.deadline, a.id), '[]')
                   from research.activities a
                   where a.project_id = any(vis) and a.status <> 'cancelled' and a.deadline between v_from and v_to
                     and (v_scope = 'all' or a.participant_id = u.id)),
    'milestones', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'description', m.description, 'project_id', m.project_id,
                     'project_title', p.title, 'project_color', research.project_color(p), 'due_date', research.milestone_due(m.id),
                     'status', m.status) order by research.milestone_due(m.id)), '[]')
                   from research.milestones m join research.projects p on p.id = m.project_id
                   where m.project_id = any(vis) and research.milestone_due(m.id) between v_from and v_to
                     and (v_scope = 'all' or exists (select 1 from research.participants t where t.project_id = m.project_id and t.user_id = u.id and t.is_active = 1))),
    'undated', (select coalesce(jsonb_agg(research.activity_brief(a) order by a.id), '[]')
                from research.activities a join research.projects p on p.id = a.project_id
                where a.project_id = any(vis) and a.deadline is null and a.status in ('pending', 'changes', 'in_review')
                  and p.status in ('active', 'changes', 'closing') and (v_scope = 'all' or a.participant_id = u.id)),
    'projects', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'color', research.project_color(p), 'status', p.status) order by p.title), '[]')
                 from research.projects p where p.id = any(vis)),
    -- Eventos importantes: se muestran a todos los que pueden verlos, en «Mis fechas» y en «Todo».
    'events', (select coalesce(jsonb_agg(research.event_json(u, e) order by e.event_date, e.event_time nulls first, e.id), '[]')
               from research.calendar_events e
               where e.event_date between v_from and v_to and research.event_visible(u, e)),
    'can_create_events', u.role in ('coordinator', 'researcher'),
    'event_projects', research.event_projects(u),
    'from', v_from, 'to', v_to, 'today', research.today()));
end $$;

