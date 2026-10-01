-- ============================================================
-- MC-DB-000 — Row Level Security
-- ============================================================
-- Principio de diseño: el alumno puede LEER su propio progreso,
-- pero NUNCA escribir directamente unidad_estado, evidencia,
-- sesion_leccion ni rama_interrumpida desde el frontend/cliente.
-- Esas tablas solo las escribe el backend (Edge Function con
-- service role key, que no pasa por RLS), porque son la
-- implementación real del modelo MC-002 — si el cliente pudiera
-- escribirlas directo, podría falsificar su propio estado de
-- aprendizaje sin pasar por el modelo de 8 pasos.
--
-- v1.1.0: el mismo principio asimétrico se extiende a los modos
-- docente_aprender y docente_crear — los "seguros" (2 horas de
-- lectura, scroll + tiempo mínimo) NO se implementan como lógica
-- RLS: viven en el Edge Function, y las tablas correspondientes
-- simplemente no aceptan escritura directa del cliente para los
-- campos que esos seguros protegen. Es más simple y más robusto
-- que intentar expresar "cuánto tiempo pasó" dentro de una
-- política RLS, que sería más fácil de burlar re-escribiendo la
-- fila completa en un solo UPDATE.
-- v1.1.1: corrección de 3 huecos de seguridad detectados en
-- revisión externa, antes de la primera ejecución en Supabase real:
--   (1) perfiles.rol autoelevable vía insert/update — cerrado con
--       WITH CHECK + GRANT de columna (rol nunca editable por el
--       propio usuario).
--   (2) puntaje_leccion no tenía RLS habilitado en absoluto — un
--       alumno podía leer/escribir puntajes ajenos. Corregido.
--   (3) solicitudes_idioma_update_solo_docente permitía cualquier
--       UPDATE a un docente, no solo el reclamo pendiente→en_proceso
--       — acotado con USING/WITH CHECK de transición + GRANT de
--       columna.
-- ============================================================

-- ---------- perfiles ----------
alter table perfiles enable row level security;

create policy "perfiles_select_own"
  on perfiles for select
  using (id = auth.uid());

-- Solo nombre_visible es editable por el propio usuario. El WITH
-- CHECK no basta por sí solo para proteger `rol` (una política de
-- update no puede "congelar" una columna, solo validar la fila
-- resultante) — el candado real son los GRANT de columna más abajo.
create policy "perfiles_update_own"
  on perfiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- rol SIEMPRE se fuerza a 'alumno' en el insert, sin importar qué
-- mande el cliente en el payload — cierra el hueco de "insertar mi
-- propio perfil ya como admin".
create policy "perfiles_insert_own"
  on perfiles for insert
  with check (id = auth.uid() and rol = 'alumno');

-- Candado real contra auto-elevación: revocar UPDATE de toda la fila
-- y regrant solo sobre las columnas que el propio usuario puede
-- tocar. Aunque alguien mande un UPDATE con rol='admin' en el
-- payload, Postgres lo rechaza ANTES de evaluar la política RLS,
-- porque el rol de base de datos "authenticated" no tiene permiso
-- de escritura sobre la columna rol.
revoke update on perfiles from authenticated;
grant update (nombre_visible) on perfiles to authenticated;
-- El cambio de rol de un perfil (ej. ascender a alumno→docente)
-- queda como operación exclusiva de service role / panel de admin,
-- nunca expuesta a authenticated.

-- ---------- idiomas ----------
-- Catálogo de lectura pública para cualquier usuario autenticado
-- (no contiene datos de ningún alumno en particular).
alter table idiomas enable row level security;

create policy "idiomas_select_all_authenticated"
  on idiomas for select
  using (auth.role() = 'authenticated');

-- ---------- alumno_idioma ----------
alter table alumno_idioma enable row level security;

create policy "alumno_idioma_select_own"
  on alumno_idioma for select
  using (perfil_id = auth.uid());

-- El alumno SÍ puede crear su propia fila (elegir un idioma nuevo
-- es una acción legítima del usuario, no progreso a falsificar).
create policy "alumno_idioma_insert_own"
  on alumno_idioma for insert
  with check (perfil_id = auth.uid());

-- Nada de update/delete para el rol authenticated: si se necesita
-- desactivar un idioma, lo hace el backend con service role.

-- ---------- unidad_estado ----------
alter table unidad_estado enable row level security;

create policy "unidad_estado_select_own"
  on unidad_estado for select
  using (
    alumno_idioma_id in (
      select id from alumno_idioma where perfil_id = auth.uid()
    )
  );

-- Sin políticas de insert/update/delete para authenticated:
-- solo el backend (service role) cambia el estado MC-002.

-- ---------- evidencia ----------
alter table evidencia enable row level security;

create policy "evidencia_select_own"
  on evidencia for select
  using (
    alumno_idioma_id in (
      select id from alumno_idioma where perfil_id = auth.uid()
    )
  );

-- Sin insert directo desde el cliente: aunque "evidencia" es lo
-- que el alumno produce, pasa primero por el backend (que arma
-- el prompt, llama a Claude, y AHÍ inserta la fila con el
-- contenido ya asociado a la etapa/nivel correctos). Insertar
-- directo desde el cliente permitiría evidencia sin contexto de
-- etapa real.

-- ---------- puntaje_leccion ----------
-- FALTABA POR COMPLETO en la versión anterior — corregido.
-- Mismo patrón que unidad_estado: el alumno lee, solo el backend
-- escribe (score_lecon lo calcula la Edge Function, nunca el cliente).
alter table puntaje_leccion enable row level security;

create policy "puntaje_leccion_select_own"
  on puntaje_leccion for select
  using (
    alumno_idioma_id in (
      select id from alumno_idioma where perfil_id = auth.uid()
    )
  );

-- Sin insert/update/delete para authenticated: si esta tabla se
-- pudiera escribir directo, un alumno podría inflar su propio
-- puntaje y manipular el motor de reactivación en su favor.

-- ---------- sesion_leccion ----------
alter table sesion_leccion enable row level security;

create policy "sesion_leccion_select_own"
  on sesion_leccion for select
  using (
    alumno_idioma_id in (
      select id from alumno_idioma where perfil_id = auth.uid()
    )
  );

-- Sin insert/update: la etapa activa la mueve solo el backend,
-- nunca el cliente (evita que el alumno "salte" de etapa).

-- ---------- rama_interrumpida ----------
alter table rama_interrumpida enable row level security;

create policy "rama_interrumpida_select_own"
  on rama_interrumpida for select
  using (
    alumno_idioma_id in (
      select id from alumno_idioma where perfil_id = auth.uid()
    )
  );

-- Sin insert/update: la pila de détour la gestiona MC-009 en el
-- backend, no el cliente.

-- ============================================================
-- Notas de implementación
-- ============================================================
-- 1. El backend (Edge Function) debe usar la SERVICE ROLE KEY,
--    nunca la anon key, para escribir en unidad_estado, evidencia,
--    sesion_leccion y rama_interrumpida — la service role
--    ignora RLS por diseño de Supabase.
-- 2. El frontend (React) usa la anon key + sesión del usuario
--    (auth.uid()) solo para LEER su propio progreso y mostrarlo
--    en la UI (ej. indicador de etapa, historial de evidencia).
-- 3. (Resuelto en v1.1.0) El rol adicional para modo docente ya
--    existe: columna `rol` en perfiles, usada por is_docente() más
--    abajo.
-- 4. Antes de aplicar en producción: correr estas políticas
--    primero en un proyecto Supabase de staging y verificar con
--    un usuario de prueba que NO puede leer filas de otro
--    alumno_idioma_id ni escribir directo en unidad_estado.
-- ============================================================


-- ============================================================
-- v1.1.0 — Modo docente_aprender y docente_crear
-- ============================================================

-- ---------- función auxiliar: ¿el usuario actual es docente? ----------
-- perfiles.rol ya existe desde MC-DB-000 v1.1.0.
create or replace function is_docente()
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from perfiles
    where id = auth.uid() and rol = 'docente'
  );
$$;

-- ---------- solicitudes_idioma ----------
alter table solicitudes_idioma enable row level security;

-- Cualquier autenticado ve el pool completo: los alumnos necesitan
-- saber si su idioma ya fue pedido (evita duplicar solicitudes),
-- y los docentes necesitan verlo para elegir cuál tomar.
create policy "solicitudes_idioma_select_all_authenticated"
  on solicitudes_idioma for select
  using (auth.role() = 'authenticated');

-- Cualquier autenticado puede crear su propia solicitud —pedir un
-- idioma nuevo es una acción legítima del usuario, no progreso a
-- falsificar (mismo principio que alumno_idioma_insert_own).
create policy "solicitudes_idioma_insert_own"
  on solicitudes_idioma for insert
  with check (solicitado_por = auth.uid());

-- Solo un docente puede "reclamar" una solicitud, y SOLO puede
-- moverla de 'pendiente' a 'en_proceso' — no cualquier UPDATE.
-- USING valida la fila ANTES del cambio (debe estar pendiente),
-- WITH CHECK valida la fila DESPUÉS (debe quedar en_proceso). Esto
-- cierra la contradicción señalada: ya no es un UPDATE genérico que
-- un docente pudiera usar para, por ejemplo, marcarla 'completado'
-- por su cuenta — esa transición sigue siendo exclusiva del backend.
create policy "solicitudes_idioma_reclamar"
  on solicitudes_idioma for update
  using (is_docente() and estado = 'pendiente')
  with check (is_docente() and estado = 'en_proceso');

-- Candado adicional a nivel de columna: el docente solo puede tocar
-- `estado` (y su timestamp) al reclamar — no puede reescribir
-- idioma_nombre ni solicitado_por en el mismo UPDATE.
revoke update on solicitudes_idioma from authenticated;
grant update (estado, actualizado_en) on solicitudes_idioma to authenticated;

-- Transiciones a 'completado' y 'rechazada_ya_existe': EXCLUSIVAS
-- del backend con service role (que ignora RLS y los GRANT de
-- columna de authenticated) — ya no hay ambigüedad entre la
-- intención de diseño y la política real.

-- ---------- sesion_creacion_arquitectura ----------
alter table sesion_creacion_arquitectura enable row level security;

create policy "sesion_creacion_select_own"
  on sesion_creacion_arquitectura for select
  using (docente_id = auth.uid());

-- Sin insert/update para authenticated: el avance de etapa_actual y
-- contenido_mostrado_en los escribe el backend, porque de ahí depende
-- el cálculo del seguro de tiempo mínimo — igual que sesion_leccion
-- en modo estudiante.

-- ---------- validacion_etapa_arquitectura ----------
alter table validacion_etapa_arquitectura enable row level security;

create policy "validacion_etapa_select_own"
  on validacion_etapa_arquitectura for select
  using (
    sesion_creacion_id in (
      select id from sesion_creacion_arquitectura where docente_id = auth.uid()
    )
  );

-- Sin insert directo desde el cliente: el botón "Validar este paso"
-- del frontend llama al Edge Function, que verifica scroll_confirmado
-- Y el tiempo mínimo (comparando validado_en contra
-- sesion_creacion_arquitectura.contenido_mostrado_en) ANTES de
-- insertar con service role. Si se permitiera insert directo del
-- cliente, el seguro completo dejaría de tener sentido — el cliente
-- podría mandar { scroll_confirmado: true, validado_en: <lo que sea> }
-- sin haber esperado nada.

-- ---------- sesion_grupo ----------
alter table sesion_grupo enable row level security;

create policy "sesion_grupo_select_own"
  on sesion_grupo for select
  using (docente_id = auth.uid());

-- Crear un grupo nuevo SÍ es una acción directa legítima del docente
-- (elegir idioma + nombrar el grupo no tiene ningún seguro que proteger).
create policy "sesion_grupo_insert_own"
  on sesion_grupo for insert
  with check (docente_id = auth.uid() and is_docente());

-- Sin policy de UPDATE para authenticated: avanzar unidad_actual/
-- etapa_actual requiere que el backend verifique
-- now() - iniciado_unidad_en >= 2h, y solo el backend (service role)
-- puede escribir avanzado_por/avanzado_en/iniciado_unidad_en. Permitir
-- UPDATE directo del cliente —aunque fuera "solo sus propias filas"—
-- dejaría el seguro de 2 horas dependiendo enteramente de que el
-- frontend se porte bien, que es justo lo que se quiso evitar desde
-- el diseño de este modo.

-- ============================================================
-- Notas de implementación — v1.1.0
-- ============================================================
-- 5. is_docente() se marca STABLE (no IMMUTABLE) porque el rol de
--    un perfil puede cambiar entre llamadas dentro de la misma
--    transacción larga — evita que Postgres cachee un resultado
--    obsoleto de forma incorrecta.
-- 6. Ninguna tabla nueva de docente_crear acepta INSERT/UPDATE
--    directo del cliente salvo la creación inicial de la solicitud
--    y el reclamo de un docente — toda la mecánica de los seguros
--    (scroll, tiempo, étape por étape) vive en el Edge Function,
--    exactamente como evidencia/unidad_estado en modo estudiante.
--    Esto es intencional: NO es un pendiente a resolver después,
--    es la decisión de diseño correcta ya tomada.
-- 7. Antes de aplicar en producción: verificar con un docente de
--    prueba que NO puede leer sesion_grupo de otro docente, y que
--    un alumno (rol≠docente) no puede ejecutar
--    solicitudes_idioma_update_solo_docente aunque conozca el id
--    de una solicitud ajena.
-- ============================================================

