-- =====================================================================
-- URPMP · 02 · Núcleo: errores, validaciones, sesiones y permisos
-- =====================================================================

-- Lanza un error con código HTTP (se convierte en { status, body:{message} }).
create or replace function research.fail(code integer, message text)
returns void language plpgsql
set search_path = research, extensions, pg_temp as $$
begin
  raise exception using message = message, errcode = 'RS' || lpad(code::text, 3, '0');
end $$;

create or replace function research.ok(body jsonb, status integer default 200)
returns jsonb language sql immutable as $$
  select jsonb_build_object('status', status, 'body', coalesce(body, '{}'::jsonb));
$$;

-- Nombre legible de cada campo para los mensajes de validación.
create or replace function research.field_label(field text)
returns text language sql immutable as $$
  select coalesce(case field
    when 'title' then 'Título' when 'description' then 'Descripción' when 'objectives' then 'Objetivos'
    when 'observations' then 'Observaciones' when 'decision' then 'Decisión' when 'name' then 'Nombre'
    when 'username' then 'Usuario' when 'password' then 'Contraseña' when 'role' then 'Rol'
    when 'status' then 'Estado' when 'deadline' then 'Fecha estimada' when 'target_date' then 'Fecha meta'
    when 'start_date' then 'Fecha de inicio' when 'end_date' then 'Fecha de término'
    when 'filename' then 'Archivo' when 'question' then 'Pregunta' when 'project_role' then 'Rol en el proyecto'
    when 'reason' then 'Motivo' when 'comment' then 'Comentario' when 'email' then 'Correo' when 'justification' then 'Justificación' when 'note' then 'Nota'
    when 'responsible_researcher_id' then 'Investigador responsable' when 'participant_id' then 'Responsable'
    when 'user_id' then 'Persona' when 'researcher_id' then 'Nuevo investigador' when 'reassign_to' then 'Quién recibe sus actividades'
    when 'new_creator_id' then 'Nuevo creador del proyecto' when 'event_date' then 'Fecha del evento' when 'event_time' then 'Hora' when 'location' then 'Lugar' when 'event_id' then 'Evento' when 'project_id' then 'Proyecto'
    else null end, field);
$$;

-- Texto obligatorio, recortado y con longitud máxima.
create or replace function research.req_text(d jsonb, field text, max_len integer)
returns text language plpgsql
set search_path = research, extensions, pg_temp as $$
declare v text;
begin
  if d is null or coalesce(jsonb_typeof(d -> field), 'null') not in ('string', 'number') then
    perform research.fail(422, 'Completa el campo ' || research.field_label(field) || '.');
  end if;
  v := btrim(d ->> field);
  if v = '' then perform research.fail(422, 'Completa el campo ' || research.field_label(field) || '.'); end if;
  if length(v) > max_len then
    perform research.fail(422, 'El campo ' || research.field_label(field) || ' admite máximo ' || max_len || ' caracteres.');
  end if;
  return v;
end $$;

-- Texto opcional: devuelve '' si no viene.
create or replace function research.opt_text(d jsonb, field text, max_len integer)
returns text language plpgsql
set search_path = research, extensions, pg_temp as $$
declare v text;
begin
  if d is null or d -> field is null or jsonb_typeof(d -> field) = 'null' then return ''; end if;
  if coalesce(jsonb_typeof(d -> field), 'null') not in ('string', 'number') then
    perform research.fail(422, 'Revisa el campo ' || research.field_label(field) || '.');
  end if;
  v := btrim(d ->> field);
  if length(v) > max_len then
    perform research.fail(422, 'El campo ' || research.field_label(field) || ' admite máximo ' || max_len || ' caracteres.');
  end if;
  return v;
end $$;

-- Identificador entero positivo (acepta número o texto numérico).
create or replace function research.req_id(d jsonb, field text)
returns integer language plpgsql
set search_path = research, extensions, pg_temp as $$
declare v text;
begin
  v := btrim(coalesce(d ->> field, ''));
  if v !~ '^[0-9]{1,9}$' or v::bigint < 1 then
    perform research.fail(422, 'Selecciona un valor válido en ' || research.field_label(field) || '.');
  end if;
  return v::integer;
end $$;

create or replace function research.has(d jsonb, field text)
returns boolean language sql immutable as $$
  select d ? field and jsonb_typeof(d -> field) <> 'null' and btrim(coalesce(d ->> field, '')) <> '';
$$;

create or replace function research.req_bool(d jsonb, field text)
returns boolean language plpgsql
set search_path = research, extensions, pg_temp as $$
begin
  if jsonb_typeof(d -> field) = 'boolean' then return (d ->> field)::boolean; end if;
  if d ->> field in ('true', '1') then return true; end if;
  if d ->> field in ('false', '0') then return false; end if;
  perform research.fail(422, 'Selecciona Sí o No.');
  return null;
end $$;

create or replace function research.req_date(d jsonb, field text)
returns date language plpgsql
set search_path = research, extensions, pg_temp as $$
declare v text; r date;
begin
  v := research.req_text(d, field, 10);
  if v !~ '^\d{4}-\d{2}-\d{2}$' then perform research.fail(422, 'Fecha inválida en ' || research.field_label(field) || '.'); end if;
  begin
    r := to_date(v, 'YYYY-MM-DD');
  exception when others then
    perform research.fail(422, 'Fecha inválida en ' || research.field_label(field) || '.');
  end;
  if to_char(r, 'YYYY-MM-DD') <> v then perform research.fail(422, 'Fecha inválida en ' || research.field_label(field) || '.'); end if;
  return r;
end $$;

create or replace function research.opt_date(d jsonb, field text)
returns date language plpgsql
set search_path = research, extensions, pg_temp as $$
begin
  if not research.has(d, field) then return null; end if;
  return research.req_date(d, field);
end $$;

create or replace function research.valid_password(p text)
returns boolean language sql immutable as $$
  select p ~ '[a-z]' and p ~ '[A-Z]' and p ~ '[0-9]' and length(p) between 8 and 72;
$$;

create or replace function research.hash_password(p text)
returns text language sql volatile
set search_path = research, extensions, pg_temp as $$
  select extensions.crypt(p, extensions.gen_salt('bf', 10));
$$;

-- Acepta hashes bcrypt de PHP ($2y$) y de pgcrypto ($2a$).
create or replace function research.check_password(p text, h text)
returns boolean language plpgsql
set search_path = research, extensions, pg_temp as $$
declare normalized text := regexp_replace(coalesce(h, ''), '^\$2[by]\$', '$2a$');
begin
  if normalized !~ '^\$2a\$' then return false; end if;
  return extensions.crypt(p, normalized) = normalized;
end $$;

create or replace function research.sha256(t text)
returns text language sql immutable
set search_path = research, extensions, pg_temp as $$
  select encode(extensions.digest(convert_to(t, 'UTF8'), 'sha256'), 'hex');
$$;

create or replace function research.public_user(u research.users)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', u.id, 'name', u.name, 'username', u.username, 'role', u.role, 'status', u.status,
    'email', u.email, 'avatar', u.avatar, 'must_change_password', coalesce(u.must_change_password, 0) = 1);
$$;

create or replace function research.role_label(r text)
returns text language sql immutable as $$
  select case r when 'student' then 'Estudiante' when 'researcher' then 'Investigador'
    when 'coordinator' then 'Coordinador' else r end;
$$;

-- ------------------------------------------------------------------
-- Sesiones: token aleatorio en el dispositivo, solo su hash en la base.
-- 30 minutos de inactividad.
-- ------------------------------------------------------------------
create or replace function research.auth_login(d jsonb)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare u research.users; token text;
begin
  if coalesce(jsonb_typeof(d -> 'username'), '') <> 'string' or coalesce(jsonb_typeof(d -> 'password'), '') <> 'string'
     or btrim(d ->> 'username') = '' or d ->> 'password' = '' then
    perform research.fail(400, 'Escribe tu usuario y contraseña.');
  end if;
  select * into u from research.users where lower(username) = lower(btrim(d ->> 'username')) limit 1;
  if u.id is null or not research.check_password(d ->> 'password', u.password_hash) then
    perform research.fail(401, 'Usuario o contraseña incorrectos.');
  end if;
  if u.status <> 'active' then
    perform research.fail(403, 'La cuenta está inactiva. Contacta a Coordinación.');
  end if;
  token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into research.user_sessions (user_id, token_hash, expires_at)
    values (u.id, research.sha256(token), now() + interval '30 minutes');
  -- Limpieza de sesiones viejas del mismo usuario.
  delete from research.user_sessions where user_id = u.id and (revoked_at is not null or expires_at < now() - interval '7 days');
  -- De vez en cuando (1 de cada 20 inicios de sesión) se limpia lo viejo de todos.
  if random() < 0.05 then perform research.housekeeping(); end if;
  return research.ok(jsonb_build_object('message', 'Inicio de sesión correcto.', 'user', research.public_user(u), 'token', token));
end $$;

create or replace function research.auth_logout(token text)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
begin
  if token is not null and token <> '' then
    update research.user_sessions set revoked_at = now()
      where token_hash = research.sha256(token) and revoked_at is null;
  end if;
  return research.ok(jsonb_build_object('message', 'Sesión cerrada.'));
end $$;

create or replace function research.require_user(token text)
returns research.users language plpgsql
set search_path = research, extensions, pg_temp as $$
declare s research.user_sessions; u research.users;
begin
  if token is null or token !~ '^[0-9a-f]{64}$' then
    perform research.fail(401, 'Tu sesión terminó. Vuelve a iniciar sesión.');
  end if;
  select * into s from research.user_sessions where token_hash = research.sha256(token) limit 1;
  if s.id is null or s.revoked_at is not null or s.expires_at <= now()
     or s.last_activity_at <= now() - interval '30 minutes' then
    perform research.fail(401, 'Tu sesión terminó. Vuelve a iniciar sesión.');
  end if;
  select * into u from research.users where id = s.user_id;
  if u.id is null or u.status <> 'active' then
    perform research.fail(401, 'Tu sesión terminó. Vuelve a iniciar sesión.');
  end if;
  update research.user_sessions set last_activity_at = now(), expires_at = now() + interval '30 minutes' where id = s.id;
  return u;
end $$;

-- ------------------------------------------------------------------
-- Permisos sobre propuestas y proyectos
-- ------------------------------------------------------------------
create or replace function research.proposal_visible(u research.users, p research.proposals)
returns boolean language sql stable
set search_path = research, extensions, pg_temp as $$
  select case u.role
    when 'coordinator' then true
    else p.author_id = u.id
      or (u.role = 'researcher' and p.responsible_researcher_id = u.id)
      or exists (select 1 from research.projects pr where pr.proposal_id = p.id
                 and (pr.responsible_researcher_id = u.id
                      or exists (select 1 from research.participants t where t.project_id = pr.id and t.user_id = u.id and t.is_active = 1)))
  end;
$$;

create or replace function research.project_visible(u research.users, pid integer)
returns boolean language sql stable
set search_path = research, extensions, pg_temp as $$
  select case
    when u.role = 'coordinator' then exists (select 1 from research.projects where id = pid)
    else exists (select 1 from research.projects p where p.id = pid and
           (p.responsible_researcher_id = u.id or exists (
              select 1 from research.participants t where t.project_id = p.id and t.user_id = u.id and t.is_active = 1)))
  end;
$$;

create or replace function research.project_access(u research.users, pid integer, do_lock boolean default false)
returns research.projects language plpgsql
set search_path = research, extensions, pg_temp as $$
declare p research.projects;
begin
  if do_lock then select * into p from research.projects where id = pid for update;
  else select * into p from research.projects where id = pid; end if;
  if p.id is null or not research.project_visible(u, pid) then
    perform research.fail(404, 'Proyecto no disponible.');
  end if;
  return p;
end $$;

create or replace function research.project_lead(p research.projects, u research.users)
returns void language plpgsql
set search_path = research, extensions, pg_temp as $$
begin
  -- Coordinación también puede ser investigadora: administra SOLO los proyectos donde es responsable.
  if u.role not in ('researcher', 'coordinator') or p.responsible_researcher_id <> u.id then
    perform research.fail(403, 'Solo el investigador responsable administra este proyecto.');
  end if;
end $$;

-- Fecha de hoy en México (la base trabaja en UTC; de noche ya sería "mañana").
create or replace function research.today()
returns date language sql stable as $$ select (now() at time zone 'America/Mexico_City')::date $$;

-- Gestiona el plan de trabajo (actividades e hitos): el responsable o un integrante con permiso.
create or replace function research.can_manage(p research.projects, u research.users)
returns boolean language sql stable
set search_path = research, extensions, pg_temp as $$
  select (u.role in ('researcher', 'coordinator') and p.responsible_researcher_id = u.id)
      or exists (select 1 from research.participants t where t.project_id = p.id and t.user_id = u.id and t.is_active = 1 and t.can_manage = 1);
$$;

create or replace function research.project_manager(p research.projects, u research.users)
returns void language plpgsql
set search_path = research, extensions, pg_temp as $$
begin
  if not research.can_manage(p, u) then
    perform research.fail(403, 'Necesitas que el investigador responsable te dé permiso para gestionar el plan de trabajo.');
  end if;
end $$;

create or replace function research.project_active(p research.projects)
returns void language plpgsql
set search_path = research, extensions, pg_temp as $$
begin
  -- "En proceso" y "En cambios" se pueden trabajar; los demás estados son de solo lectura.
  if p.status not in ('active', 'changes') then
    perform research.fail(409, case p.status
      when 'closing' then 'El proyecto tiene una solicitud de cierre pendiente; espera la respuesta de Coordinación.'
      when 'cancelled' then 'El proyecto está cancelado; solo Coordinación puede reabrirlo.'
      else 'El proyecto está completado; solo Coordinación puede reabrirlo.' end);
  end if;
end $$;

create or replace function research.participant_valid(pid integer, uid integer)
returns void language plpgsql
set search_path = research, extensions, pg_temp as $$
begin
  if not exists (select 1 from research.participants t join research.users u on u.id = t.user_id
                 where t.project_id = pid and t.user_id = uid and t.is_active = 1 and u.status = 'active'
                   and u.role in ('student', 'researcher', 'coordinator')) then
    perform research.fail(422, 'Selecciona un participante activo del proyecto.');
  end if;
end $$;

create or replace function research.active_role(uid integer, r text)
returns void language plpgsql
set search_path = research, extensions, pg_temp as $$
begin
  -- "researcher" incluye a Coordinación: también puede ser investigadora responsable.
  perform 1 from research.users where id = uid and status = 'active'
    and (role = r or (r = 'researcher' and role = 'coordinator')) for update;
  if not found then
    perform research.fail(422, case when r = 'researcher' then 'Selecciona una cuenta activa de investigador o de Coordinación.'
                                    else 'Selecciona una cuenta activa con rol ' || lower(research.role_label(r)) || '.' end);
  end if;
end $$;

create or replace function research.event_project(pid integer, actor integer, entity text, eid integer, act text, details jsonb default '{}'::jsonb)
returns void language sql
set search_path = research, extensions, pg_temp as $$
  insert into research.project_history (project_id, actor_id, entity, entity_id, action, details)
  values (pid, actor, entity, eid, act, details::text);
$$;

-- Las fechas son ESTIMADAS: hay 3 días de tolerancia antes de marcar una actividad como retrasada.
create or replace function research.deadline_status(st text, deadline date)
returns text language sql stable
set search_path = research, extensions, pg_temp as $$
  select case when st = 'completed' then 'Completada'
              when st = 'cancelled' then 'Cancelada'
              when deadline is null then 'Sin fecha'
              when deadline < research.today() - 3 then 'Retrasada'
              when deadline < research.today() then 'Fecha pasada'
              when deadline = research.today() then 'Vence hoy'
              when deadline <= research.today() + 3 then 'Próxima a vencer'
              else 'Normal' end;
$$;

-- Fecha del hito: la meta escrita o, si alguna actividad termina después, la fecha más lejana de sus actividades.
create or replace function research.milestone_due(mid integer)
returns date language sql stable
set search_path = research, extensions, pg_temp as $$
  select greatest((select target_date from research.milestones where id = mid),
    (select max(a.deadline) from research.milestone_activities ma join research.activities a on a.id = ma.activity_id
     where ma.milestone_id = mid and a.status <> 'cancelled'));
$$;

-- Un hito se alcanza solo: cuando todas sus actividades (no canceladas) están completadas.
create or replace function research.milestone_status(mid integer)
returns text language sql stable
set search_path = research, extensions, pg_temp as $$
  select case when count(*) > 0 and count(*) filter (where a.status <> 'completed') = 0 then 'achieved' else 'pending' end
  from research.milestone_activities ma join research.activities a on a.id = ma.activity_id
  where ma.milestone_id = mid and a.status <> 'cancelled';
$$;

-- Resumen de un proyecto (para listas, seguimiento y reportes). Las actividades canceladas no cuentan.
-- Color del proyecto: el elegido o, si no hay, uno fijo de la paleta según su número.
create or replace function research.project_color(p research.projects)
returns text language sql immutable
set search_path = research, extensions, pg_temp as $$
  select coalesce(p.color, (array['#2F80ED','#9B51E0','#E2557A','#F2994A','#219653','#00A3A3','#6C63FF','#C27C0E','#3D7EA6','#B5487E'])[(p.id % 10) + 1]);
$$;
create or replace function research.project_color_by_id(pid integer)
returns text language sql stable
set search_path = research, extensions, pg_temp as $$
  select research.project_color(p) from research.projects p where p.id = pid;
$$;

create or replace function research.project_json(p research.projects)
returns jsonb language sql stable
set search_path = research, extensions, pg_temp as $$
  select to_jsonb(p) || jsonb_build_object(
    'researcher_name', (select name from research.users where id = p.responsible_researcher_id),
    'proposal_title', (select title from research.proposals where id = p.proposal_id),
    'color', research.project_color(p),
    'total_activities', (select count(*) from research.activities a where a.project_id = p.id and a.status <> 'cancelled'),
    'completed_activities', (select count(*) from research.activities a where a.project_id = p.id and a.status = 'completed'),
    'overdue_activities', (select count(*) from research.activities a where a.project_id = p.id and a.status not in ('completed','cancelled') and a.deadline < research.today() - 3),
    'total_milestones', (select count(*) from research.milestones m where m.project_id = p.id),
    'achieved_milestones', (select count(*) from research.milestones m where m.project_id = p.id and research.milestone_status(m.id) = 'achieved'),
    'next_milestone', (select jsonb_build_object('description', m.description, 'target_date', research.milestone_due(m.id))
                       from research.milestones m where m.project_id = p.id and research.milestone_status(m.id) = 'pending'
                       order by research.milestone_due(m.id) nulls last limit 1),
    'active_participants', (select count(*) from research.participants t where t.project_id = p.id and t.is_active = 1)
  );
$$;

create or replace function research.project_list(u research.users)
returns jsonb language sql stable
set search_path = research, extensions, pg_temp as $$
  select coalesce(jsonb_agg(research.project_json(p) order by p.id desc), '[]'::jsonb)
  from research.projects p
  where research.project_visible(u, p.id);
$$;
