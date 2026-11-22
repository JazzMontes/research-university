-- =====================================================================
-- Research University · Carga rápida de usuarios de prueba (OPCIONAL)
-- Pega todo en Supabase → SQL Editor → Run.
-- Crea las 10 cuentas con la contraseña temporal  Prueba2026
-- (al entrar, cada persona debe crear su propia contraseña).
-- Si un usuario o correo ya existe, se salta (no duplica ni borra nada).
-- =====================================================================
insert into research.users (name, username, email, password_hash, role, must_change_password)
select v.name, v.username, v.email, research.hash_password('Prueba2026'), v.role, 1
from (values
  ('Diana', 'diana', 'jazz.montes.003+diana@gmail.com', 'student'),
  ('Alejo', 'alejo', 'jazz.montes.003+alejo@gmail.com', 'researcher'),
  ('Emanuel', 'emanuel', 'jazz.montes.003+emanuel@gmail.com', 'student'),
  ('Coordinador 2', 'coordinador2', 'jazz.montes.003+coordinador2@gmail.com', 'coordinator'),
  ('Investigador 2', 'investigador2', 'jazz.montes.003+investigador2@gmail.com', 'researcher'),
  ('Investigador 3', 'investigador3', 'jazz.montes.003+investigador3@gmail.com', 'researcher'),
  ('Estudiante 1', 'estudiante1', 'jazz.montes.003+estudiante1@gmail.com', 'student'),
  ('Estudiante 2', 'estudiante2', 'jazz.montes.003+estudiante2@gmail.com', 'student'),
  ('Estudiante 3', 'estudiante3', 'jazz.montes.003+estudiante3@gmail.com', 'student'),
  ('Estudiante 4', 'estudiante4', 'jazz.montes.003+estudiante4@gmail.com', 'student')
) as v(name, username, email, role)
where not exists (select 1 from research.users x where lower(x.username) = lower(v.username) or lower(x.email) = lower(v.email));

select username, role, email from research.users where email like 'jazz.montes.003+%' order by role, username;
