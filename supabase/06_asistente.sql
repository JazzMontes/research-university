-- =====================================================================
-- URPMP · 06 · Asistente de IA (diagrama "Funcionamiento - IA asistente")
-- 1 Identifica al usuario y su rol · 2 Determina sus permisos
-- 3 Busca la información (RAG): documentos, descripción del proyecto,
--   actividades, hitos y participantes · 4 Genera respuesta con citas.
--
-- Permisos: Coordinador → cualquier proyecto. Investigador y Estudiante →
-- solo proyectos en los que participan.
-- Todos → fuentes institucionales. Los filtros se aplican ANTES de leer texto.
--
-- assistant/context.php → contexto autorizado (lo usa la función Edge "asistente"
--                         para llamar al modelo de IA).
-- assistant/query.php   → respuesta sin modelo de IA (modo local de respaldo).
-- =====================================================================

create or replace function research.search_terms(q text)
returns text[] language sql stable
set search_path = research, extensions, pg_temp as $$
  select coalesce(array_agg(distinct w), '{}') from (
    select w from regexp_split_to_table(research.normalize_search(q), '[^a-z0-9ñ]+') w
    where length(w) > 2 and w not in (
      'que','cual','cuales','como','cuando','donde','quien','quienes','para','por','con','sin','los','las','del','una','uno','unos','unas',
      'este','esta','estos','estas','ese','esa','eso','esto','son','sus','mis','tus','hay','sobre','entre','tiene','tengo','tienen',
      'dime','muestrame','muestra','quiero','saber','puedes','podrias','favor','dame','cuanto','cuantos','cuantas','todo','todos','todas',
      'resume','resumen','resumir','explica','explicar','localiza','localizar','busca','buscar','informacion','documento','documentos',
      'proyecto','proyectos','dice','decir','mas','muy','ya','tambien','solo','ser','estar','fue','era','han','hace','hacer','algun','alguna'))
  s;
$$;

-- Proyectos que el usuario puede consultar (o el elegido, validando acceso).
create or replace function research.assistant_projects(u research.users, d jsonb)
returns integer[] language plpgsql
set search_path = research, extensions, pg_temp as $$
declare pid integer; ids integer[];
begin
  if research.has(d, 'project_id') then
    pid := research.req_id(d, 'project_id');
    if not research.project_visible(u, pid) then
      perform research.fail(403, 'No tienes acceso a ese proyecto. Solo puedes consultar los proyectos en los que participas.');
    end if;
    return array[pid];
  end if;
  select coalesce(array_agg(p.id order by p.id desc), '{}') into ids
    from research.projects p where research.project_visible(u, p.id);
  return ids;
end $$;

create or replace function research.cut(t text, n integer)
returns text language sql immutable as $$
  select case when t is null then '' when length(t) <= n then t else left(t, n) || '…' end;
$$;

create or replace function research.fmt_date(x date)
returns text language sql immutable as $$ select coalesce(to_char(x, 'DD/MM/YYYY'), 'sin definir'); $$;

create or replace function research.status_label(s text)
returns text language sql immutable as $$
  select case s
    when 'active' then 'En proceso' when 'changes' then 'En cambios' when 'closing' then 'Cierre solicitado'
    when 'finalized' then 'Completado' when 'cancelled' then 'Cancelado'
    when 'pending' then 'Pendiente' when 'in_review' then 'En revisión'
    when 'completed' then 'Completada' when 'achieved' then 'Alcanzado' when 'approved' then 'Aprobada'
    when 'rejected' then 'Rechazada' when 'changes_requested' then 'Cambios solicitados'
    when 'pending_researcher_review' then 'En revisión del investigador' when 'pending_coordinator' then 'En revisión de Coordinación'
    else coalesce(s, '') end;
$$;

-- Texto estructurado de un proyecto (fuente [P<id>]).
create or replace function research.project_context_text(pid integer, me integer)
returns text language sql stable
set search_path = research, extensions, pg_temp as $$
  select format(E'### [P%s] Proyecto: %s\nEstado: %s · Responsable: %s · Inicio: %s · Término: %s · Avance: %s de %s actividades completadas\nDescripción / resumen: %s\nObjetivos: %s\nEquipo: %s\nActividades:\n%s\nHitos:\n%s%s',
    p.id, p.title, research.status_label(p.status), r.name, research.fmt_date(p.start_date), research.fmt_date(p.end_date),
    (select count(*) from research.activities a where a.project_id = p.id and a.status = 'completed'),
    (select count(*) from research.activities a where a.project_id = p.id and a.status <> 'cancelled'),
    research.cut(p.description, 1500), research.cut(p.objectives, 1500),
    coalesce((select string_agg(x.name || ' (' || research.role_label(x.role) || coalesce(', ' || t.project_role, '') || ')', '; ' order by x.name)
              from research.participants t join research.users x on x.id = t.user_id where t.project_id = p.id and t.is_active = 1), 'sin integrantes'),
    coalesce((select string_agg(format('- [A%s] %s — responsable: %s%s — estado: %s — fecha límite: %s (%s)',
                a.id, research.cut(a.description, 300), x.name, case when a.participant_id = me then ' (tú)' else '' end,
                research.status_label(a.status), research.fmt_date(a.deadline), research.deadline_status(a.status, a.deadline)), E'\n' order by a.deadline)
              from (select * from research.activities where project_id = p.id order by deadline limit 40) a
              join research.users x on x.id = a.participant_id), '- (sin actividades registradas)'),
    coalesce((select string_agg(format('- [H%s] %s — fecha objetivo: %s — estado: %s — actividades completadas: %s de %s',
                m.id, research.cut(m.description, 300), research.fmt_date(m.target_date), research.status_label(research.milestone_status(m.id)),
                (select count(*) from research.milestone_activities ma join research.activities a on a.id = ma.activity_id where ma.milestone_id = m.id and a.status = 'completed'),
                (select count(*) from research.milestone_activities ma where ma.milestone_id = m.id)), E'\n' order by m.target_date)
              from (select * from research.milestones where project_id = p.id order by target_date limit 20) m), '- (sin hitos registrados)'),
    coalesce((select format(E'\nÚltima solicitud de cierre: %s%s', research.status_label(c.status),
                coalesce(' — observaciones de Coordinación: ' || nullif(research.cut(c.review_observations, 500), ''), ''))
              from research.closures c where c.project_id = p.id order by c.id desc limit 1), ''))
  from research.projects p join research.users r on r.id = p.responsible_researcher_id where p.id = pid;
$$;

create or replace function research.assistant_context(u research.users, d jsonb)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare
  question text; v_mode text; scope integer[]; chosen integer[]; terms text[]; q tsquery;
  structured text := ''; proposals_text text := ''; fragments jsonb := '[]'; sources jsonb := '[]';
  f record; n integer := 0; max_projects integer;
begin
  question := research.req_text(d, 'question', 2000);
  v_mode := coalesce(nullif(d ->> 'mode', ''), 'ask');
  if v_mode not in ('ask', 'summarize', 'explain', 'locate') then perform research.fail(422, 'Tipo de consulta inválido.'); end if;
  scope := research.assistant_projects(u, d);
  terms := research.search_terms(question);
  if cardinality(terms) > 0 then
    begin
      q := to_tsquery('spanish', (select string_agg(t || ':*', ' | ') from unnest(terms) t));
    exception when others then q := null;
    end;
  end if;

  -- Proyectos que entran como datos estructurados (los más relacionados con la pregunta).
  max_projects := case when cardinality(scope) = 1 then 1 else 5 end;
  select coalesce(array_agg(id), '{}') into chosen from (
    select p.id from research.projects p where p.id = any(scope)
    order by (select count(*) from unnest(terms) t
              where research.normalize_search(p.title || ' ' || coalesce(p.description, '') || ' ' || coalesce(p.objectives, '')) like '%' || t || '%') desc,
             (p.status = 'active') desc, p.id desc
    limit max_projects) s;
  for f in select unnest(chosen) as id loop
    structured := structured || research.project_context_text(f.id, u.id) || E'\n\n';
    sources := sources || jsonb_build_object('reference', 'P' || f.id, 'type', 'project', 'project_id', f.id,
      'title', (select title from research.projects where id = f.id));
  end loop;

  -- Propuestas visibles (estado del flujo de aprobación).
  select coalesce(string_agg(format('- [Propuesta %s] %s — estado: %s%s — autor: %s — investigador responsable: %s%s',
      x.id, x.title, research.status_label(x.status), '',
      au.name, rr.name,
      coalesce(' — última observación: ' || research.cut((select h.details from research.proposal_history h where h.proposal_id = x.id
          and h.details is not null and (h.action like 'review_%' or h.action = 'cancelled') order by h.id desc limit 1), 400), '')), E'\n' order by x.id desc), '')
    into proposals_text
    from (select y.* from research.proposals y
          where research.proposal_visible(u, y)
            and (not research.has(d, 'project_id') or exists (select 1 from research.projects pr where pr.proposal_id = y.id and pr.id = any(scope)))
          order by y.id desc limit 8) x
    join research.users au on au.id = x.author_id join research.users rr on rr.id = x.responsible_researcher_id;

  -- Fragmentos de documentos autorizados (RAG con búsqueda de texto completo).
  for f in
    select c.content, c.fragment, c.version, dd.id as document_id, dd.title, dd.kind, pr.title as project_title,
           case when q is null then 0 else ts_rank_cd(c.tsv, q) end as score
    from research.document_chunks c
    join research.documents dd on dd.id = c.document_id and dd.deleted_at is null
    left join research.projects pr on pr.id = dd.project_id
    where (
            (dd.kind = 'institutional' and not research.has(d, 'project_id'))
            or (dd.kind = 'institutional' and research.has(d, 'project_id') and q is not null)
            or (dd.kind <> 'institutional' and dd.project_id = any(scope) and (dd.restricted = 0 or u.role = 'researcher'))
          )
      and (q is not null and c.tsv @@ q)
    order by score desc, dd.created_at desc, c.fragment
    limit 6
  loop
    n := n + 1;
    fragments := fragments || jsonb_build_object('reference', n::text, 'document_id', f.document_id, 'title', f.title,
      'version', f.version, 'fragment', f.fragment, 'kind', f.kind, 'project_title', f.project_title, 'text', f.content);
  end loop;

  -- Para "resume / explica" sin coincidencias: los documentos más recientes del alcance.
  if n = 0 and (v_mode in ('summarize', 'explain') or research.normalize_search(question) ~ '(ultimo|reciente|reporte|informe|documento|entrevista)') then
    for f in
      select c.content, c.fragment, c.version, dd.id as document_id, dd.title, dd.kind, pr.title as project_title
      from research.documents dd
      join research.document_chunks c on c.document_id = dd.id and c.fragment <= 2
      left join research.projects pr on pr.id = dd.project_id
      where dd.deleted_at is null and dd.kind <> 'institutional' and dd.project_id = any(scope)
        and (dd.restricted = 0 or u.role = 'researcher')
      order by dd.created_at desc, c.fragment limit 4
    loop
      n := n + 1;
      fragments := fragments || jsonb_build_object('reference', n::text, 'document_id', f.document_id, 'title', f.title,
        'version', f.version, 'fragment', f.fragment, 'kind', f.kind, 'project_title', f.project_title, 'text', f.content);
    end loop;
  end if;

  for f in select value from jsonb_array_elements(fragments) loop
    sources := sources || jsonb_build_object('reference', f.value ->> 'reference', 'type', 'document',
      'document_id', (f.value ->> 'document_id')::int, 'title', f.value ->> 'title', 'version', (f.value ->> 'version')::int,
      'fragment', (f.value ->> 'fragment')::int, 'kind', f.value ->> 'kind', 'project_title', f.value ->> 'project_title');
  end loop;

  insert into research.assistant_log (user_id, project_id, question, mode)
    values (u.id, case when research.has(d, 'project_id') then (d ->> 'project_id')::int end, left(question, 2000), v_mode);

  return jsonb_build_object(
    'question', question, 'mode', v_mode, 'today', to_char(current_date, 'DD/MM/YYYY'),
    'user', jsonb_build_object('id', u.id, 'name', u.name, 'role', u.role, 'role_label', research.role_label(u.role)),
    'scope', jsonb_build_object('project_id', case when research.has(d, 'project_id') then (d ->> 'project_id')::int end,
      'project_title', case when research.has(d, 'project_id') then (select title from research.projects where id = (d ->> 'project_id')::int) end,
      'accessible_projects', cardinality(scope), 'included_projects', cardinality(chosen),
      'permission', case u.role when 'coordinator' then 'Coordinación: puede consultar cualquier proyecto del sistema.'
        else research.role_label(u.role) || ': solo los proyectos en los que participa.' end),
    'structured', structured, 'proposals', proposals_text, 'fragments', fragments, 'sources', sources);
end $$;

-- ------------------------------------------------------------------
-- Respuesta local (sin modelo de IA): responde con los datos autorizados.
-- ------------------------------------------------------------------
create or replace function research.assistant_local_answer(u research.users, d jsonb)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare
  ctx jsonb; qn text; scope integer[]; answer text := ''; part text; f jsonb; used jsonb := '[]'; s jsonb;
begin
  ctx := research.assistant_context(u, d);
  qn := research.normalize_search(ctx ->> 'question');
  scope := research.assistant_projects(u, d);

  if qn ~ '(pendiente|tarea|actividad|entrega|tengo que)' and qn !~ 'hito' then
    select string_agg(format('• %s — proyecto «%s» — %s, fecha límite %s (%s) [P%s]', a.description, pr.title, research.status_label(a.status),
             research.fmt_date(a.deadline), research.deadline_status(a.status, a.deadline), pr.id), E'\n' order by a.deadline)
      into part
      from research.activities a join research.projects pr on pr.id = a.project_id
      where a.project_id = any(scope) and a.status not in ('completed', 'cancelled')
        and (u.role = 'coordinator' or a.participant_id = u.id or (qn !~ '(tengo|mis|mias|me toca)' and pr.responsible_researcher_id = u.id));
    answer := answer || case when part is null then 'No hay actividades pendientes en tu alcance.' else
      'Actividades pendientes:' || E'\n' || part end || E'\n\n';
  end if;
  if qn ~ 'hito' then
    select string_agg(format('• %s — proyecto «%s» — fecha objetivo %s — %s [P%s]', m.description, pr.title, research.fmt_date(m.target_date),
             research.status_label(research.milestone_status(m.id)), pr.id), E'\n' order by m.target_date)
      into part
      from research.milestones m join research.projects pr on pr.id = m.project_id where m.project_id = any(scope);
    answer := answer || coalesce('Hitos:' || E'\n' || part, 'No hay hitos registrados en tus proyectos.') || E'\n\n';
  end if;
  if qn ~ '(objetivo|meta|proposito)' then
    select string_agg(format('• Proyecto «%s»: %s [P%s]', pr.title, coalesce(nullif(pr.objectives, ''), 'sin objetivos registrados'), pr.id), E'\n')
      into part from research.projects pr where pr.id = any(scope);
    answer := answer || coalesce('Objetivos:' || E'\n' || part, 'No hay proyectos en tu alcance.') || E'\n\n';
  end if;
  if qn ~ '(participa|equipo|integrante|miembro|quien)' then
    select string_agg(format('• Proyecto «%s»: %s [P%s]', pr.title, (select string_agg(x.name || ' (' || research.role_label(x.role) || coalesce(', ' || t.project_role, '') || ')', '; ')
             from research.participants t join research.users x on x.id = t.user_id where t.project_id = pr.id and t.is_active = 1), pr.id), E'\n')
      into part from research.projects pr where pr.id = any(scope);
    answer := answer || coalesce('Equipo de trabajo:' || E'\n' || part, 'No hay proyectos en tu alcance.') || E'\n\n';
  end if;
  if qn ~ '(avance|progreso|porcentaje)' then
    select string_agg(format('• Proyecto «%s»: %s de %s actividades completadas, %s de %s hitos alcanzados [P%s]', pr.title,
             (select count(*) from research.activities a where a.project_id = pr.id and a.status = 'completed'),
             (select count(*) from research.activities a where a.project_id = pr.id and a.status <> 'cancelled'),
             (select count(*) from research.milestones m where m.project_id = pr.id and research.milestone_status(m.id) = 'achieved'),
             (select count(*) from research.milestones m where m.project_id = pr.id), pr.id), E'\n')
      into part from research.projects pr where pr.id = any(scope);
    answer := answer || coalesce('Avance:' || E'\n' || part, 'No hay proyectos en tu alcance.') || E'\n\n';
  end if;
  if qn ~ 'propuesta' and coalesce(ctx ->> 'proposals', '') <> '' then
    answer := answer || 'Propuestas:' || E'\n' || (ctx ->> 'proposals') || E'\n\n';
  end if;
  if jsonb_array_length(ctx -> 'fragments') > 0 then
    answer := answer || 'En los documentos encontré:' || E'\n';
    for f in select distinct on (value ->> 'document_id') value from jsonb_array_elements(ctx -> 'fragments')
             order by value ->> 'document_id', (value ->> 'reference')::int limit 3 loop
      answer := answer || format(E'• Documento «%s»: «%s» [%s]\n', f ->> 'title', research.cut(regexp_replace(f ->> 'text', '\s+', ' ', 'g'), 450), f ->> 'reference');
    end loop;
  end if;
  if btrim(answer) = '' then
    if coalesce(ctx ->> 'structured', '') <> '' then
      answer := 'No encontré documentos que mencionen esos términos. Esto es lo que hay registrado en tus proyectos:' || E'\n\n' || research.cut(ctx ->> 'structured', 2500);
    else
      answer := 'No encontré esa información en tus proyectos ni en los documentos. Para dudas generales (metodología, redacción, citas, conceptos) el asistente necesita la IA conectada; pide a Coordinación que la configure.';
    end if;
  end if;
  -- Solo se devuelven las fuentes citadas en el texto.
  for s in select value from jsonb_array_elements(ctx -> 'sources') loop
    if position('[' || (s ->> 'reference') || ']' in answer) > 0 then used := used || s; end if;
  end loop;
  return jsonb_build_object('answer', btrim(answer, E' \n'), 'sources', used, 'engine', 'local');
end $$;

create or replace function research.ep_assistant(u research.users, act text, d jsonb)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
begin
  if act = 'context' then return research.ok(research.assistant_context(u, d)); end if;
  if act = 'query' then return research.ok(research.assistant_local_answer(u, d)); end if;
  perform research.fail(404, 'Operación no disponible.');
  return null;
end $$;
