-- ============================================================
-- MC-DB-000 — Esquema real (DDL)
-- ============================================================
-- Cómo usar este archivo:
-- 1. Entra a tu proyecto en supabase.com
-- 2. Ve al panel "SQL Editor" (menú lateral izquierdo)
-- 3. Pega TODO este archivo y dale "Run"
-- 4. Después de esto, aplica MC-DB-000-RLS.sql de la misma forma
--    (primero las tablas, después la seguridad — en ese orden)
-- ============================================================

-- Extensión necesaria para generar UUIDs automáticamente
create extension if not exists "pgcrypto";

-- ============================================================
-- MODO ESTUDIANTE (y compartidas con todos los modos)
-- ============================================================

create table perfiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre_visible text,
  rol text not null default 'alumno' check (rol in ('alumno', 'docente', 'admin')),
  creado_en timestamptz not null default now()
);

create table idiomas (
  id uuid primary key default gen_random_uuid(),
  codigo text not null unique,           -- 'FR', 'KO', 'EN', 'AR'...
  nombre text not null,                  -- 'Francés'
  version_arquitectura text,             -- 'v1.1.0'
  activo boolean not null default false  -- permite precargar sin exponer
);

create table alumno_idioma (
  id uuid primary key default gen_random_uuid(),
  perfil_id uuid not null references perfiles(id) on delete cascade,
  idioma_id uuid not null references idiomas(id) on delete restrict,
  fecha_inicio timestamptz not null default now(),
  unique (perfil_id, idioma_id)
);

create table unidad_estado (
  id uuid primary key default gen_random_uuid(),
  alumno_idioma_id uuid not null references alumno_idioma(id) on delete cascade,
  unidad_id text not null,               -- 'FR-411', texto libre (ver notas)
  estado text not null default 'non_acquis'
    check (estado in ('non_acquis', 'en_cours', 'acquis', 'consolide')),
  actualizado_en timestamptz not null default now(),
  unique (alumno_idioma_id, unidad_id)
);

create table evidencia (
  id uuid primary key default gen_random_uuid(),
  alumno_idioma_id uuid not null references alumno_idioma(id) on delete cascade,
  unidad_id text not null,
  etapa_mc001 int not null,
  nivel_ejercicio int,                            -- 1, 2 o 3; null si no aplica
  tipo_contenido text not null default 'texto'
    check (tipo_contenido in ('texto', 'imagen', 'audio')),
  contenido_alumno text,                          -- texto, o resultado extraído de imagen/audio
  url_storage text,                               -- referencia a Supabase Storage, si aplica
  correccion text,
  diagnosticos jsonb,                             -- [{ "causa": "...", "explicacion": "..." }, ...]
  creado_en timestamptz not null default now()
);

create index idx_evidencia_alumno_unidad_fecha
  on evidencia (alumno_idioma_id, unidad_id, creado_en);

create table puntaje_leccion (
  id uuid primary key default gen_random_uuid(),
  alumno_idioma_id uuid not null references alumno_idioma(id) on delete cascade,
  unidad_id text not null,
  puntaje numeric(5,2) not null check (puntaje >= 0 and puntaje <= 100),
  calculado_en timestamptz not null default now(),
  unique (alumno_idioma_id, unidad_id)
);

create table sesion_leccion (
  id uuid primary key default gen_random_uuid(),
  alumno_idioma_id uuid not null references alumno_idioma(id) on delete cascade,
  unidad_id text not null,
  etapa_actual int not null default 1,
  fase_correccion text
    check (fase_correccion in ('collecte_evidence', 'correction_differee', 'diagnostic')),
  actualizado_en timestamptz not null default now(),
  unique (alumno_idioma_id)  -- una sola "unidad activa" por alumno_idioma a la vez
);

create table rama_interrumpida (
  id uuid primary key default gen_random_uuid(),
  alumno_idioma_id uuid not null references alumno_idioma(id) on delete cascade,
  unidad_id text not null,
  motivo text,
  orden_pila int not null default 0,
  creado_en timestamptz not null default now()
);

-- ============================================================
-- MODO DOCENTE_CREAR
-- ============================================================

create table solicitudes_idioma (
  id uuid primary key default gen_random_uuid(),
  solicitado_por uuid not null references perfiles(id) on delete cascade,
  idioma_nombre text not null,
  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'en_proceso', 'completado', 'rechazada_ya_existe')),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

-- Solo puede existir UNA solicitud 'en_proceso' en todo el sistema a la vez
create unique index solicitudes_idioma_una_en_proceso
  on solicitudes_idioma ((estado))
  where estado = 'en_proceso';

create table sesion_creacion_arquitectura (
  id uuid primary key default gen_random_uuid(),
  solicitud_id uuid not null references solicitudes_idioma(id) on delete cascade,
  docente_id uuid not null references perfiles(id) on delete cascade,
  etapa_actual int not null default 1 check (etapa_actual between 1 and 6),
  contenido_mostrado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (solicitud_id)
);

create table validacion_etapa_arquitectura (
  id uuid primary key default gen_random_uuid(),
  sesion_creacion_id uuid not null references sesion_creacion_arquitectura(id) on delete cascade,
  etapa int not null check (etapa between 1 and 6),
  scroll_confirmado boolean not null default false,
  tiempo_mostrado_en timestamptz not null,
  validado_por uuid not null references perfiles(id),
  validado_en timestamptz not null default now()
);

-- ============================================================
-- MODO DOCENTE_APRENDER
-- ============================================================

create table sesion_grupo (
  id uuid primary key default gen_random_uuid(),
  docente_id uuid not null references perfiles(id) on delete cascade,
  idioma_id uuid not null references idiomas(id) on delete restrict,
  nombre_grupo text not null,
  unidad_actual text,
  etapa_actual int not null default 1,
  iniciado_unidad_en timestamptz not null default now(),
  avanzado_por uuid references perfiles(id),
  avanzado_en timestamptz,
  estado text not null default 'activo' check (estado in ('activo', 'terminado'))
);

-- ============================================================
-- Notas de implementación
-- ============================================================
-- - Ejecuta este archivo UNA sola vez. Si necesitas cambiar algo
--   después, se hace con "ALTER TABLE", nunca corriendo este
--   archivo dos veces (fallaría porque las tablas ya existen).
-- - Ningún "ON DELETE CASCADE" aquí borra evidencia por accidente
--   salvo que se borre el alumno_idioma completo (ej. el alumno
--   abandona ese idioma) — la evidencia sigue ligada a esa unidad
--   de progreso, no se vuelve huérfana.
-- - idiomas usa "on delete restrict": no se puede borrar un idioma
--   del catálogo si ya hay alumnos o grupos usándolo — obliga a
--   desactivarlo (activo=false) en vez de eliminarlo.
-- ============================================================
