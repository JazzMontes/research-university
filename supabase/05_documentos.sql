-- =====================================================================
-- URPMP · 05 · Documentos del proyecto, evidencias y fuentes institucionales (versión 3)
-- Eliminar: quien lo subió o el investigador responsable (ya no existe el "bloqueo").
-- Los archivos se guardan dentro de la base (máx. 5 MB) y su texto se divide
-- en fragmentos indexados para el asistente de IA.
-- =====================================================================

create or replace function research.normalize_search(t text)
returns text language sql stable
set search_path = research, extensions, pg_temp as $$
  select lower(extensions.unaccent(coalesce(t, '')));
$$;

-- Divide el texto en fragmentos de ~1500 caracteres (con traslape) y los indexa.
create or replace function research.index_text(doc_id integer, ver integer, doc_title text, body text)
returns integer language plpgsql
set search_path = research, extensions, pg_temp as $$
declare
  total integer; pos integer := 1; piece text; cut integer; n integer := 0; ws integer;
  size constant integer := 1500; overlap constant integer := 150;
begin
  delete from research.document_chunks where document_id = doc_id;
  body := regexp_replace(coalesce(body, ''), E'[\\r\\t\\f\\v ]+', ' ', 'g');
  body := regexp_replace(body, E'\\n\\s*\\n+', E'\n\n', 'g');
  body := btrim(body);
  total := length(body);
  while pos <= total and n < 400 loop
    piece := substr(body, pos, size);
    cut := length(piece);
    if pos + cut <= total then
      -- Corta en el último salto de línea o espacio de la parte final del fragmento.
      ws := greatest(
        length(piece) - coalesce(nullif(strpos(reverse(piece), E'\n'), 0), length(piece) + 1) + 1,
        length(piece) - coalesce(nullif(strpos(reverse(piece), ' '), 0), length(piece) + 1) + 1);
      if ws > size * 0.6 then cut := ws; piece := substr(piece, 1, cut); end if;
    end if;
    n := n + 1;
    insert into research.document_chunks (document_id, version, fragment, content, tsv)
      values (doc_id, ver, n, btrim(piece),
              setweight(to_tsvector('spanish', research.normalize_search(doc_title)), 'A') ||
              to_tsvector('spanish', research.normalize_search(piece)));
    exit when pos + cut > total;
    pos := pos + greatest(cut - overlap, 1);
    -- El siguiente fragmento empieza en una palabra completa.
    ws := strpos(substr(body, pos, 80), ' ');
    if ws > 0 then pos := pos + ws; end if;
  end loop;
  return n;
end $$;

create or replace function research.mime_for(ext text)
returns text language sql immutable as $$
  select case ext
    when 'pdf' then 'application/pdf' when 'txt' then 'text/plain' when 'md' then 'text/markdown'
    when 'csv' then 'text/csv' when 'png' then 'image/png' when 'jpg' then 'image/jpeg' when 'jpeg' then 'image/jpeg'
    when 'docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    when 'xlsx' then 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    when 'pptx' then 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    else 'application/octet-stream' end;
$$;

create or replace function research.save_version(doc_id integer, actor integer, d jsonb)
returns integer language plpgsql
set search_path = research, extensions, pg_temp as $$
declare
  fname text; ext text; raw text; bytes bytea; txt text; ver integer; doc_title text;
begin
  fname := research.req_text(d, 'filename', 255);
  fname := regexp_replace(fname, '^.*[\\/]', '');
  ext := lower(substring(fname from '\.([A-Za-z0-9]+)$'));
  if ext is null or ext not in ('pdf','txt','md','csv','docx','xlsx','pptx','png','jpg','jpeg') then
    perform research.fail(422, 'Formato permitido: PDF, Word (DOCX), Excel (XLSX), PowerPoint (PPTX), TXT, MD, CSV, PNG o JPG.');
  end if;
  raw := d ->> 'file_base64';
  if raw is null or raw = '' then perform research.fail(422, 'Selecciona un archivo.'); end if;
  if length(raw) > 7000000 then perform research.fail(413, 'El archivo supera 5 MB. Comprímelo o divídelo.'); end if;
  begin
    bytes := decode(raw, 'base64');
  exception when others then
    perform research.fail(422, 'El archivo no se pudo leer. Vuelve a seleccionarlo.');
  end;
  if length(bytes) = 0 then perform research.fail(422, 'El archivo está vacío.'); end if;
  if length(bytes) > 5 * 1024 * 1024 then perform research.fail(413, 'El archivo supera 5 MB. Comprímelo o divídelo.'); end if;

  txt := coalesce(d ->> 'text_content', '');
  if txt = '' and ext in ('txt', 'md', 'csv') then
    begin txt := convert_from(bytes, 'UTF8');
    exception when others then txt := convert_from(bytes, 'LATIN1'); end;
  end if;
  txt := left(txt, 300000);

  select coalesce(max(version), 0) + 1 into ver from research.document_versions where document_id = doc_id;
  insert into research.document_versions (document_id, version, filename, mime, size_bytes, note, content, text_content, uploaded_by)
    values (doc_id, ver, fname, research.mime_for(ext), length(bytes), nullif(research.opt_text(d, 'version_note', 2000), ''), bytes, nullif(txt, ''), actor);
  select title into doc_title from research.documents where id = doc_id;
  perform research.index_text(doc_id, ver, doc_title, txt);
  return ver;
end $$;

create or replace function research.document_json(dd research.documents)
returns jsonb language sql stable
set search_path = research, extensions, pg_temp as $$
  select to_jsonb(dd) || coalesce((
    select jsonb_build_object('version', v.version, 'filename', v.filename, 'mime', v.mime, 'size_bytes', v.size_bytes,
      'updated_at', v.created_at, 'uploaded_by_name', x.name, 'indexed', v.text_content is not null and length(v.text_content) > 0)
    from research.document_versions v join research.users x on x.id = v.uploaded_by
    where v.document_id = dd.id order by v.version desc limit 1), '{}'::jsonb)
  || jsonb_build_object('author_name', (select name from research.users where id = dd.created_by),
                        'activity_description', (select description from research.activities where id = dd.activity_id));
$$;

create or replace function research.document_access(u research.users, doc_id integer, do_lock boolean default false)
returns research.documents language plpgsql
set search_path = research, extensions, pg_temp as $$
declare dd research.documents;
begin
  if do_lock then select * into dd from research.documents where id = doc_id and deleted_at is null for update;
  else select * into dd from research.documents where id = doc_id and deleted_at is null; end if;
  if dd.id is null then perform research.fail(404, 'Documento no disponible.'); end if;
  if dd.kind <> 'institutional' then
    perform research.project_access(u, dd.project_id);
    if dd.restricted = 1 and u.role = 'student' then perform research.fail(404, 'Documento no disponible.'); end if;
  end if;
  return dd;
end $$;

create or replace function research.ep_documents(u research.users, module text, act text, d jsonb, is_post boolean)
returns jsonb language plpgsql
set search_path = research, extensions, pg_temp as $$
declare
  institutional boolean := module = 'institutional-documents';
  dd research.documents; p research.projects; a research.activities; pid integer; did integer; aid integer;
  v research.document_versions; ver integer; v_title text; v_flag boolean;
begin
  if act = 'list' then
    if institutional then
      return research.ok(jsonb_build_object('items', (
        select coalesce(jsonb_agg(research.document_json(x) order by x.id desc), '[]')
        from research.documents x where x.kind = 'institutional' and x.deleted_at is null)));
    end if;
    pid := research.req_id(d, 'project_id');
    perform research.project_access(u, pid);
    if module = 'evidence' then aid := research.req_id(d, 'activity_id'); end if;
    return research.ok(jsonb_build_object('items', (
      select coalesce(jsonb_agg(research.document_json(x) order by x.id desc), '[]')
      from research.documents x where x.project_id = pid and x.deleted_at is null
        and (u.role <> 'student' or x.restricted = 0)
        and ((module = 'evidence' and x.kind = 'evidence' and x.activity_id = aid) or (module <> 'evidence' and x.kind = 'project')))));
  end if;

  if act <> 'upload' or research.has(d, 'document_id') then
    dd := research.document_access(u, research.req_id(d, 'document_id'), is_post);
    if (institutional and dd.kind <> 'institutional') or (not institutional and dd.kind = 'institutional') then
      perform research.fail(404, 'Documento no disponible.');
    end if;
  end if;

  if act = 'detail' then
    return research.ok(jsonb_build_object('item', research.document_json(dd)));
  elsif act = 'versions' then
    return research.ok(jsonb_build_object('items', (
      select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'version', x.version, 'filename', x.filename, 'mime', x.mime,
        'size_bytes', x.size_bytes, 'note', x.note, 'uploaded_by', x.uploaded_by, 'uploaded_by_name', us.name, 'created_at', x.created_at,
        'indexed', x.text_content is not null and length(x.text_content) > 0) order by x.version desc), '[]')
      from research.document_versions x join research.users us on us.id = x.uploaded_by where x.document_id = dd.id)));
  elsif act = 'download' then
    if research.has(d, 'version') then
      select * into v from research.document_versions where document_id = dd.id and version = research.req_id(d, 'version');
    else
      select * into v from research.document_versions where document_id = dd.id order by version desc limit 1;
    end if;
    if v.id is null then perform research.fail(404, 'Versión no disponible.'); end if;
    return research.ok(jsonb_build_object('filename', v.filename, 'mime', v.mime,
      'content_base64', replace(encode(v.content, 'base64'), E'\n', '')));
  end if;

  -- Operaciones de escritura
  if institutional then
    if u.role <> 'coordinator' then perform research.fail(403, 'Solo Coordinación administra las fuentes institucionales.'); end if;
    pid := null;
  else
    pid := case when dd.id is not null then dd.project_id else research.req_id(d, 'project_id') end;
    p := research.project_access(u, pid, true);
    perform research.project_active(p);
    -- Solo el equipo del proyecto sube o borra archivos (Coordinación no entra a proyectos ajenos).
    if not exists (select 1 from research.participants t where t.project_id = pid and t.user_id = u.id and t.is_active = 1)
       and p.responsible_researcher_id <> u.id then
      perform research.fail(403, 'Solo los participantes del proyecto administran archivos.');
    end if;
  end if;

  if act in ('upload', 'update', 'upload-version') then
    if dd.id is null then
      if act <> 'upload' then perform research.fail(422, 'Selecciona el documento.'); end if;
      if module = 'evidence' then
        aid := research.req_id(d, 'activity_id');
        select * into a from research.activities where id = aid and project_id = pid for update;
        if a.id is null or a.participant_id <> u.id or a.status not in ('pending', 'changes', 'in_review') then
          perform research.fail(403, 'Solo la persona asignada adjunta evidencias, y solo mientras la actividad no esté cerrada.');
        end if;
        v_title := coalesce(nullif(research.opt_text(d, 'description', 250), ''), research.req_text(d, 'filename', 250));
      else
        v_title := research.req_text(d, 'title', 250);
      end if;
      insert into research.documents (project_id, activity_id, title, kind, created_by)
        values (pid, aid, v_title, case when institutional then 'institutional' when module = 'evidence' then 'evidence' else 'project' end, u.id)
        returning id into did;
    else
      did := dd.id;
      if dd.kind = 'evidence' then perform research.fail(409, 'Las evidencias se conservan tal como se entregaron; adjunta una nueva.'); end if;
      if research.has(d, 'title') then update research.documents set title = research.req_text(d, 'title', 250) where id = did; end if;
    end if;
    if act = 'update' and not research.has(d, 'file_base64') then
      ver := null; -- solo cambió el título
    else
      ver := research.save_version(did, u.id, d);
    end if;
  elsif act = 'delete' then
    did := dd.id;
    if dd.kind = 'evidence' then
      -- Quien adjuntó una evidencia equivocada la puede quitar mientras la actividad no se acepte.
      select * into a from research.activities where id = dd.activity_id;
      if coalesce(dd.created_by, 0) <> u.id then perform research.fail(403, 'Solo quien adjuntó la evidencia puede quitarla.'); end if;
      if a.status in ('completed', 'cancelled') then perform research.fail(409, 'La actividad ya está cerrada; sus evidencias se conservan.'); end if;
    elsif not institutional and coalesce(dd.created_by, 0) <> u.id and p.responsible_researcher_id <> u.id then
      perform research.fail(403, 'Solo quien subió el documento o el investigador responsable pueden eliminarlo.');
    end if;
    update research.documents set deleted_at = now() where id = did;
    delete from research.document_chunks where document_id = did;
  elsif act = 'set-restriction' and not institutional then
    -- "Solo investigadores": los estudiantes del proyecto no lo ven.
    perform research.project_lead(p, u);
    did := dd.id;
    v_flag := research.req_bool(d, 'restricted');
    update research.documents set restricted = v_flag::int where id = did;
  else
    perform research.fail(404, 'Operación no disponible.');
  end if;

  if pid is not null then
    perform research.event_project(pid, u.id, 'document', did, act, jsonb_build_object('title', (select title from research.documents where id = did), 'version', ver));
  end if;
  return research.ok(jsonb_build_object('document_id', did, 'version', ver));
end $$;
