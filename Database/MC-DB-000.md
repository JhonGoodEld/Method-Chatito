# MC-DB-000 — Esquema de Base de Datos del Agente Método Chatito

**Versión**: 1.1.0 (extendida con los 3 modos de operación tras la piloto FR-411)

**Propósito**: contraparte de datos de `MC-OPERACIONAL.json`. Mientras ese documento declara las reglas, este documenta dónde vive y cómo fluye la información que esas reglas consultan y modifican. Proyecto Supabase **compartido** con Hangulito (misma tabla de autenticación).

**Decisiones de diseño confirmadas**:
- Progreso **independiente por idioma** — un alumno puede estar en distintos estados en coreano, francés, inglés simultáneamente (multi-sesión real).
- Usuarios/autenticación **compartidos** con Hangulito (mismo proyecto Supabase, misma tabla `auth.users`).
- Tres modos de operación (`estudiante`, `docente_aprender`, `docente_crear`) con estructuras de progreso **distintas y no intercambiables** — ver MC-OPERACIONAL.modos_operacion.

**Historial**:
- v1.0.0 — esquema inicial, solo modo `estudiante`.
- v1.1.0 — añadidas `solicitudes_idioma`, `sesion_creacion_arquitectura`, `validacion_etapa_arquitectura`, `sesion_grupo`, `puntaje_leccion`; `evidencia` extendida con `tipo_contenido`/`url_storage`/`diagnosticos` (múltiple); `perfiles` extendido con `rol`.

---

## 1. Tablas

### `auth.users` (ya existe — Supabase Auth, compartida con Hangulito)
No se toca directamente. Es la fuente de identidad para ambas apps.

### `perfiles`
Extensión ligera de `auth.users`, compartida entre Hangulito y el Método Chatito.

| columna | tipo | nota |
|---|---|---|
| `id` | uuid (PK, FK → auth.users.id) | |
| `nombre_visible` | text | |
| `rol` | enum | `alumno` / `docente` / `admin` — **añadido en v1.1.0**, necesario para distinguir qué modos puede usar cada perfil (docente_aprender/docente_crear vs estudiante). Un mismo perfil puede tener rol docente y usar la app como estudiante en otro idioma — el rol habilita modos, no los exclute mutuamente. |
| `creado_en` | timestamptz | |

### `idiomas`
Catálogo maestro de idiomas disponibles. Cada fila apunta a la arquitectura XX-000 correspondiente.

| columna | tipo | nota |
|---|---|---|
| `id` | uuid (PK) | |
| `codigo` | text | ej. `FR`, `KO`, `EN`, `AR` |
| `nombre` | text | ej. "Francés" |
| `version_arquitectura` | text | ej. "v1.0.0" (referencia a XX-000) |
| `activo` | boolean | permite "precargar" un idioma sin exponerlo aún |

### `alumno_idioma`
**La pieza que habilita multi-sesión real.** Une un alumno con un idioma; es la unidad sobre la que cuelga todo el progreso de ESE idioma para ESE alumno.

| columna | tipo | nota |
|---|---|---|
| `id` | uuid (PK) | |
| `perfil_id` | uuid (FK → perfiles.id) | |
| `idioma_id` | uuid (FK → idiomas.id) | |
| `fecha_inicio` | timestamptz | |
| `unico(perfil_id, idioma_id)` | constraint | un alumno no duplica el mismo idioma |
| `restriccion_max_3_activos` | constraint de aplicación | el backend cuenta filas con `idiomas.activo=true` para ese `perfil_id` antes de insertar una 4ª — rechaza la petición antes de tocar la tabla (MC-OPERACIONAL.modos_operacion.estudiante.limite_idiomas). No se modela como constraint SQL nativo por la complejidad de la condición vía join. |

### `unidad_estado`
Estado actual (MC-002) de cada unidad transformacional, por alumno_idioma. **Se sobrescribe** — es el "presente", no el historial.

| columna | tipo | nota |
|---|---|---|
| `id` | uuid (PK) | |
| `alumno_idioma_id` | uuid (FK → alumno_idioma.id) | |
| `unidad_id` | text | ej. `KO-511`, `EN-411` (referencia al livrable declarativo) |
| `estado` | enum | `non_acquis` / `en_cours` / `acquis` / `consolide` |
| `actualizado_en` | timestamptz | |
| `unico(alumno_idioma_id, unidad_id)` | constraint | |

### `evidencia`
Historial **append-only** de producción del alumno. Nunca se actualiza ni se borra una fila — solo se insertan nuevas (o se completan sus campos de corrección/diagnóstico una vez, nunca se sobrescriben después). Es el "Évidence≠État" hecho tabla.

| columna | tipo | nota |
|---|---|---|
| `id` | uuid (PK) | |
| `alumno_idioma_id` | uuid (FK → alumno_idioma.id) | |
| `unidad_id` | text | |
| `etapa_mc001` | int | en qué etapa de las 12 (o 14/15/17) se generó |
| `nivel_ejercicio` | int | 1, 2 o 3 (según MC-001) |
| `tipo_contenido` | enum | **añadido en v1.1.0**: `texto` / `imagen` / `audio` |
| `contenido_alumno` | text | si `tipo_contenido = texto`: el texto tal cual. Si `imagen`/`audio`: el resultado en texto que Claude extrajo la única vez que analizó el archivo (nunca se re-envía el archivo a Claude para "recordarlo"). |
| `url_storage` | text \| null | **añadido en v1.1.0** — referencia al archivo en Supabase Storage (solo si `tipo_contenido ≠ texto`). El archivo NUNCA vive en esta tabla ni se re-procesa. |
| `correccion` | text \| null | se llena en la fase `correction_differee` |
| `diagnosticos` | jsonb \| null | **cambiado de texto único a array en v1.1.0** (piloto FR-411: una misma producción puede tener 2+ causas de error independientes — MC-002 §13, nota de aplicación). Formato: `[{ "causa": "...", "explicacion": "..." }, ...]` |
| `creado_en` | timestamptz | |

### `puntaje_leccion`
**Nueva en v1.1.0.** Guarda `score_lecon` (MC-002 §17bis) una vez que una unidad se da por completada — señal de entrada para `motor_reactivacion`, nunca la evaluación pedagógica en sí (esa queda en `evidencia`/`diagnosticos`, cualitativa).

| columna | tipo | nota |
|---|---|---|
| `id` | uuid (PK) | |
| `alumno_idioma_id` | uuid (FK → alumno_idioma.id) | |
| `unidad_id` | text | |
| `puntaje` | numeric(5,2) | 0-100, fórmula en MC-OPERACIONAL.evidencia_y_estado.puntaje_leccion |
| `calculado_en` | timestamptz | |
| `unico(alumno_idioma_id, unidad_id)` | constraint | se recalcula/sobrescribe si la unidad se reactiva y produce nueva evidencia — a diferencia de `evidencia`, este SÍ es un valor "presente", no historial. |

### `sesion_leccion`
Estado de "dónde va" la lección en curso — el ancla de continuidad entre sesiones distintas del alumno.

| columna | tipo | nota |
|---|---|---|
| `id` | uuid (PK) | |
| `alumno_idioma_id` | uuid (FK → alumno_idioma.id) | |
| `unidad_id` | text | unidad activa en este momento |
| `etapa_actual` | int | etapa MC-001 en curso |
| `fase_correccion` | enum \| null | `collecte_evidence` / `correction_differee` / `diagnostico` (solo si etapa_actual = 17) |
| `actualizado_en` | timestamptz | |

### `rama_interrumpida`
Pila del mecanismo de "détour" de MC-009 — ramas de enseñanza pausadas que deben poder retomarse.

| columna | tipo | nota |
|---|---|---|
| `id` | uuid (PK) | |
| `alumno_idioma_id` | uuid (FK → alumno_idioma.id) | |
| `unidad_id` | text | dónde se interrumpió |
| `motivo` | text | ej. "dificultad persistente detectada" |
| `orden_pila` | int | para saber cuál retomar primero |
| `creado_en` | timestamptz | |

### `solicitudes_idioma`
**Nueva en v1.1.0.** Pool de idiomas pedidos por alumnos (rama "NO" del diagrama de flujo) o propuestos directamente por un docente en modo `docente_crear`.

| columna | tipo | nota |
|---|---|---|
| `id` | uuid (PK) | |
| `solicitado_por` | uuid (FK → perfiles.id) | |
| `idioma_nombre` | text | ej. "Alemán" — texto libre, no FK a `idiomas` porque justamente no existe ahí todavía |
| `estado` | enum | `pendiente` / `en_proceso` / `completado` / `rechazada_ya_existe` |
| `creado_en` | timestamptz | |
| `actualizado_en` | timestamptz | |
| `restriccion_exclusividad` | constraint parcial | solo una fila con `estado = 'en_proceso'` a la vez en toda la tabla (`CREATE UNIQUE INDEX ... WHERE estado = 'en_proceso'`) — evita arquitecturas a medias en paralelo. *Nota de diseño abierta: si en el futuro hay varios docentes trabajando arquitecturas distintas en simultáneo, esta restricción debería escalarse a por-docente en vez de global — no resuelto todavía, well marcado aquí para no perderlo.* |
| `rechazada_ya_existe` | — | se usa cuando el backend detecta que el idioma pedido ya está en `idiomas` (activo o no) — la solicitud NO se cuenta como consumida (MC-OPERACIONAL.modos_operacion.estudiante.limite_idiomas.regla_anti_desperdicio). |

### `sesion_creacion_arquitectura`
**Nueva en v1.1.0.** Estado "dónde va" el proceso de creación de una arquitectura — equivalente de `sesion_leccion` pero para modo `docente_crear`.

| columna | tipo | nota |
|---|---|---|
| `id` | uuid (PK) | |
| `solicitud_id` | uuid (FK → solicitudes_idioma.id) | |
| `docente_id` | uuid (FK → perfiles.id) | |
| `etapa_actual` | int | 1 a 6 (inventaire, points_critiques, recherche, decision, numerotation, redaction — LG-100) |
| `contenido_mostrado_en` | timestamptz | cuándo se presentó el contenido de la etapa actual — ancla para el seguro de tiempo mínimo |
| `actualizado_en` | timestamptz | |

### `validacion_etapa_arquitectura`
**Nueva en v1.1.0.** Historial **append-only** de validaciones por étape — mismo espíritu que `evidencia`: nunca se sobrescribe, cada étape validada queda como registro permanente.

| columna | tipo | nota |
|---|---|---|
| `id` | uuid (PK) | |
| `sesion_creacion_id` | uuid (FK → sesion_creacion_arquitectura.id) | |
| `etapa` | int | 1 a 6 |
| `scroll_confirmado` | boolean | true solo si el centinela `IntersectionObserver` del frontend confirmó ver el final real del contenido |
| `tiempo_mostrado_en` | timestamptz | copiado de `sesion_creacion_arquitectura.contenido_mostrado_en` al momento de esta étape — para que el backend pueda recalcular si pasó el tiempo mínimo, sin confiar en lo que mande el cliente |
| `validado_por` | uuid (FK → perfiles.id) | |
| `validado_en` | timestamptz | el backend RECHAZA el insert si `validado_en - tiempo_mostrado_en` < tiempo mínimo calculado para la extensión de ese contenido — el seguro real vive aquí, no solo en el frontend |

### `sesion_grupo`
**Nueva en v1.1.0.** Progreso de un grupo bajo modo `docente_aprender` — estructura paralela e independiente de `alumno_idioma`, sin `unidad_estado` ni `evidencia` asociados (este modo no genera evidencia, por diseño explícito).

| columna | tipo | nota |
|---|---|---|
| `id` | uuid (PK) | |
| `docente_id` | uuid (FK → perfiles.id) | |
| `idioma_id` | uuid (FK → idiomas.id) | |
| `nombre_grupo` | text | ej. "Grupo A" |
| `unidad_actual` | text | |
| `etapa_actual` | int | 1-12 de MC-001 (14/15/17 no aplican en este modo) |
| `iniciado_unidad_en` | timestamptz | ancla del seguro de 2 horas |
| `avanzado_por` | uuid \| null (FK → perfiles.id) | quién confirmó el último avance — auditoría, no restricción de la decisión discrecional |
| `avanzado_en` | timestamptz \| null | el backend RECHAZA el avance si `now() - iniciado_unidad_en < 2h`, sin importar lo que indique el frontend |
| `estado` | enum | `activo` / `terminado` |
| `restriccion_exclusividad` | regla de aplicación | un `docente_id` puede tener VARIAS filas de `sesion_grupo` simultáneas (distintos grupos); lo que NO puede es tener dos filas **del mismo grupo** con idiomas distintos y estado `activo` a la vez — la exclusividad de "un idioma a la vez" es por grupo, no por docente. |

---

## 2. Flujo típico (una interacción de lección, modo estudiante)

```
1. Alumno abre sesión de KO (alumno_idioma_id ya existe)
        │
2. Agente lee sesion_leccion → sabe en qué unidad y etapa va
        │
3. Agente lee unidad_estado → sabe el estado MC-002 de esa unidad
        │
4. Agente ejecuta la etapa según MC-OPERACIONAL (nunca salta etapas)
        │
5. Alumno produce algo → se INSERTA una fila en evidencia (nunca se sobrescribe)
        │
6. Si etapa_actual = 17 → se corre el modelo de 8 pasos sobre el historial
   de evidencia acumulado (no solo el último intento)
        │
7. Si el modelo de 8 pasos confirma cambio → se ACTUALIZA unidad_estado
        │
8. Se ACTUALIZA sesion_leccion con la nueva etapa/fase
```

## 3. Flujo de secuenciación (MC-009, entre lecciones)

```
Terminó una unidad → agente consulta tabla_canonica_XX-000 (dato externo,
no vive en Supabase, viene de KO-000/FR-000/EN-000)
        │
¿Hay dificultad persistente en un nodo transversal? (se infiere de
evidencia + unidad_estado) → si sí, se prioriza ese nodo
        │
¿Hay una rama_interrumpida pendiente con mayor prioridad? → se retoma
        │
Si no → se elige la siguiente unidad según potentiel_d_expansion
        │
Se crea/actualiza sesion_leccion apuntando a la nueva unidad, etapa 1
```

## 4. Flujo de modo `docente_aprender`

```
Docente abre/crea sesion_grupo (idioma + nombre_grupo)
        │
Agente ejecuta etapas 1-12 de MC-001 (SIN 14/15/17 — sin evidencia)
        │
sesion_grupo.iniciado_unidad_en = now()
        │
Docente evalúa a discreción, EN FÍSICO, fuera del sistema
        │
Docente pide avanzar → backend valida now()-iniciado_unidad_en >= 2h
        │
    ¿cumple?  NO → rechazado, se mantiene la unidad actual
              SÍ → sesion_grupo.unidad_actual avanza,
                   avanzado_por/avanzado_en se registran,
                   iniciado_unidad_en se resetea a now()
```

Nótese la ausencia total de `evidencia`/`unidad_estado` en este flujo — es la diferencia estructural clave frente al modo estudiante, no un detalle menor.

## 5. Flujo de modo `docente_crear`

```
Docente revisa solicitudes_idioma (pool) → elige UNA → estado='en_proceso'
        │ (bloqueado: no puede haber otra fila en_proceso a la vez)
        ▼
Se crea sesion_creacion_arquitectura, etapa_actual=1 (inventaire)
        │
Agente presenta contenido de la étape → contenido_mostrado_en = now()
        │
Docente lee (scroll + tiempo mínimo, verificados en frontend Y backend)
        │
Docente valida → INSERT en validacion_etapa_arquitectura
        │ backend rechaza si tiempo insuficiente, aunque el frontend
        │ ya haya habilitado el botón
        ▼
sesion_creacion_arquitectura.etapa_actual += 1
        │
    ... se repite para las 6 étapes de LG-100 ...
        ▼
Étape 6 (redaction) validada → se genera el XX-000 con
validado_por + fecha_validacion estampados → solicitudes_idioma.estado='completado'
```

---

## 6. Notas de implementación

- `unidad_id` se guarda como **texto libre** (`KO-511`, no una FK a una tabla de unidades) porque las unidades declarativas viven en los documentos XX-X00/arquitectura, no en Supabase — evita duplicar la fuente de verdad declarativa en la base de datos.
- Ninguna tabla aquí reemplaza la tabla canónica XX-000: esa sigue siendo un archivo/dato externo que el agente consulta para decidir secuenciación, no una tabla de Supabase.
- `evidencia` es la tabla que más crece — conviene indexar por `(alumno_idioma_id, unidad_id, creado_en)` desde el inicio.
- Row Level Security (RLS) de Supabase: cada alumno solo debe leer/escribir sus propias filas (`perfil_id = auth.uid()` en cascada vía `alumno_idioma_id`).
- **Pendiente explícito (v1.1.0)**: las políticas RLS ya escritas (`MC-DB-000-RLS.sql`) cubren solo las tablas del modo `estudiante`. Faltan políticas para `solicitudes_idioma`, `sesion_creacion_arquitectura`, `validacion_etapa_arquitectura` y `sesion_grupo` — no generadas todavía, para no adelantar diseño de seguridad sobre modos (`docente_crear` especialmente) que siguen sin probarse.
- `sesion_grupo` y las tablas de `docente_crear` no llevan `unidad_estado`/`evidencia` a propósito — replicar esas tablas para estos modos sería reintroducir el modelo de evidencia que el usuario excluyó explícitamente de `docente_aprender`, y que `docente_crear` nunca tuvo (es generación de arquitectura, no aprendizaje de un alumno).
