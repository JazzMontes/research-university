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
  ('Diana', 'diana', 'diana.ejemplo@gmail.com', 'student'),
  ('Alejo', 'alejo', 'alejo.ejemplo@gmail.com', 'researcher'),
  ('Emanuel', 'emanuel', 'emanuel.ejemplo@gmail.com', 'student'),
  ('Coordinador 2', 'coordinador2', 'coordinador2.ejemplo@gmail.com', 'coordinator'),
  ('Investigador 2', 'investigador2', 'investigador2.ejemplo@gmail.com', 'researcher'),
  ('Investigador 3', 'investigador3', 'investigador3.ejemplo@gmail.com', 'researcher'),
  ('Estudiante 1', 'estudiante1', 'estudiante1.ejemplo@gmail.com', 'student'),
  ('Estudiante 2', 'estudiante2', 'estudiante2.ejemplo@gmail.com', 'student'),
  ('Estudiante 3', 'estudiante3', 'estudiante3.ejemplo@gmail.com', 'student'),
  ('Estudiante 4', 'estudiante4', 'estudiante4.ejemplo@gmail.com', 'student')
) as v(name, username, email, role)
where not exists (select 1 from research.users x where lower(x.username) = lower(v.username) or lower(x.email) = lower(v.email));

select username, role, email from research.users where email like '%.ejemplo@gmail.com' order by role, username;
