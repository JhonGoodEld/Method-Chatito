-- =====================================================================
-- MC-DB-000 — MIGRACIÓN 002 — Requisitos de la Edge Function agente-chatito v1
-- Ejecutar UNA vez en Supabase → SQL Editor, DESPUÉS de SCHEMA y RLS v1.1.1.
-- Es idempotente: si se ejecuta dos veces no rompe nada.
-- =====================================================================

create extension if not exists unaccent with schema extensions;

-- ---------------------------------------------------------------------
-- 1. logs_sistema — supervisión técnica (códigos 1xx–5xx y telemetría 9xx)
--    usuario_id se pone en NULL si el usuario borra su cuenta (derechos ARCO):
--    el registro técnico sobrevive, anonimizado.
-- ---------------------------------------------------------------------
create table if not exists logs_sistema (
  id bigint generated always as identity primary key,
  request_id uuid not null,
  usuario_id uuid references auth.users(id) on delete set null,
  codigo int not null,
  severidad text not null check (severidad in ('info', 'warning', 'error', 'critico')),
  mensaje text,
  contexto jsonb not null default '{}',
  stack_trace text,
  duracion_ms int,
  creado_en timestamptz not null default now()
);
create index if not exists idx_logs_fecha on logs_sistema (creado_en desc);
create index if not exists idx_logs_codigo_fecha on logs_sistema (codigo, creado_en desc);
create index if not exists idx_logs_request on logs_sistema (request_id);

alter table logs_sistema enable row level security;
-- SIN políticas a propósito: ningún usuario (ni autenticado) lee ni escribe.
-- Solo la Edge Function (service role) y tú desde el dashboard.

-- ---------------------------------------------------------------------
-- 2. livrables — lecciones declaradas + su contenido redactado
--    Principio 9: el agente EJECUTA un documento; no inventa la lección.
--    'declarado' = existe en la arquitectura, aún sin texto.
--    'redactado' = tiene contenido y puede enseñarse.
-- ---------------------------------------------------------------------
create table if not exists livrables (
  unidad_id text primary key,                         -- 'EN-411'
  idioma_codigo text not null references idiomas(codigo) on update cascade,
  dominio_id text not null,                           -- 'EN-400' (debe existir en XX-GRAFO)
  sous_domaine_id text,                               -- 'EN-410'
  titulo text not null,
  orden_declarado int not null default 1,             -- orden dentro del sous-domaine (MC-009 §21)
  prerequis text[] not null default '{}',             -- ids de lecciones o dominios
  estado_redaccion text not null default 'declarado'
    check (estado_redaccion in ('declarado', 'redactado')),
  contenido text,                                     -- el markdown completo del livrable
  version text,
  actualizado_en timestamptz not null default now(),
  constraint livrable_redactado_con_contenido
    check (estado_redaccion = 'declarado' or (contenido is not null and length(trim(contenido)) > 0))
);
create index if not exists idx_livrables_idioma_dominio on livrables (idioma_codigo, dominio_id);

alter table livrables enable row level security;
drop policy if exists "livrables_select_redactados" on livrables;
create policy "livrables_select_redactados"
  on livrables for select to authenticated
  using (estado_redaccion = 'redactado');
-- Escritura: solo tú desde el dashboard (o service role). Sin políticas de insert/update.

-- ---------------------------------------------------------------------
-- 3. Columnas nuevas
-- ---------------------------------------------------------------------
alter table sesion_leccion add column if not exists requisitos_etapa jsonb not null default '{}';
alter table evidencia add column if not exists metricas jsonb;

comment on column evidencia.etapa_mc001 is
  'Número de étape de MC-001 (8–19, igual a su número de sección): 15 ejercicios, 16 producción escrita, 17 corrección, 18 transformación.';
comment on column rama_interrumpida.unidad_id is
  'Nodo pausado de la pila de MC-009 (§14). En v1 guarda el id del DOMINIO pausado.';

-- ---------------------------------------------------------------------
-- 4. Triggers que CIERRAN un hueco: la política alumno_idioma_insert_own
--    permite insertar desde el frontend, saltándose el límite de 3 idiomas
--    que solo se validaba "en el backend". Lo mismo con solicitudes_idioma.
--    Ahora la regla vive en la base de datos: se cumple venga de donde venga.
--    pg_advisory_xact_lock evita que dos inserciones simultáneas burlen el conteo.
-- ---------------------------------------------------------------------
create or replace function verificar_limite_idiomas() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform pg_advisory_xact_lock(hashtext('alumno_idioma:' || new.perfil_id::text));
  if (select count(*) from alumno_idioma where perfil_id = new.perfil_id) >= 3 then
    raise exception 'MC301: límite de 3 idiomas en curso alcanzado' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists trg_limite_idiomas on alumno_idioma;
create trigger trg_limite_idiomas
  before insert on alumno_idioma
  for each row execute function verificar_limite_idiomas();

create or replace function verificar_solicitud_idioma() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  pedido text := lower(extensions.unaccent(trim(new.idioma_nombre)));
begin
  perform pg_advisory_xact_lock(hashtext('solicitud:' || new.solicitado_por::text));
  -- Anti-desperdicio: si el idioma ya existe, la solicitud NO se consume.
  if exists (
    select 1 from idiomas
    where lower(extensions.unaccent(nombre)) = pedido or lower(codigo) = pedido
  ) then
    raise exception 'MC304: ese idioma ya existe en el catálogo' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from solicitudes_idioma
    where solicitado_por = new.solicitado_por and estado in ('pendiente', 'en_proceso')
  ) then
    raise exception 'MC303: ya tienes una solicitud de idioma en espera' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists trg_solicitud_idioma on solicitudes_idioma;
create trigger trg_solicitud_idioma
  before insert on solicitudes_idioma
  for each row execute function verificar_solicitud_idioma();

-- ---------------------------------------------------------------------
-- 5. Storage: bucket PRIVADO para las fotos de evidencia
--    Ruta: <usuario>/<alumno_idioma>/<unidad>/<request_id>_<n>.<ext>
--    Solo la Edge Function sube. Cada usuario puede VER solo su carpeta.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('evidencias', 'evidencias', false, 1572864, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "evidencias_select_propias" on storage.objects;
create policy "evidencias_select_propias"
  on storage.objects for select to authenticated
  using (bucket_id = 'evidencias' and (storage.foldername(name))[1] = auth.uid()::text);

-- =====================================================================
-- Verificación rápida (opcional): debe devolver 2 filas con 'livrables' y 'logs_sistema'
-- select tablename, rowsecurity from pg_tables
-- where schemaname = 'public' and tablename in ('livrables', 'logs_sistema');
-- =====================================================================
