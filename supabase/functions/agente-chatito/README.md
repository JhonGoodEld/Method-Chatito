# agente-chatito — Edge Function del Método Chatito

Backend del agente pedagógico. Recibe los mensajes del alumno y ejecuta la lección con el ciclo de 12 étapes de MC-001. Decide qué enseñar con MC-009, registra la evidencia según MC-002 y sugiere reactivaciones según MC-006.

**Lo fijo y lo libre (Principio 8):** el livrable fija lo declarativo, es decir, la regla, sus formas, las excepciones, los errores frecuentes y las formas de evidencia. El agente genera en cada sesión lo procedimental: ejemplos nuevos (al menos 5), explicaciones adaptadas y ejercicios propios. Lo que se corrige es la evidencia del alumno, contrastada con la regla fija.

**Formato de las respuestas del agente:**
- Cada respuesta tiene un contrato (`salida_llm.ts`) con su esquema JSON estricto. Gemini lo impone al modelo (`responseJsonSchema`). Con Claude, el formato se exige por instrucciones y la reparación hace de red de seguridad.
- El prompt incluye un ejemplo concreto de cada formato.
- La presentación llega **por étapes**, una sección por cada una, porque algunos proveedores cortan los textos largos en 4096 caracteres. Se comprueba que no falte ninguna étape, y un texto de exactamente 4096 caracteres dispara una alarma (203 `warning`).
- Los saltos de línea mal escapados (`\n` literal) se normalizan.
- Si una respuesta falla, hay **un** segundo intento, según el tipo de fallo:
  - *cortada* por el límite de tokens → se repite con el doble de espacio. Incluye las respuestas **vacías** por el límite, típicas de modelos que razonan antes de responder; el registro guarda `finish_reason`, tokens y si hubo razonamiento;
  - *ilegible*, sin JSON → se repite desde cero;
  - *contrato*, campos mal → se le devuelve al modelo con los errores, sin reenviar las fotos.
- Los **fallos pasajeros** del proveedor (202 saturado, 204 tiempo agotado, 206 error del proveedor) también tienen **un** segundo intento: se repite la misma petición (con las mismas fotos) usando el **modelo de respaldo** (`gemini-3.5-flash-lite` por defecto). La pausa previa es de 5 s si el proveedor avisó saturación (HTTP 503 "high demand" o 429) y de 1.5 s en los demás casos. Peor caso: 60 s + 5 s + 60 s = 125 s, dentro de los 150 s de Supabase. Los fallos de formato (203) se reparan con el modelo principal, no con el respaldo. Los permanentes (201 clave, 205 y 208 configuración, 207 sin crédito, 430 tope diario) nunca se reintentan. Un código 202/204/206 con severidad `warning` en `logs_sistema` indica un reintento.

**Principio de diseño:** el LLM *percibe* (transcribe, cuenta, diagnostica) y el código *decide* (umbrales 80/100, avance de étape, estado de la unidad, secuenciación). El total de ejercicios pedidos lo fija el sistema al registrar la solicitud, así que el agente no puede inflarlo.

**Formas de evidencia (cambio 13):** en la étape 15 no basta la cantidad. La IA reporta en `condiciones` si se cumple cada condición de contenido que el livrable declara (p. ej. "al menos 2 plurales irregulares") y el código decide: si falta alguna, `requiere_completar` y el alumno añade solo lo necesario. Las étapes 16 y 18 no tienen formas de evidencia: ahí las condiciones se ignoran.

**Texto único (cambio 15):** un paso de un solo nivel medido en palabras (la étape 16) es UN texto: cada entrega es el texto completo y reemplaza a la anterior, y las palabras las cuenta el código sobre la transcripción (`contarPalabras`), no la IA. El aviso dice "Tu texto tiene N palabras; el mínimo es M. Reenvía el texto COMPLETO, ampliado." En `evidencia.metricas.conteo` queda `codigo` o `ia`.

**Retomar (cambio 16):** "continuar" mientras se espera evidencia o corrección repite también el último aviso del sistema (lo que falta), sin llamar a la IA.

**Lista de pendientes (cambio 17):** lo que hay que corregir lo arma el código, completo y numerado ("Pendientes (2): [2] «i mean» · [3] «eties». Reescribe cada uno."): al entrar a la étape 17, tras cada corrección parcial y al retomar con "continuar". La IA explica; el código garantiza que no falte ninguno.

**Errores falsos (cambio 18):** un "error" cuya corrección es idéntica al fragmento (sin contar espacios ni la puntuación de los extremos; las mayúsculas sí cuentan) se descarta antes de guardarse, con un aviso 203 `warning` en `logs_sistema`. El mismo filtro se aplica a errores ya guardados: si una sesión solo tenía pendientes falsos, avanza sola al retomarla.

**Observaciones fuera del alcance (cambio 19):** los errores que no son del objetivo de la lección viajan aparte de los errores a corregir (`observaciones_acumuladas`) y se muestran al entrar a la étape 17 ("Además observé errores de otros temas (no se evalúan ni hay que reescribirlos): «life have been» → «life has been»…"), sin duplicados y como mucho 10. No cuentan para el 100 % y no pasan a la étape 18. Siguen registrados en `evidencia.diagnosticos`.

**Corrección diferida (cambio 20, MC-001 v1.0.4 §7.5):** cada error fuera del alcance lleva su `propietario`, el identificador del grafo que le asigna la tabla de fronteras del livrable. Al entrar a la étape 17 (`alcance.ts`):
- propietario **ya estudiado** (todas sus lecciones declaradas en acquis/consolidé) → se exige aquí, marcado "(tema EN-420)";
- **no estudiado** → se muestra "(se corregirá en EN-510)" y se guarda en `errores_diferidos`; se exige en la étape 17 de la primera lección del propietario (la lección, su sous-domaine o su dominio) y se borra al corregirse;
- **transversal**, sin propietario o inexistente en el grafo → solo observación.
Requiere la migración 005. Sin ella la étape 17 sigue funcionando y todo queda como observación (aviso en `logs_sistema`).

**Consignas (cambio 14):** la étape 16 da solo el tema y la extensión, sin mencionar la regla (MC-001 §16), y no repite las formas de evidencia de la étape 15. Los términos técnicos del livrable (en francés) se traducen al idioma de la interfaz.

Versión de datos: MC-OPERACIONAL v1.7.0 (alineado con MC-001 v1.0.4 y MC-002 v1.2.0) · Verificación: `deno check` sin errores · 107 pruebas pasando.

---

## 1. Estructura

| Módulo | Responsabilidad |
|---|---|
| `index.ts` | Entrada HTTP: CORS, JWT, límites, candado, enrutamiento, respuesta uniforme |
| `flujo_estudiante.ts` | Máquina de estados del modo estudiante (orquesta todo lo demás) |
| `secuenciacion.ts` | MC-009 determinista: accesibilidad, potencial, desvíos con pila, desempate |
| `completitud.ts` | Umbral de producción (80 %) y de corrección (100 %) |
| `alcance.ts` | Errores fuera del alcance: propietario y tratamiento (MC-001 §7.5) |
| `puntaje.ts` | `score_lecon` acotado (MC-002 §17bis) |
| `reactivacion.ts` | Motor de prioridad de MC-006 §15bis; **solo sugiere**, nunca cambia estados |
| `plan.ts` | Navegación del plan de ejecución leído de MC-OPERACIONAL |
| `prompt.ts` | Prompt en 3 bloques (estático / livrable / turno), con solo las reglas de la tarea del turno |
| `salida_llm.ts` | Contratos JSON del agente (zod) y parser tolerante (errores → 203) |
| `llm_tipos.ts`, `llm_gemini.ts`, `llm_claude.ts`, `llm_fabrica.ts` | Patrón adapter: Gemini para pruebas, Claude para producción. Cambiar de proveedor = cambiar un secret. |
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

Después, en orden y una sola vez cada una: `MIGRACION-003` (borrado de cuentas), `MIGRACION-004` (consentimiento) y `MIGRACION-005` (tabla `errores_diferidos` y contenido de EN-411 v1.0.1). Todas son idempotentes.

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
| `LLM_PROVIDER` | **sí** | `gemini` (solo pruebas del desarrollador) o `claude` (producción). Ver el aviso de abajo. |
| `GEMINI_API_KEY` | si usas gemini | Tu key de Google AI Studio (aistudio.google.com → Get API key) |
| `ANTHROPIC_API_KEY` | si usas claude | Tu key de Anthropic Console |
| `LLM_MODEL` | no | Por defecto `gemini-3.8-flash` o `claude-sonnet-5-5`. Un solo modelo para texto y fotos. |
| `LLM_MODEL_RESPALDO` | no | Modelo del segundo intento tras saturación o tiempo agotado. Por defecto `gemini-3.5-flash-lite` con Gemini; con Claude no hay respaldo salvo que lo definas. `ninguno` lo desactiva. Mismo proveedor y misma clave. |
| `LLM_LIMITE_DIARIO` | no | Tope de llamadas a la IA por día para toda la app (por defecto 200). Ajústalo a tu límite real de AI Studio. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | recomendados | Sin ellos no hay rate limit, candado ni caché (aviso 501) |
| `ALLOWED_ORIGIN` | recomendado en producción | Tu dominio, p. ej. `https://tu-app.vercel.app` (varios separados por coma). Sin él se acepta cualquier origen. |

> **⚠ Gemini es solo para pruebas del desarrollador.** Los términos de la API de Gemini exigen 18 años o más y prohíben usarla en apps dirigidas a menores o con probabilidad de ser usadas por ellos, y el plan gratuito usa los datos para mejorar los productos de Google. C-Method admite alumnos de 13 a 17 años y su Aviso de Privacidad nombra a Anthropic. **Antes de abrir la app a alumnos: `LLM_PROVIDER = claude`.** El diagnóstico muestra este aviso mientras Gemini esté activo.

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

**Registro y consentimiento** (migración 004). El perfil lo crea la base de datos al registrarse. El consentimiento se envía en el propio registro:
```js
await supabase.auth.signUp({ email, password, options: { data: {
  declaracion_edad: 'mayor_18',          // o 'menor_13_17_con_tutor'; si es menor de 13, no se registra
  acepta_terminos: true,
  version_aviso: '1.0',
  consentimiento_analisis: false,        // casilla voluntaria, desmarcada por defecto
} } });
```
Si el usuario entra con Google o Apple, o el consentimiento no llegó en el registro, se registra después con `supabase.rpc('registrar_consentimiento', { p_declaracion_edad, p_version_aviso, p_consentimiento_analisis })`. Mientras no exista, la función responde **313** en «continuar» y «responder». El interruptor de análisis de la configuración llama a `supabase.rpc('actualizar_consentimiento_analisis', { p_valor })`. Cada cambio queda en `historial_consentimientos`.

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
  "secciones": [{ "etapa": 8, "titulo": "Description grammaticale", "texto": "…" }],
  "estado": { "unidad_id": "EN-411", "etapa_actual": 15, "enunciado": "Nivel 1: …", "paso": "exercices_n1_n2",
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
| 203 | LLM_RESPUESTA_MALFORMADA | 502 | El modelo devolvió una respuesta fuera de formato **dos veces**: antes de fallar, la función le reenvía sus errores y le pide corregirla, una sola vez. Con severidad `warning`, el 203 indica una reparación intentada; con `error`, que también falló. `contexto.modelo` dice qué modelo fue y `contexto.fragmento` muestra 300 caracteres. |
| 204 | LLM_TIEMPO_AGOTADO | 504 | No hubo respuesta en 60 s. |
| 205 | LLM_NO_CONFIGURADO | 500 | `LLM_PROVIDER` falta o es inválido, o falta la key del proveedor. |
| 206 | LLM_ERROR_PROVEEDOR | 502 | Error 5xx o de red del proveedor. |
| 207 | LLM_SIN_CREDITO | 502 | Cuota o crédito agotado (HTTP 402). |
| 208 | LLM_MODELO_NO_DISPONIBLE | 502 | **Configuración, no se reintenta.** HTTP 404 (el modelo no existe: revisa `LLM_MODEL` o `LLM_MODEL_RESPALDO`; el registro dice cuál) o 400 (el proveedor rechazó la forma de la petición, por ejemplo el esquema). |
| 301 / 303 / 304 | Límites de idiomas y solicitudes | 409 | Los lanzan los triggers de la BD. |
| 305 | SIN_CONTENIDO_DECLARATIVO | 409 | MC-009 se bloqueó: falta redactar una lección. **Mira `unidad_id` en el registro.** |
| 306 | PETICION_INVALIDA | 400 | El cuerpo no cumple el contrato. |
| 307 | EVIDENCIA_INVALIDA | 400 | Imagen demasiado grande o que no es realmente del tipo declarado. |
| 308 | IDIOMA_SIN_GRAFO | 500 | El idioma no tiene XX-GRAFO empaquetado. |
| 309 | GRAFO_INCONSISTENTE | 500 | Ciclo o prerrequisito inexistente en el grafo o en `livrables.prerequis`. |
| 310 | ACCION_NO_ESPERADA | 409 | Se envió "responder" cuando tocaba "continuar". |
| 311 | PETICION_EN_CURSO | 409 | Doble toque: ya hay una petición del mismo usuario en marcha. |
| 312 | CONFIRMACION_REQUERIDA | 400 | `eliminar_cuenta` sin la frase exacta `ELIMINAR`. No se borró nada. |
| 313 | CONSENTIMIENTO_PENDIENTE | 403 | El usuario no ha aceptado el aviso y los términos. El frontend debe mostrar la pantalla de consentimiento. |
| 401 | NO_AUTENTICADO | 401 | JWT ausente o inválido. |
| 403 | SIN_PERMISO | 403 | El `alumno_idioma_id` no es del usuario (o no existe). |
| 429 | LIMITE_USUARIO | 429 | Más de 6 mensajes por minuto. |
| 430 | LIMITE_GLOBAL_DIARIO | 429 | Se alcanzó el tope diario de llamadas a la IA de toda la app (`LLM_LIMITE_DIARIO`, por defecto 200). |
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
deno test pruebas/                                      # 107 pruebas; no necesitan red ni BD
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
