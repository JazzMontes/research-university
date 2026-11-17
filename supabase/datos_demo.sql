-- =====================================================================
-- URPMP · (OPCIONAL) Cuentas de demostración para probar el flujo completo.
-- Ejecutar DESPUÉS de instalar_todo.sql. Contraseña de todas: Demo2026x
-- ⚠️ Son contraseñas conocidas: desactívalas (Usuarios → Cambiar estado) o
--    bórralas antes de usar la plataforma con datos reales.
-- =====================================================================
insert into research.users (name, username, email, password_hash, role)
select v.name, v.username, null, research.hash_password('Demo2026x'), v.role
from (values
  ('Coordinación (demo)', 'demo.coordinacion', 'coordinator'),
  ('Ana López (estudiante demo)', 'demo.estudiante', 'student'),
  ('Rodrigo Pérez (investigador demo)', 'demo.investigador', 'researcher'),
  ('Laura Ruiz (investigadora demo)', 'demo.investigadora', 'researcher'),
  ('Eva Torres (evaluadora demo)', 'demo.evaluador', 'evaluator')
) as v(name, username, role)
where not exists (select 1 from research.users u where lower(u.username) = v.username);

select username, role from research.users where username like 'demo.%' order by role;
