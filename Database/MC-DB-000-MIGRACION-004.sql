-- =====================================================================
-- MC-DB-000 — MIGRACIÓN 004 — Perfil automático y consentimiento
-- Ejecutar UNA vez en Supabase → SQL Editor, DESPUÉS de la migración 003.
-- Es idempotente: si se ejecuta dos veces no rompe nada.
--
-- Decisiones aprobadas por J. Good (2026-10):
--   a. El perfil se crea solo al registrarse; se crean los que falten.
--   b. El consentimiento se captura en el registro (metadatos del formulario)
--      o después, con la función registrar_consentimiento() — cubre el
--      inicio de sesión con Google o Apple, que no pasa por el formulario.
--   c. La Edge Function no enseña sin consentimiento registrado (código 313).
--   d. Cada cambio de consentimiento queda en un historial de solo inserción.
--   e. El análisis voluntario se retira con actualizar_consentimiento_analisis().
--
-- Base legal: Aviso de Privacidad v1.0 de C-Method (finalidad voluntaria
-- con casilla desmarcada; edad mínima 13; de 13 a 17 con autorización del tutor).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Columnas de consentimiento en perfiles (estado actual)
-- ---------------------------------------------------------------------
alter table perfiles add column if not exists declaracion_edad text;
alter table perfiles add column if not exists terminos_aceptados_en timestamptz;
alter table perfiles add column if not exists version_aviso text;
alter table perfiles add column if not exists consentimiento_analisis boolean not null default false;
alter table perfiles add column if not exists consentimiento_analisis_en timestamptz;

alter table perfiles drop constraint if exists perfiles_declaracion_edad_check;
alter table perfiles add constraint perfiles_declaracion_edad_check
  check (declaracion_edad in ('mayor_18', 'menor_13_17_con_tutor'));

comment on column perfiles.declaracion_edad is
  'Declaración de rango de edad (no fecha de nacimiento). NULL = consentimiento pendiente.';
comment on column perfiles.terminos_aceptados_en is
  'Momento (hora del servidor) en que aceptó el Aviso de Privacidad y los Términos.';

-- ---------------------------------------------------------------------
-- 2. Historial de consentimientos (solo inserción: prueba ante la autoridad)
--    Se borra con la cuenta (derecho de cancelación).
-- ---------------------------------------------------------------------
create table if not exists historial_consentimientos (
  id bigint generated always as identity primary key,
  perfil_id uuid not null references perfiles(id) on delete cascade,
  tipo text not null check (tipo in ('registro', 'analisis')),
  origen text not null check (origen in ('formulario_registro', 'app')),
  declaracion_edad text,
  version_aviso text,
  consentimiento_analisis boolean not null,
  creado_en timestamptz not null default now()
);
create index if not exists idx_historial_consentimientos_perfil on historial_consentimientos (perfil_id, creado_en desc);

alter table historial_consentimientos enable row level security;
drop policy if exists "historial_consentimientos_select_own" on historial_consentimientos;
create policy "historial_consentimientos_select_own"
  on historial_consentimientos for select to authenticated
  using (perfil_id = auth.uid());
-- Sin políticas de insert/update/delete: solo escriben las funciones de abajo.

-- ---------------------------------------------------------------------
-- 3. Cerrar el hueco de inserción: el perfil ya no lo crea el cliente.
--    Antes, un usuario podía insertar su propio perfil con un consentimiento
--    inventado. Ahora el perfil lo crea el trigger y el consentimiento solo
--    se registra por función, con la hora del servidor.
-- ---------------------------------------------------------------------
drop policy if exists "perfiles_insert_own" on perfiles;
revoke insert on perfiles from authenticated;

-- ---------------------------------------------------------------------
-- 4. Perfil automático al registrarse (y consentimiento si viene en el formulario)
--    Metadatos esperados en supabase.auth.signUp({ options: { data: {...} } }):
--      declaracion_edad: 'mayor_18' | 'menor_13_17_con_tutor'
--      acepta_terminos: true
--      version_aviso: '1.0'
--      consentimiento_analisis: true | false
--    Si faltan o no son válidos, el perfil se crea igual, con el
--    consentimiento PENDIENTE: el registro nunca falla por esto.
-- ---------------------------------------------------------------------
create or replace function crear_perfil_nuevo_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  edad text := meta->>'declaracion_edad';
  version text := nullif(trim(coalesce(meta->>'version_aviso', '')), '');
  analisis boolean := (meta->>'consentimiento_analisis') = 'true';
  valido boolean := (meta->>'acepta_terminos') = 'true'
                    and edad in ('mayor_18', 'menor_13_17_con_tutor')
                    and version is not null;
begin
  insert into perfiles (id) values (new.id) on conflict (id) do nothing;

  if valido then
    update perfiles
    set declaracion_edad = edad,
        terminos_aceptados_en = now(),
        version_aviso = version,
        consentimiento_analisis = analisis,
        consentimiento_analisis_en = now()
    where id = new.id;

    insert into historial_consentimientos
      (perfil_id, tipo, origen, declaracion_edad, version_aviso, consentimiento_analisis)
    values (new.id, 'registro', 'formulario_registro', edad, version, analisis);
  end if;

  return new;
end $$;

drop trigger if exists trg_crear_perfil_nuevo_usuario on auth.users;
create trigger trg_crear_perfil_nuevo_usuario
  after insert on auth.users
  for each row execute function crear_perfil_nuevo_usuario();

-- Usuarios que ya existían sin perfil (por ejemplo, tu usuario de prueba).
insert into perfiles (id)
select u.id from auth.users u
where not exists (select 1 from perfiles p where p.id = u.id);

-- ---------------------------------------------------------------------
-- 5. Registrar el consentimiento después del registro (o aceptar una
--    versión nueva del aviso). La hora la pone el servidor.
-- ---------------------------------------------------------------------
create or replace function registrar_consentimiento(
  p_declaracion_edad text,
  p_version_aviso text,
  p_consentimiento_analisis boolean
) returns void
language plpgsql security definer set search_path = public as $$
declare
  yo uuid := auth.uid();
begin
  if yo is null then
    raise exception 'MC401: sesión no válida' using errcode = 'P0001';
  end if;
  if p_declaracion_edad is null or p_declaracion_edad not in ('mayor_18', 'menor_13_17_con_tutor') then
    raise exception 'MC306: declaración de edad inválida' using errcode = 'P0001';
  end if;
  if nullif(trim(coalesce(p_version_aviso, '')), '') is null then
    raise exception 'MC306: falta la versión del aviso aceptado' using errcode = 'P0001';
  end if;

  update perfiles
  set declaracion_edad = p_declaracion_edad,
      terminos_aceptados_en = now(),
      version_aviso = trim(p_version_aviso),
      consentimiento_analisis = coalesce(p_consentimiento_analisis, false),
      consentimiento_analisis_en = now()
  where id = yo;
  if not found then
    raise exception 'MC103: perfil inexistente' using errcode = 'P0001';
  end if;

  insert into historial_consentimientos
    (perfil_id, tipo, origen, declaracion_edad, version_aviso, consentimiento_analisis)
  values (yo, 'registro', 'app', p_declaracion_edad, trim(p_version_aviso), coalesce(p_consentimiento_analisis, false));
end $$;

-- ---------------------------------------------------------------------
-- 6. Interruptor del análisis voluntario (dar o retirar el consentimiento)
-- ---------------------------------------------------------------------
create or replace function actualizar_consentimiento_analisis(p_valor boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  yo uuid := auth.uid();
  perfil perfiles%rowtype;
begin
  if yo is null then
    raise exception 'MC401: sesión no válida' using errcode = 'P0001';
  end if;
  select * into perfil from perfiles where id = yo;
  if not found then
    raise exception 'MC103: perfil inexistente' using errcode = 'P0001';
  end if;
  if perfil.terminos_aceptados_en is null then
    raise exception 'MC313: primero debes aceptar el aviso de privacidad y los términos' using errcode = 'P0001';
  end if;

  update perfiles
  set consentimiento_analisis = coalesce(p_valor, false),
      consentimiento_analisis_en = now()
  where id = yo;

  insert into historial_consentimientos
    (perfil_id, tipo, origen, declaracion_edad, version_aviso, consentimiento_analisis)
  values (yo, 'analisis', 'app', perfil.declaracion_edad, perfil.version_aviso, coalesce(p_valor, false));
end $$;

-- Solo usuarios autenticados pueden llamar a las funciones de consentimiento.
revoke execute on function registrar_consentimiento(text, text, boolean) from public, anon;
grant execute on function registrar_consentimiento(text, text, boolean) to authenticated;
revoke execute on function actualizar_consentimiento_analisis(boolean) from public, anon;
grant execute on function actualizar_consentimiento_analisis(boolean) to authenticated;
-- La función del trigger no debe poder llamarse directamente.
revoke execute on function crear_perfil_nuevo_usuario() from public, anon, authenticated;

commit;

-- =====================================================================
-- Verificación (opcional):
-- select id, declaracion_edad, terminos_aceptados_en, consentimiento_analisis from perfiles;
-- =====================================================================
