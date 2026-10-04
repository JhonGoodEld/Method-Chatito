-- =====================================================================
-- MC-DB-000 — MIGRACIÓN 003 — Borrado de cuenta sin bloqueos ni daños a terceros
-- Ejecutar UNA vez en Supabase → SQL Editor, DESPUÉS de la migración 002.
-- Es idempotente: si se ejecuta dos veces no rompe nada.
--
-- La acción "eliminar_cuenta" borra al usuario de auth.users y la base de
-- datos elimina en cascada todos SUS datos. Esta migración corrige tres
-- problemas comprobados y aplica una decisión (J. Good, 03/10/2026):
--
--   1. BLOQUEO: si un docente validó o avanzó trabajo de OTRO docente, sus
--      referencias impedían borrar su cuenta.
--   2. DAÑO A TERCEROS: si un alumno que pidió un idioma borraba su cuenta,
--      se borraba también el trabajo del docente que creaba esa arquitectura.
--   3. PÉRDIDA DE TRABAJO VALIDADO: si el docente que creaba una arquitectura
--      borraba su cuenta, su sesión y todas sus étapes validadas desaparecían.
--   4. DECISIÓN: el trabajo NO terminado de un docente que se va se conserva
--      anonimizado y su solicitud vuelve a "pendiente" para que otro docente
--      la continúe.
--
-- Regla común: ANONIMIZAR (on delete set null). Se borra lo que es del
-- usuario; lo que pertenece al proyecto o a otros se conserva, sin el dato
-- de quién fue.
--
-- Las lecciones (tabla livrables) no están ligadas a ningún docente: nunca
-- se borran al eliminar una cuenta.
-- =====================================================================

begin;

-- 1. Validaciones de arquitectura: se conservan; el validador queda anónimo.
alter table validacion_etapa_arquitectura alter column validado_por drop not null;
alter table validacion_etapa_arquitectura drop constraint if exists validacion_etapa_arquitectura_validado_por_fkey;
alter table validacion_etapa_arquitectura
  add constraint validacion_etapa_arquitectura_validado_por_fkey
  foreign key (validado_por) references perfiles(id) on delete set null;

-- 2. Sesiones de grupo: se conservan; quien avanzó la unidad queda anónimo.
alter table sesion_grupo drop constraint if exists sesion_grupo_avanzado_por_fkey;
alter table sesion_grupo
  add constraint sesion_grupo_avanzado_por_fkey
  foreign key (avanzado_por) references perfiles(id) on delete set null;

-- 3. Solicitudes de idioma: la solicitud (y el trabajo docente que cuelga de
--    ella) se conserva; quien la pidió queda anónimo.
alter table solicitudes_idioma alter column solicitado_por drop not null;
alter table solicitudes_idioma drop constraint if exists solicitudes_idioma_solicitado_por_fkey;
alter table solicitudes_idioma
  add constraint solicitudes_idioma_solicitado_por_fkey
  foreign key (solicitado_por) references perfiles(id) on delete set null;

-- 4. Sesiones de creación de arquitectura: se conservan (con sus étapes
--    validadas); el docente queda anónimo.
alter table sesion_creacion_arquitectura alter column docente_id drop not null;
alter table sesion_creacion_arquitectura drop constraint if exists sesion_creacion_arquitectura_docente_id_fkey;
alter table sesion_creacion_arquitectura
  add constraint sesion_creacion_arquitectura_docente_id_fkey
  foreign key (docente_id) references perfiles(id) on delete set null;

-- 5. Si una sesión en curso se queda sin docente, su solicitud vuelve a
--    "pendiente" para que otro docente la retome. El nuevo docente continúa
--    la MISMA sesión (solicitud_id es única), conservando lo ya validado.
--    El flujo para retomarla se implementará con el modo docente_crear.
create or replace function liberar_solicitud_sin_docente() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update solicitudes_idioma
  set estado = 'pendiente', actualizado_en = now()
  where id = new.solicitud_id and estado = 'en_proceso';
  return new;
end $$;

drop trigger if exists trg_liberar_solicitud_sin_docente on sesion_creacion_arquitectura;
create trigger trg_liberar_solicitud_sin_docente
  after update of docente_id on sesion_creacion_arquitectura
  for each row
  when (old.docente_id is not null and new.docente_id is null)
  execute function liberar_solicitud_sin_docente();

comment on column solicitudes_idioma.solicitado_por is
  'Alumno que pidió el idioma. NULL si borró su cuenta: la solicitud y el trabajo docente se conservan anonimizados.';
comment on column sesion_creacion_arquitectura.docente_id is
  'Docente a cargo. NULL si borró su cuenta: la sesión se conserva y la solicitud vuelve a "pendiente".';

commit;

-- =====================================================================
-- Verificación (opcional): las cuatro deben mostrar confdeltype = 'n' (set null)
-- select conname, confdeltype from pg_constraint where conname in (
--   'validacion_etapa_arquitectura_validado_por_fkey',
--   'sesion_grupo_avanzado_por_fkey',
--   'solicitudes_idioma_solicitado_por_fkey',
--   'sesion_creacion_arquitectura_docente_id_fkey');
-- =====================================================================
