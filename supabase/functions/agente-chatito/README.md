# agente-chatito — Edge Function del Método Chatito

Backend del agente pedagógico. Recibe los mensajes del alumno y ejecuta la lección con el ciclo de 12 étapes de MC-001. Decide qué enseñar con MC-009, registra la evidencia según MC-002 y sugiere reactivaciones según MC-006.

**Lo fijo y lo libre (Principio 8):** el livrable fija lo declarativo, es decir, la regla, sus formas, las excepciones, los errores frecuentes y las formas de evidencia. El agente genera en cada sesión lo procedimental: ejemplos nuevos (al menos 5), explicaciones adaptadas y ejercicios propios. Lo que se corrige es la evidencia del alumno, contrastada con la regla fija.

**Principio de diseño:** el LLM *percibe* (transcribe, cuenta, diagnostica) y el código *decide* (umbrales 80/100, avance de étape, estado de la unidad, secuenciación). El total de ejercicios pedidos lo fija el sistema al registrar la solicitud, así que el agente no puede inflarlo.

Versión de datos: MC-OPERACIONAL v1.5.0 (alineado con MC-001 v1.0.3) · Verificación: `deno check` sin errores · 52 pruebas pasando.

---

## 1. Estructura

| Módulo | Responsabilidad |
|---|---|
| `index.ts` | Entrada HTTP: CORS, JWT, límites, candado, enrutamiento, respuesta uniforme |
| `flujo_estudiante.ts` | Máquina de estados del modo estudiante (orquesta todo lo demás) |
| `secuenciacion.ts` | MC-009 determinista: accesibilidad, potencial, desvíos con pila, desempate |
| `completitud.ts` | Umbral de producción (80 %) y de corrección (100 %) |
| `puntaje.ts` | `score_lecon` acotado (MC-002 §17bis) |
| `reactivacion.ts` | Motor de prioridad de MC-006 §15bis; **solo sugiere**, nunca cambia estados |
| `plan.ts` | Navegación del plan de ejecución leído de MC-OPERACIONAL |
| `prompt.ts` | Prompt en 3 bloques (estático / livrable / turno), con solo las reglas de la tarea del turno |
| `salida_llm.ts` | Contratos JSON del agente (zod) y parser tolerante (errores → 203) |
| `llm_tipos.ts`, `llm_claude.ts`, `llm_openrouter.ts`, `llm_fabrica.ts` | Patrón adapter: cambiar de proveedor = cambiar un secret |
| `datos.ts` | Repositorio (interfaz) + implementación Supabase |
| `redis.ts` | Upstash: rate limit, tope diario global, candado, caché de livrables |
| `registro.ts` | Escritura en `logs_sistema` (nunca rompe la petición) |
| `peticion.ts` | Validación del cuerpo y de las imágenes (incluidos los bytes reales) |
| `cuenta.ts` | Eliminación de la cuenta (derecho de cancelación; requisito de App Store y Google Play). Aislado del flujo. |
| `errores.ts` | Catálogo de códigos |
| `config.ts`, `tipos.ts` | Parámetros de infraestructura y tipos |
| `*.json` | **Copias** de MC-OPERACIONAL y de los grafos (la fuente canónica está en el repo) |
| `pruebas/` | Pruebas (no se despliegan) |
| `herramientas/empaquetar.ts` | Genera el archivo único para el dashboard |

`agente-chatito-DASHBOARD.ts` es el mismo código en un solo archivo, generado automáticamente. **Nunca lo edites a mano:** edita los módulos y vuelve a empaquetar.

---

## 2. Despliegue paso a paso

### Paso 1 — Migración SQL
Supabase → **SQL Editor** → pega el contenido de `MC-DB-000-MIGRACION-002.sql` → **Run**. Es idempotente: si la ejecutas dos veces no pasa nada. Crea `logs_sistema`, `livrables`, las columnas nuevas, los triggers de límites y el bucket privado `evidencias`.

### Paso 2 — Idiomas del catálogo (si aún no existen)
```sql
insert into idiomas (codigo, nombre, activo) values
  ('FR', 'Francés', true), ('EN', 'Inglés', true), ('KO', 'Coreano', true)
on conflict (codigo) do nothing;
```

### Paso 3 — Cargar el primer livrable
El agente **solo enseña lecciones redactadas** (Principio 9). Hoy el francés se bloquearía en FR-400, porque FR-411 no está cargado como livrable. Para la primera prueba, usa EN-411.

Usa `$$ … $$` alrededor del contenido: así los apóstrofos del texto (*l'article*, *don't*) no rompen el SQL.
```sql
insert into livrables (unidad_id, idioma_codigo, dominio_id, sous_domaine_id,
                       titulo, orden_declarado, estado_redaccion, contenido, version)
values ('EN-411', 'EN', 'EN-400', 'EN-410', 'Le pluriel régulier et irrégulier', 1, 'redactado',
$$
(pega aquí el markdown completo de EN-411)
$$, '1.0.0');
```
Declara también las siguientes lecciones del dominio, aunque todavía no tengan texto (`estado_redaccion = 'declarado'`, sin `contenido`). Si EN-400 solo tiene EN-411 declarada, el motor considerará el dominio **agotado** al terminarla y pasará a EN-500.

### Paso 4 — Secrets
Supabase → Edge Functions → **Secrets**:

| Secret | ¿Obligatorio? | Valor |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | automáticos | Los inyecta Supabase. No los crees. |
| `CLAVE_SERVICIO` | solo si falta el anterior | Tu clave secreta (`sb_secret_…`). Supabase no deja crear secrets con prefijo `SUPABASE_`. |
| `LLM_PROVIDER` | **sí** | `openrouter` (ahora) o `claude` (después) |
| `OPENROUTER_API_KEY` | si usas openrouter | Tu key de OpenRouter |
| `ANTHROPIC_API_KEY` | si usas claude | Tu key de Anthropic Console |
| `LLM_MODEL` | no | Por defecto `openrouter/free` o `claude-sonnet-5-5` |
| `OPENROUTER_MODO_JSON` | no | `false` si un modelo fijo rechaza `response_format` |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | recomendados | Sin ellos no hay rate limit, candado ni caché (aviso 501) |
| `ALLOWED_ORIGIN` | recomendado en producción | Tu dominio, p. ej. `https://tu-app.vercel.app` (varios separados por coma). Sin él se acepta cualquier origen. |
| `SITIO_URL` | no | Se envía a OpenRouter como referencia |

### Paso 5 — Desplegar
**Opción A, dashboard:** Edge Functions → Deploy a new function → **Via Editor** → nombre `agente-chatito` → borra la plantilla, pega **todo** `agente-chatito-DASHBOARD.ts` en `index.ts` → **Deploy**.

**Opción B, CLI:** copia la carpeta a `supabase/functions/agente-chatito/` y ejecuta `supabase functions deploy agente-chatito`.

Sobre **"Verify JWT"**: la función verifica el token por sí misma (`auth.getUser`), así que no depende de esa opción. Déjala activada. Si recibes un 401 **sin** `request_id` en el cuerpo, lo rechazó la pasarela antes de llegar a tu código (pasa con las claves nuevas); en ese caso desactiva "Verify JWT with legacy secret".

### Paso 6 — Verificar
Date rol admin y llama al diagnóstico:
```sql
update perfiles set rol = 'admin' where id = '<tu uuid de auth.users>';
```
```js
await supabase.functions.invoke('agente-chatito', { body: { accion: 'diagnostico', probar_llm: true } });
// → { ok, diagnostico: { mc_operacional_version, base_de_datos, redis, proveedor, prueba_llm } }
```
`probar_llm: true` gasta 1 llamada de la cuota diaria.

---

## 3. Uso desde React

```js
async function llamarAgente(body) {
  const { data, error } = await supabase.functions.invoke('agente-chatito', { body });
  if (error) {
    // Con supabase-js, las respuestas no-2xx llegan como error y el cuerpo va en error.context.
    const cuerpo = await error.context?.json?.().catch(() => null);
    throw { codigo: cuerpo?.error?.codigo ?? 599, mensaje: cuerpo?.error?.mensaje, requestId: cuerpo?.request_id };
  }
  return data;
}

await llamarAgente({ modo: 'estudiante', accion: 'continuar', alumno_idioma_id });
await llamarAgente({ modo: 'estudiante', accion: 'responder', alumno_idioma_id, mensaje, imagenes });
```

**Reduce las fotos antes de enviarlas** (máx. 3, 1.5 MB cada una). Además de caber en el límite, cuestan menos tokens:
```js
async function fotoABase64(file, lado = 1600, calidad = 0.8) {
  const img = await createImageBitmap(file);
  const k = Math.min(1, lado / Math.max(img.width, img.height));
  const c = Object.assign(document.createElement('canvas'), { width: img.width * k, height: img.height * k });
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', calidad);
  return { media_type: 'image/jpeg', base64: url.split(',')[1] };
}
```

**Eliminar la cuenta.** Es irreversible. Pide confirmación en la interfaz y envía la frase literal `ELIMINAR`:
```js
const r = await llamarAgente({ accion: 'eliminar_cuenta', confirmacion: 'ELIMINAR' });
if (r.cuenta_eliminada) await supabase.auth.signOut();
```
Se borran las fotos de Storage y el usuario; la base de datos elimina en cascada perfil, idiomas, evidencia, progreso, puntajes, sesiones y solicitudes propias. Los registros técnicos quedan anonimizados, igual que el trabajo de un docente que dependía de una solicitud del alumno (migración 003). Para Google Play, la versión web de la app sirve como enlace de borrado: el usuario inicia sesión y elimina su cuenta.

**Inscripciones directas** (el frontend inserta en `alumno_idioma` / `solicitudes_idioma`): los triggers devuelven errores cuyo `message` contiene `MC301`, `MC303` o `MC304`. Búscalos con `error.message.includes('MC301')`.

**Muestra siempre el `request_id` en los mensajes de error.** Es lo que te permite encontrar el registro exacto cuando alguien reporta un problema.

---

## 4. Contrato

**Respuesta correcta:**
```json
{ "ok": true, "request_id": "…",
  "mensaje_agente": "texto del agente (o null)",
  "mensaje_sistema": "decisión del sistema: umbrales, avance (o null)",
  "resultado": "avanza | requiere_completar | requiere_correccion | correccion_incompleta | unidad_completada",
  "estado": { "unidad_id": "EN-411", "etapa_actual": 15, "paso": "exercices_n1_n2",
              "fase": "esperando_evidencia | esperando_correccion | listo_para_continuar | curriculo_bloqueado | curriculo_completado",
              "niveles": [{ "nivel": 1, "total_pedido": 8, "unidad_medida": "ejercicios", "minimo_requerido": 7 }],
              "errores_pendientes": 3, "bloqueo": { "razon": "leccion_sin_redactar", "unidad_id": "EN-412" } },
  "sugerencia_reactivacion": { "unidad_id": "EN-411", "motivo": "prioridad", "prioridad": 0.62 } }
```

**Respuesta de error:** `{ "ok": false, "request_id": "…", "error": { "codigo": 203, "mensaje": "…" } }`. Los 429/430 incluyen `reintentar_en_seg` y la cabecera `Retry-After`.

**Cuándo mostrar cada botón:** si `fase = listo_para_continuar`, el botón **Continuar**. Si es `esperando_evidencia` o `esperando_correccion`, la caja de respuesta con fotos. Si es `curriculo_bloqueado`, un mensaje de "vuelve pronto" (el siguiente "continuar" reintenta).

**Plan de una unidad** (tomado de `MC-OPERACIONAL.leccion.plan_ejecucion`). Las étapes usan la numeración de MC-001, de la 8 a la 19:
- presentación de las étapes 8–14 junto con la solicitud de los niveaux 1+2 (étape 15);
- niveau 3, production libre (15);
- production écrite (16);
- **correction détaillée (17)**: corrige de una vez todos los errores acumulados en 15 y 16 y exige el 100 %;
- transformation (18), **sin corrección** (MC-001 §18): se exige el 80 % y sus errores quedan solo como evidencia;
- vocabulaire (19), que cierra la unidad.

Mientras se recoge la producción, el agente **no corrige**: MC-001 §17 exige terminar la colecta antes de la corrección diferida.

---

## 5. Códigos de error

| Código | Nombre | HTTP | Qué significa / qué hacer |
|---|---|---|---|
| 101 | DB_LECTURA | 500 | Falló una lectura en Supabase. Mira el `contexto.pg`. |
| 102 | DB_RESTRICCION | 409 | Se violó una restricción (única, check, trigger). |
| 103 | DB_NO_ENCONTRADO | 404 | — |
| 104 | DB_ESCRITURA | 500 | Falló una escritura. La evidencia escrita antes se conserva. |
| 105 | DB_CONFLICTO_CONCURRENCIA | 409 | Dos peticiones a la vez sobre la misma sesión; la segunda se rechaza. |
| 106 | SUPABASE_NO_DISPONIBLE | 503 | Supabase Auth no respondió. **No** es culpa del alumno. |
| 107 | CUENTA_NO_ELIMINADA | 500 | Las fotos ya se borraron, pero falló el borrado del usuario. Basta con reintentar. |
| 201 | LLM_AUTENTICACION | 502 | API key inválida o revocada. Revisa el secret. |
| 202 | LLM_LIMITE_PROVEEDOR | 503 | El proveedor está saturado o limita las peticiones. |
| 203 | LLM_RESPUESTA_MALFORMADA | 502 | El modelo devolvió JSON roto. `contexto.modelo` dice cuál; `contexto.fragmento` muestra 300 caracteres. |
| 204 | LLM_TIEMPO_AGOTADO | 504 | No hubo respuesta en 60 s. |
| 205 | LLM_NO_CONFIGURADO | 500 | `LLM_PROVIDER` falta o es inválido, o falta la key del proveedor. |
| 206 | LLM_ERROR_PROVEEDOR | 502 | Error 5xx o de red del proveedor. |
| 207 | LLM_SIN_CREDITO | 502 | Cuota o crédito agotado (HTTP 402). |
| 301 / 303 / 304 | Límites de idiomas y solicitudes | 409 | Los lanzan los triggers de la BD. |
| 305 | SIN_CONTENIDO_DECLARATIVO | 409 | MC-009 se bloqueó: falta redactar una lección. **Mira `unidad_id` en el registro.** |
| 306 | PETICION_INVALIDA | 400 | El cuerpo no cumple el contrato. |
| 307 | EVIDENCIA_INVALIDA | 400 | Imagen demasiado grande o que no es realmente del tipo declarado. |
| 308 | IDIOMA_SIN_GRAFO | 500 | El idioma no tiene XX-GRAFO empaquetado. |
| 309 | GRAFO_INCONSISTENTE | 500 | Ciclo o prerrequisito inexistente en el grafo o en `livrables.prerequis`. |
| 310 | ACCION_NO_ESPERADA | 409 | Se envió "responder" cuando tocaba "continuar". |
| 311 | PETICION_EN_CURSO | 409 | Doble toque: ya hay una petición del mismo usuario en marcha. |
| 312 | CONFIRMACION_REQUERIDA | 400 | `eliminar_cuenta` sin la frase exacta `ELIMINAR`. No se borró nada. |
| 401 | NO_AUTENTICADO | 401 | JWT ausente o inválido. |
| 403 | SIN_PERMISO | 403 | El `alumno_idioma_id` no es del usuario (o no existe). |
| 429 | LIMITE_USUARIO | 429 | Más de 6 mensajes por minuto. |
| 430 | LIMITE_GLOBAL_DIARIO | 429 | Se alcanzó el tope diario de llamadas a la IA de toda la app (45). |
| 501 | REDIS_NO_DISPONIBLE | — | Aviso: Upstash falta o falla; la app sigue sin protección. |
| 502 | STORAGE_FALLIDO | — | Aviso: la foto no se guardó; la transcripción sí. |
| 503 | MODO_NO_IMPLEMENTADO | 501 | Los modos docente llegan en v1.1. |
| 504 | STORAGE_BORRADO_FALLIDO | 500 | Falló el borrado de fotos. La cuenta sigue intacta; basta con reintentar. |
| 598 | CONFIGURACION_INVALIDA | 500 | Falta un secret, o MC-OPERACIONAL/los grafos son inválidos. |
| 599 | ERROR_INESPERADO | 500 | Bug. El registro incluye el `stack_trace`. |
| 900 | LLM_USO | — | Telemetría: proveedor, modelo real, tokens, latencia. |
| 901 | DECISION_SECUENCIACION | — | Telemetría: cada decisión de MC-009 con su justificación (§23). |
| 902 | CUENTA_ELIMINADA | — | Telemetría anónima: una cuenta se eliminó (solo el número de archivos borrados). |

---

## 5b. Supervisión (SQL Editor)

```sql
-- Errores de las últimas 24 h
select creado_en, codigo, severidad, mensaje, request_id from logs_sistema
where codigo < 900 and creado_en > now() - interval '24 hours' order by creado_en desc;

-- Todo lo ocurrido en una petición concreta (el request_id que te reporta el alumno)
select * from logs_sistema where request_id = '<request_id>' order by id;

-- Uso de la IA por día y modelo real
select date_trunc('day', creado_en) as dia, contexto->>'modelo' as modelo, count(*) as llamadas,
       sum((contexto->'uso'->>'entrada')::int) as tokens_entrada
from logs_sistema where codigo = 900 group by 1, 2 order by 1 desc;

-- Qué lección redactar a continuación: bloqueos de MC-009 agrupados
select contexto->>'idioma' as idioma, contexto->>'unidad_id' as falta, contexto->>'dominio_id' as dominio,
       count(*) as alumnos_bloqueados
from logs_sistema where codigo = 305 group by 1, 2, 3 order by 4 desc;

-- Qué modelos gratuitos devuelven JSON roto
select contexto->>'modelo' as modelo, count(*) from logs_sistema where codigo = 203 group by 1 order by 2 desc;

-- Retención: borrar registros de más de 90 días (declararlo en el aviso de privacidad)
delete from logs_sistema where creado_en < now() - interval '90 days';
```

---

## 6. Caché: qué sí y qué no

- **Sí:** el contenido de los livrables en Upstash (1 h) y la caché de prompt de Claude (bloques de reglas y de livrable).
- **No, nunca:** progreso, sesión, estados ni evidencia. Una sesión cacheada con datos viejos llevaría a una étape equivocada.
- Si editas un livrable, el cambio tarda hasta 1 h en verse (o borra la clave `mc:livrable:<id>` en Upstash).
- La mayor ganancia de velocidad está en el frontend: TanStack Query para lo que el frontend lee directamente con RLS, y la CDN de Vercel para los assets.

---

## 7. Pruebas y empaquetado

```bash
deno test pruebas/                                      # 52 pruebas; no necesitan red ni BD
deno check index.ts                                     # tipos
deno run --allow-read --allow-write herramientas/empaquetar.ts   # → agente-chatito-DASHBOARD.ts
deno check agente-chatito-DASHBOARD.ts
```
`pruebas/flujo_test.ts` reproduce la piloto FR-411 completa con una BD en memoria y un agente con guion.

Si cambias MC-OPERACIONAL o un grafo en el repo, **vuelve a copiarlo aquí** y reempaqueta: la función usa su propia copia.

---

## 8. Límites de v1 y decisiones pendientes

**Pendiente de ratificar** (marcado en MC-OPERACIONAL v1.3.0):
- Política de desempate de MC-009 (contenido disponible → orden de declaración).
- Regla provisional de transición: en_cours al iniciar, acquis al completar; consolidé no es automático.
- Candidatos del motor = acquis + consolide; se evalúa al cierre de cada unidad.
- Agrupación de niveles [1,2] y [3].

**No implementado en v1:**
- Modos docente_aprender y docente_crear (responden 503).
- Producción oral en el niveau 3 (MC-001 §15 la admite; v1 solo acepta texto e imágenes).
- Clasificar cada error como "isolée" o "persistante" en el diagnóstico (MC-001 §17 fase 3): el umbral no está definido en MC-002.
- Conversación espontánea fuera de los pasos.
- Interrupción pedagógica y aceleración (MC-009 §17).
- Aceptar una sugerencia de reactivación.
- Transición a consolidé.
- **Abandonar un idioma**: sin esto un alumno puede quedar atrapado en 3 idiomas. Además está ligado al derecho de cancelación (ARCO).
