import { assert, assertAlmostEquals, assertEquals, assertRejects } from "./afirmar.ts";
import { GRAFOS, MC } from "../config.ts";
import { ErrorApp } from "../errores.ts";
import { type ContextoFlujo, manejarEstudiante } from "../flujo_estudiante.ts";
import { RegistradorConsola } from "../registro.ts";
import { AuxiliaresFalsos, Cortada, FalloProveedor, leccion, LLMFalso, PRESENTACION, RepositorioMemoria, secc } from "./dobles.ts";

const USUARIO = "usuario-1";
const AI = "11111111-1111-4111-8111-111111111111";
const LIVRABLE = "# FR-411 — Genre des noms\nRègle : le genre est lexical…";

function montar(guion: unknown[]) {
  const repo = new RepositorioMemoria();
  repo.alumnos.set(AI, { id: AI, perfil_id: USUARIO, idioma_codigo: "FR" });
  repo.lecciones.push(
    { ...leccion("FR-411", "FR-400", "FR-410", 1), titulo: "Genre des noms", idioma: "FR", contenido: LIVRABLE },
    { ...leccion("FR-412", "FR-400", "FR-410", 2), titulo: "Nombre des noms", idioma: "FR", contenido: "# FR-412" },
  );
  const llm = new LLMFalso(guion);
  const registro = new RegistradorConsola();
  const auxiliares = new AuxiliaresFalsos();
  const ctx: ContextoFlujo = {
    repo, registro, auxiliares, obtenerLLM: () => llm, mc: MC, grafos: GRAFOS, usuarioId: USUARIO,
    requestId: "req-1", ahora: () => new Date("2026-09-28T12:00:00Z"), aleatorio: () => 0.99,
    fallarAbiertoSiRedisCae: true, pausa: () => Promise.resolve(),
  };
  const continuar = () => manejarEstudiante(ctx, { accion: "continuar", alumno_idioma_id: AI });
  const responder = (mensaje: string) => manejarEstudiante(ctx, { accion: "responder", alumno_idioma_id: AI, mensaje });
  return { repo, llm, registro, auxiliares, ctx, continuar, responder };
}

const eva = (niveles: unknown[], errores: unknown[] = []) => ({
  mensaje_para_alumno: "retroalimentación", transcripcion: "transcripción", niveles, errores,
});
/** Una transcripción de n palabras (el código cuenta las palabras de la étape 16 — cambio 15). */
const texto = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const err = (fragmento: string, nivel: number | null, fuera = false, rel: string | null = null) => ({
  fragmento, correccion: "forma correcta", causa: "connaissance_partielle", explicacion: "porque…",
  fuera_de_scope: fuera, unidad_relacionada: rel, nivel,
});

Deno.test("piloto FR-411 según MC-001 v1.0.3: corrección diferida en étape 17, étape 18 sin corrección, cierre", async () => {
  const sol = (enunciado: string, niveles: unknown[]) => ({ mensaje_para_alumno: enunciado, solicitud: { enunciado, niveles } });
  const t = montar([
    /* 1 */ { secciones: PRESENTACION, ...sol("Étapes 8–14 … Ejercicios niveles 1 y 2", [{ nivel: 1, total_pedido: 8, unidad_medida: "ejercicios" }, { nivel: 2, total_pedido: 4, unidad_medida: "ejercicios" }]) },
    /* 2 */ eva([{ nivel: 1, total_entregado: 8, items_evaluados: 8, items_correctos: 8 }, { nivel: 2, total_entregado: 2, items_evaluados: 2, items_correctos: 0 }]),
    /* 3 */ eva(
      [{ nivel: 1, total_entregado: 8, items_evaluados: 8, items_correctos: 8 }, { nivel: 2, total_entregado: 4, items_evaluados: 4, items_correctos: 1 }],
      [err("un maison", 2), err("le table", 2), err("une livre", 2), err("il a allé", 2, true)],
    ),
    /* 4 */ sol("Niveau 3 — production libre", [{ nivel: 3, total_pedido: 5, unidad_medida: "frases" }]),
    /* 5 */ eva([{ nivel: 3, total_entregado: 5, items_evaluados: 5, items_correctos: 4 }], [err("la problème", 3)]),
    /* 6 */ sol("Production écrite", [{ nivel: null, total_pedido: 100, unidad_medida: "palabras" }]),
    /* 7 */ { ...eva([{ nivel: null, total_entregado: 110, items_evaluados: 10, items_correctos: 10 }]), transcripcion: texto(110) },
    /* 8 */ { mensaje_para_alumno: "Correction détaillée: 1) un maison → une maison…" },
    /* 9 */ { mensaje_para_alumno: "Bien, faltan dos.", transcripcion: "…", indices_corregidos: [0, 1] },
    /* 10 */ { mensaje_para_alumno: "¡Todo corregido!", transcripcion: "…", indices_corregidos: [2, 3] },
    /* 11 */ sol("Transformation", [{ nivel: null, total_pedido: 5, unidad_medida: "ejercicios" }]),
    /* 12 */ eva([{ nivel: null, total_entregado: 5, items_evaluados: 5, items_correctos: 4 }], [err("elle était allé", null)]),
    /* 13 */ { mensaje_para_alumno: "Vocabulaire…", secciones: secc([19]), solicitud: null },
  ]);

  // Turno 1 — MC-009 elige FR-411; étapes 8–14 + solicitud de la étape 15.
  let r = await t.continuar();
  assertEquals([r.estado.unidad_id, r.estado.etapa_actual, r.estado.fase], ["FR-411", 15, "esperando_evidencia"]);
  assertEquals(r.estado.niveles?.map((n) => n.minimo_requerido), [7, 4]);
  assertEquals(t.repo.sesiones.get(AI)?.fase_correccion, "collecte_evidence");
  const dinamico1 = t.llm.peticiones[0].sistema.dinamico;
  assert(dinamico1.includes("étape 14") && dinamico1.includes("étape 15") && dinamico1.includes("Phrases"));
  assert(t.llm.peticiones[0].sistema.contexto.includes(LIVRABLE));

  // Turno 2 — incompleto: se guarda la evidencia, sin diagnóstico.
  r = await t.responder("mis respuestas");
  assertEquals(r.resultado, "requiere_completar");
  assert(t.repo.evidencias.every((e) => e.diagnosticos === null));

  // Turno 3 — completo CON errores: NO se corrige todavía (MC-001 §17), se avanza al nivel 3.
  r = await t.responder("las que faltaban");
  assert(t.llm.peticiones[2].sistema.dinamico.includes("DIFERIDA"));
  assertEquals(r.resultado, "avanza");
  assertEquals(r.estado.paso, "exercices_n3");
  assertEquals(t.repo.sesiones.get(AI)?.requisitos_etapa.errores_acumulados?.length, 3, "el error fuera de alcance no se acumula");
  await assertRejects(() => t.responder("hola"), ErrorApp, "310");

  // Nivel 3 (libre) con 1 error más; recargar no gasta llamada.
  await t.continuar();
  const llamadas = t.llm.peticiones.length;
  r = await t.continuar();
  assertEquals(t.llm.peticiones.length, llamadas);
  r = await t.responder("mis 5 frases");
  assertEquals(r.estado.paso, "production_ecrite");
  assertEquals(t.repo.sesiones.get(AI)?.requisitos_etapa.errores_acumulados?.length, 4);

  // Producción escrita sin errores → paso de corrección.
  await t.continuar();
  r = await t.responder("mi texto");
  assertEquals(r.estado.paso, "correction");

  // Étape 17 — corrección de TODO lo acumulado (4 errores de 3 pasos).
  r = await t.continuar();
  assertEquals([r.estado.etapa_actual, r.estado.fase, r.estado.errores_pendientes], [17, "esperando_correccion", 4]);
  assertEquals(t.repo.sesiones.get(AI)?.fase_correccion, "correction_differee");
  const corregir = t.llm.peticiones.at(-1)!.sistema.dinamico;
  assert(corregir.includes("TAREA: corregir") && corregir.includes("la problème") && corregir.includes("un maison"));
  r = await t.responder("corrijo dos");
  assertEquals([r.resultado, r.estado.errores_pendientes], ["correccion_incompleta", 2]);
  r = await t.responder("corrijo el resto");
  assertEquals([r.resultado, r.estado.paso], ["avanza", "transformation"]);
  assertEquals(t.repo.evidencias.filter((e) => e.metricas.intento === "correccion").every((e) => e.etapa_mc001 === 17), true);

  // Étape 18 — transformación: NO se corrige (MC-001 §18); el error queda solo como evidencia.
  await t.continuar();
  assert(t.llm.peticiones.at(-1)!.sistema.dinamico.includes("étape 14 del livrable"));
  r = await t.responder("transformaciones");
  assert(t.llm.peticiones.at(-1)!.sistema.dinamico.includes("NO se corrige (MC-001 §18)"));
  assertEquals([r.resultado, r.estado.paso], ["avanza", "vocabulaire"]);
  const evTransf = t.repo.evidencias.filter((e) => e.metricas.paso === "transformation");
  assertEquals(evTransf.length, 1);
  assertEquals(evTransf[0].diagnosticos?.[0].fragmento, "elle était allé", "el error se registra como evidencia");
  assertEquals(t.repo.evidencias.filter((e) => e.metricas.paso === "transformation" && e.metricas.intento === "correccion").length, 0);

  // Étape 19 — cierre: acquis, puntaje, FR-412.
  r = await t.continuar();
  assertEquals(r.resultado, "unidad_completada");
  assertEquals(t.repo.estados.get(`${AI}|FR-411`)?.estado, "acquis");
  assertEquals([r.estado.unidad_id, r.estado.fase], ["FR-412", "listo_para_continuar"]);
  // guiada: niveles 1–2 (8+1)/(8+4) y transformación 4/5 → 13/17 ; libre: nivel 3 4/5 y producción 10/10 → 14/15
  assertAlmostEquals(t.repo.puntajes.get(`${AI}|FR-411`)!, 100 * (0.6 * (14 / 15) + 0.4 * (13 / 17)), 0.01);
  assertEquals(t.llm.peticiones.length, 13, "una llamada al LLM por turno que la necesita");
  assert(t.registro.eventos.some((e) => e.codigo === 901));
});

Deno.test("étape 17 sin errores acumulados: se salta sola y entrega la transformación en la misma petición", async () => {
  const t = montar([
    { mensaje_para_alumno: "x", secciones: PRESENTACION, solicitud: { enunciado: "e", niveles: [
      { nivel: 1, total_pedido: 2, unidad_medida: "ejercicios" }, { nivel: 2, total_pedido: 2, unidad_medida: "ejercicios" },
    ] } },
    { mensaje_para_alumno: "Transformation", solicitud: { enunciado: "t", niveles: [{ nivel: null, total_pedido: 3, unidad_medida: "ejercicios" }] } },
  ]);
  await t.continuar();
  const s = t.repo.sesiones.get(AI)!;
  t.repo.sesiones.set(AI, { ...s, requisitos_etapa: { paso: "correction", estado_paso: "pendiente_presentar" } });
  const r = await t.continuar();
  assertEquals([r.estado.paso, r.estado.etapa_actual, r.estado.fase], ["transformation", 18, "esperando_evidencia"]);
  assert(r.mensaje_sistema!.startsWith("Étape 17: no hubo errores"));
  assertEquals(t.llm.peticiones.length, 2);
});

Deno.test("seguridad: el alumno_idioma de otro usuario da 403 y no toca nada", async () => {
  const t = montar([]);
  t.ctx.usuarioId = "intruso";
  const e = await assertRejects(() => t.continuar(), ErrorApp);
  assertEquals(e.codigo, 403);
  assertEquals(t.repo.sesiones.size, 0);
});

Deno.test("responder sin sesión → 310", async () => {
  const t = montar([]);
  assertEquals((await assertRejects(() => t.responder("hola"), ErrorApp)).codigo, 310);
});

Deno.test("tope diario global: 430 y el LLM no se llama", async () => {
  const t = montar([{ mensaje_para_alumno: "x", solicitud: null }]);
  t.auxiliares.limiteAgotado = true;
  assertEquals((await assertRejects(() => t.continuar(), ErrorApp)).codigo, 430);
  assertEquals(t.llm.peticiones.length, 0);
});

Deno.test("respuesta basura dos veces → reparación fallida: 203 y la sesión no avanza", async () => {
  const t = montar(["Lo siento, no puedo ayudar con eso.", "Sigo sin poder."]);
  assertEquals((await assertRejects(() => t.continuar(), ErrorApp)).codigo, 203);
  assertEquals(t.llm.peticiones.length, 2, "un intento + una reparación, nunca más");
  assertEquals(t.repo.sesiones.get(AI)?.requisitos_etapa.estado_paso, "pendiente_presentar");
});

Deno.test("mejora B: el caso real del 203 (falta total_pedido) se repara solo en el segundo intento", async () => {
  const sinTotal = { mensaje_para_alumno: "Présentation…", secciones: PRESENTACION, solicitud: { enunciado: "e", niveles: [
    { nivel: 1, cantidad: 8, unidad_medida: "ejercicios" }, { nivel: 2, cantidad: 4, unidad_medida: "ejercicios" },
  ] } };
  const corregida = { mensaje_para_alumno: "Présentation…", secciones: PRESENTACION, solicitud: { enunciado: "e", niveles: [
    { nivel: 1, total_pedido: 8, unidad_medida: "ejercicios" }, { nivel: 2, total_pedido: 4, unidad_medida: "ejercicios" },
  ] } };
  const t = montar([sinTotal, corregida]);
  const r = await t.continuar();
  assertEquals([r.estado.fase, r.estado.etapa_actual], ["esperando_evidencia", 15]);
  assertEquals(t.llm.peticiones.length, 2);
  const [primera, segunda] = t.llm.peticiones;
  assertEquals(primera.formato?.nombre, "solicitud", "mejora A: el esquema viaja con la petición");
  assertEquals(primera.historial, undefined);
  assertEquals(segunda.historial?.[0].rol, "assistant");
  assertEquals(segunda.historial?.[0].texto, JSON.stringify(sinTotal), "el modelo recibe su propia respuesta");
  assert(segunda.historial![1].texto.includes("total_pedido"), "y el error exacto a corregir");
  assert(t.registro.eventos.some((e) => e.codigo === 203 && e.severidad === "warning"), "la reparación queda registrada");
});

Deno.test("mejora B: la reparación no reenvía las fotos (ya fueron analizadas)", async () => {
  const sol = { mensaje_para_alumno: "x", secciones: PRESENTACION, solicitud: { enunciado: "e", niveles: [
    { nivel: 1, total_pedido: 2, unidad_medida: "ejercicios" }, { nivel: 2, total_pedido: 2, unidad_medida: "ejercicios" },
  ] } };
  const buena = eva([{ nivel: 1, total_entregado: 2, items_evaluados: 2, items_correctos: 2 }, { nivel: 2, total_entregado: 2, items_evaluados: 2, items_correctos: 2 }]);
  const t = montar([sol, { mensaje_para_alumno: "sin transcripción ni niveles" }, buena]);
  await t.continuar();
  const jpeg = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3));
  const r = await manejarEstudiante(t.ctx, { accion: "responder", alumno_idioma_id: AI, imagenes: [{ mediaType: "image/jpeg", base64: jpeg }] });
  assertEquals(r.resultado, "avanza");
  assertEquals(t.llm.peticiones[1].imagenes.length, 1);
  assertEquals(t.llm.peticiones[2].imagenes.length, 0);
  assert(t.llm.peticiones[2].mensajeUsuario.includes("ya las analizaste"));
});

Deno.test("Redis caído: se sigue funcionando (fallo abierto) y queda registrado 501", async () => {
  const t = montar([{ mensaje_para_alumno: "x", secciones: PRESENTACION, solicitud: {
    enunciado: "e", niveles: [{ nivel: 1, total_pedido: 8, unidad_medida: "ejercicios" }, { nivel: 2, total_pedido: 4, unidad_medida: "ejercicios" }],
  } }]);
  t.auxiliares.romper = true;
  const r = await t.continuar();
  assertEquals(r.estado.fase, "esperando_evidencia");
  assert(t.registro.eventos.some((e) => e.codigo === 501));
});

Deno.test("Storage caído: la evidencia (transcripción) se guarda igual y se registra 502", async () => {
  const t = montar([
    { mensaje_para_alumno: "x", secciones: PRESENTACION, solicitud: { enunciado: "e", niveles: [
      { nivel: 1, total_pedido: 2, unidad_medida: "ejercicios" }, { nivel: 2, total_pedido: 2, unidad_medida: "ejercicios" },
    ] } },
    eva([{ nivel: 1, total_entregado: 2, items_evaluados: 2, items_correctos: 2 }, { nivel: 2, total_entregado: 2, items_evaluados: 2, items_correctos: 2 }]),
  ]);
  await t.continuar();
  t.repo.fallarSubida = true;
  const jpeg = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3));
  const r = await manejarEstudiante(t.ctx, {
    accion: "responder", alumno_idioma_id: AI, imagenes: [{ mediaType: "image/jpeg", base64: jpeg }],
  });
  assertEquals(r.resultado, "avanza");
  assertEquals(t.repo.evidencias.length, 2);
  assertEquals(t.repo.evidencias[0].url_storage, null);
  assert(t.repo.evidencias[0].contenido_alumno.includes("transcripción"));
  assert(t.registro.eventos.some((e) => e.codigo === 502));
});

Deno.test("sin contenido redactado: bloqueo registrado (305) y desbloqueo al redactarlo", async () => {
  const t = montar([]);
  t.repo.lecciones = [{ ...leccion("FR-411", "FR-400", "FR-410", 1, { estado_redaccion: "declarado" }), idioma: "FR", contenido: null }];
  let r = await t.continuar();
  assertEquals(r.estado.fase, "curriculo_bloqueado");
  assertEquals(r.estado.bloqueo?.unidad_id, "FR-411");
  assert(t.registro.eventos.some((e) => e.codigo === 305));

  t.repo.lecciones[0] = { ...t.repo.lecciones[0], estado_redaccion: "redactado", contenido: LIVRABLE };
  const llm = new LLMFalso([{ mensaje_para_alumno: "Présentation", secciones: PRESENTACION, solicitud: {
    enunciado: "e", niveles: [{ nivel: 1, total_pedido: 8, unidad_medida: "ejercicios" }, { nivel: 2, total_pedido: 4, unidad_medida: "ejercicios" }],
  } }]);
  t.ctx.obtenerLLM = () => llm;
  r = await t.continuar();
  assertEquals(r.estado.unidad_id, "FR-411");
  assertEquals(r.estado.fase, "esperando_evidencia");
});

Deno.test("consentimiento pendiente → 313: no se crea sesión ni se llama a la IA", async () => {
  const t = montar([{ mensaje_para_alumno: "x", solicitud: null }]);
  t.repo.sinConsentimiento.add(USUARIO);
  assertEquals((await assertRejects(() => t.continuar(), ErrorApp)).codigo, 313);
  assertEquals((await assertRejects(() => t.responder("hola"), ErrorApp)).codigo, 313);
  assertEquals([t.repo.sesiones.size, t.llm.peticiones.length, t.repo.evidencias.length], [0, 0, 0]);
});

// ---------- Cambios 1, 2, 3 y 5 ----------
const SOLICITUD_12 = { enunciado: "Nivel 1:\\n1. box\\n2. child", niveles: [
  { nivel: 1, total_pedido: 8, unidad_medida: "ejercicios" }, { nivel: 2, total_pedido: 4, unidad_medida: "ejercicios" },
] };

Deno.test("cambios 1 y 2: saltos de línea escapados normalizados y ejercicios visibles en el estado", async () => {
  const t = montar([{ mensaje_para_alumno: "Evidencia:\\nnivel 1…", secciones: secc([8, 9, 10, 11, 12, 13, 14]).map((x) => ({ ...x, texto: "Línea A\\nLínea B" })), solicitud: SOLICITUD_12 }]);
  const r = await t.continuar();
  assert(!r.mensaje_agente!.includes("\\n"), "no quedan «\\n» literales");
  assert(r.mensaje_agente!.includes("Línea A\nLínea B"), "hay saltos de línea reales");
  assertEquals(r.estado.enunciado, "Nivel 1:\n1. box\n2. child", "cambio 2: los ejercicios viajan en el estado");
});

Deno.test("cambio 5: la presentación llega por étapes, en orden, y se compone en un texto", async () => {
  const desordenadas = [...PRESENTACION].reverse();
  const t = montar([{ mensaje_para_alumno: "Formas de evidencia…", secciones: desordenadas, solicitud: SOLICITUD_12 }]);
  const r = await t.continuar();
  assertEquals(r.secciones?.map((x) => x.etapa), [8, 9, 10, 11, 12, 13, 14]);
  assert(r.mensaje_agente!.startsWith("## Étape 8"));
  assert(r.mensaje_agente!.trimEnd().endsWith("Formas de evidencia…"));
  assert(t.llm.peticiones[0].sistema.dinamico.includes("SIN omitir ninguna: 8, 9, 10, 11, 12, 13, 14"));
});

Deno.test("cambio 5: si falta una étape, se repara pidiéndosela al modelo", async () => {
  const sin14 = { mensaje_para_alumno: "x", secciones: secc([8, 9, 10, 11, 12, 13]), solicitud: SOLICITUD_12 };
  const completa = { mensaje_para_alumno: "x", secciones: PRESENTACION, solicitud: SOLICITUD_12 };
  const t = montar([sin14, completa]);
  const r = await t.continuar();
  assertEquals(r.estado.fase, "esperando_evidencia");
  assert(t.llm.peticiones[1].historial![1].texto.includes("faltan las étapes 14"));
});

Deno.test("cambio 5: alarma ante un texto de exactamente 4096 caracteres", async () => {
  const larga = PRESENTACION.map((x, i) => (i === 6 ? { ...x, texto: "a".repeat(4096) } : x));
  const t = montar([{ mensaje_para_alumno: "x", secciones: larga, solicitud: SOLICITUD_12 }]);
  await t.continuar();
  assert(t.registro.eventos.some((e) => e.codigo === 203 && String(e.mensaje).includes("4096")));
});

Deno.test("cambio 3: respuesta cortada → se repite desde cero con el doble de espacio", async () => {
  const buena = { mensaje_para_alumno: "x", secciones: PRESENTACION, solicitud: SOLICITUD_12 };
  const t = montar([new Cortada(buena), buena]);
  const r = await t.continuar();
  assertEquals(r.estado.fase, "esperando_evidencia");
  assertEquals([t.llm.peticiones[0].maxTokens, t.llm.peticiones[1].maxTokens], [6000, 12000]);
  assertEquals(t.llm.peticiones[1].historial, undefined, "no se «repara» un texto cortado");
});

Deno.test("cambio 3: respuesta que no es JSON (p. ej. un clasificador que dice «safe») → se repite desde cero", async () => {
  const t = montar(["safe", { mensaje_para_alumno: "x", secciones: PRESENTACION, solicitud: SOLICITUD_12 }]);
  const r = await t.continuar();
  assertEquals(r.estado.fase, "esperando_evidencia");
  assertEquals(t.llm.peticiones[1].historial, undefined, "no se le pide a otro modelo que arregle «safe»");
  assert(t.registro.eventos.some((e) => e.codigo === 203 && String(e.mensaje).includes("ilegible")));
});

// ---------- Reintento ante fallos pasajeros ----------
const PRESENTACION_OK = { mensaje_para_alumno: "x", secciones: PRESENTACION, solicitud: SOLICITUD_12 };

for (const codigo of [202, 204, 206] as const) {
  Deno.test(`fallo pasajero ${codigo}: se repite una vez la misma petición y el alumno no ve el error`, async () => {
    const t = montar([new FalloProveedor(codigo), PRESENTACION_OK]);
    const r = await t.continuar();
    assertEquals(r.estado.fase, "esperando_evidencia");
    assertEquals(t.llm.peticiones.length, 2);
    assertEquals(t.llm.peticiones[1].historial, undefined);
    assert(t.registro.eventos.some((e) => e.codigo === codigo && e.severidad === "warning"));
  });
}

Deno.test("fallo pasajero dos veces seguidas: se muestra el error, sin tercer intento", async () => {
  const t = montar([new FalloProveedor(204), new FalloProveedor(204), PRESENTACION_OK]);
  assertEquals((await assertRejects(() => t.continuar(), ErrorApp)).codigo, 204);
  assertEquals(t.llm.peticiones.length, 2);
  assertEquals(t.repo.sesiones.get(AI)?.requisitos_etapa.estado_paso, "pendiente_presentar");
});

// ---------- Cambios 11 y 12: modelo de respaldo y pausa por saturación ----------
function montarConRespaldo(principal: unknown[], respaldo: unknown[]) {
  const t = montar(principal);
  const llmRespaldo = new LLMFalso(respaldo, "respaldo-lite");
  const pausas: number[] = [];
  t.ctx.obtenerLLMRespaldo = () => llmRespaldo;
  t.ctx.pausa = (ms) => {
    pausas.push(ms);
    return Promise.resolve();
  };
  return { ...t, llmRespaldo, pausas };
}

Deno.test("cambio 11+12: 503 «high demand» → pausa de 5 s y el segundo intento va al modelo de respaldo", async () => {
  const t = montarConRespaldo([new FalloProveedor(206, { http: 503 })], [PRESENTACION_OK]);
  const r = await t.continuar();
  assertEquals(r.estado.fase, "esperando_evidencia");
  assertEquals([t.llm.peticiones.length, t.llmRespaldo.peticiones.length], [1, 1]);
  assertEquals(t.pausas, [5000]);
  assert(t.registro.eventos.some((e) => e.codigo === 900 && (e.contexto as { modelo?: string })?.modelo === "respaldo-lite"));
  assert(t.registro.eventos.some((e) => (e.contexto as { modelo_segundo_intento?: string })?.modelo_segundo_intento === "respaldo-lite"));
});

Deno.test("cambio 11+12: 429 (202) también cuenta como saturación", async () => {
  const t = montarConRespaldo([new FalloProveedor(202)], [PRESENTACION_OK]);
  await t.continuar();
  assertEquals(t.pausas, [5000]);
  assertEquals(t.llmRespaldo.peticiones.length, 1);
});

Deno.test("cambio 11: 204 (tiempo agotado) → pausa corta y respaldo, con las mismas fotos y sin historial", async () => {
  const t = montarConRespaldo([new FalloProveedor(204)], [PRESENTACION_OK]);
  await t.continuar();
  assertEquals(t.pausas, [1500]);
  assertEquals(t.llmRespaldo.peticiones.length, 1);
  assertEquals(t.llmRespaldo.peticiones[0].historial, undefined);
  assertEquals(t.llmRespaldo.peticiones[0].mensajeUsuario, t.llm.peticiones[0].mensajeUsuario);
});

Deno.test("cambio 11: si el respaldo también falla, se muestra su error y no hay tercer intento", async () => {
  const t = montarConRespaldo([new FalloProveedor(206, { http: 503 })], [new FalloProveedor(204), PRESENTACION_OK]);
  assertEquals((await assertRejects(() => t.continuar(), ErrorApp)).codigo, 204);
  assertEquals([t.llm.peticiones.length, t.llmRespaldo.peticiones.length], [1, 1]);
  assertEquals(t.repo.sesiones.get(AI)?.requisitos_etapa.estado_paso, "pendiente_presentar");
});

Deno.test("cambio 11: un fallo de formato (203) se repara con el MISMO modelo, no con el respaldo", async () => {
  const t = montarConRespaldo(["safe", PRESENTACION_OK], []);
  await t.continuar();
  assertEquals([t.llm.peticiones.length, t.llmRespaldo.peticiones.length], [2, 0]);
  assertEquals(t.pausas, []);
});

Deno.test("cambio 11: si el respaldo no se puede crear, el segundo intento usa el principal", async () => {
  const t = montarConRespaldo([new FalloProveedor(204), PRESENTACION_OK], []);
  t.ctx.obtenerLLMRespaldo = () => {
    throw new ErrorApp(205, "Falta el secret GEMINI_API_KEY");
  };
  const r = await t.continuar();
  assertEquals(r.estado.fase, "esperando_evidencia");
  assertEquals(t.llm.peticiones.length, 2);
});

for (const codigo of [201, 207, 208] as const) {
  Deno.test(`fallo permanente ${codigo}: NO se reintenta (gastaría cuota sin remedio)`, async () => {
    const t = montar([new FalloProveedor(codigo), PRESENTACION_OK]);
    assertEquals((await assertRejects(() => t.continuar(), ErrorApp)).codigo, codigo);
    assertEquals(t.llm.peticiones.length, 1);
  });
}

// ---------- Cambios 2 y 4 en el flujo ----------
Deno.test("cambio 4: la evaluación con fotos vacía por el límite se repite con el doble de espacio Y con las fotos", async () => {
  const sol = { mensaje_para_alumno: "x", secciones: PRESENTACION, solicitud: { enunciado: "e", niveles: [
    { nivel: 1, total_pedido: 2, unidad_medida: "ejercicios" }, { nivel: 2, total_pedido: 2, unidad_medida: "ejercicios" },
  ] } };
  const buena = eva([{ nivel: 1, total_entregado: 2, items_evaluados: 2, items_correctos: 2 }, { nivel: 2, total_entregado: 2, items_evaluados: 2, items_correctos: 2 }]);
  const t = montar([sol, buena]);
  await t.continuar();
  const original = t.llm.generar.bind(t.llm);
  let primera = true;
  t.llm.generar = (p) => {
    if (primera) {
      primera = false;
      t.llm.peticiones.push(p);
      return Promise.reject(new ErrorApp(203, "respuesta vacía por el límite", { tipo_fallo: "cortada" }));
    }
    return original(p);
  };
  const jpeg = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3));
  const r = await manejarEstudiante(t.ctx, { accion: "responder", alumno_idioma_id: AI, imagenes: [{ mediaType: "image/jpeg", base64: jpeg }] });
  assertEquals(r.resultado, "avanza");
  const [, evalUno, evalDos] = t.llm.peticiones;
  assertEquals([evalUno.maxTokens, evalDos.maxTokens], [2500, 5000]);
  assertEquals(evalDos.imagenes.length, 1, "al repetir por límite, las fotos sí se reenvían");
});

// ---------- Cambios 13 y 14: condiciones de las formas de evidencia y consigna de la étape 16 ----------
Deno.test("cambio 13+14: nivel 3 sin 2 irregulares → completar; la étape 16 no fuerza la regla e ignora condiciones", async () => {
  const sol = (enunciado: string, niveles: unknown[]) => ({ mensaje_para_alumno: enunciado, solicitud: { enunciado, niveles } });
  const cond = (cumple: boolean, detalle: string) => [{ nivel: 3, condicion: "al menos 2 plurales irregulares", cumple, detalle }];
  const t = montar([
    { secciones: PRESENTACION, ...sol("Niveles 1 y 2", [{ nivel: 1, total_pedido: 8, unidad_medida: "ejercicios" }, { nivel: 2, total_pedido: 4, unidad_medida: "ejercicios" }]) },
    eva([{ nivel: 1, total_entregado: 8, items_evaluados: 8, items_correctos: 8 }, { nivel: 2, total_entregado: 4, items_evaluados: 4, items_correctos: 4 }]),
    sol("Niveau 3", [{ nivel: 3, total_pedido: 5, unidad_medida: "frases" }]),
    { ...eva([{ nivel: 3, total_entregado: 6, items_evaluados: 6, items_correctos: 5 }], [err("life have been", 3)]), condiciones: cond(false, "solo hay 1: children") },
    { ...eva([{ nivel: 3, total_entregado: 7, items_evaluados: 7, items_correctos: 6 }]), condiciones: cond(true, "children, feet") },
    sol("Escribe unas 100 palabras sobre tu casa.", [{ nivel: null, total_pedido: 100, unidad_medida: "palabras" }]),
    { ...eva([{ nivel: null, total_entregado: 105, items_evaluados: 8, items_correctos: 8 }]), transcripcion: texto(105), condiciones: cond(false, "condición inventada") },
  ]);
  await t.continuar();
  let r = await t.responder("niveles 1 y 2");
  assertEquals(r.estado.paso, "exercices_n3");
  await t.continuar();
  assert(t.llm.peticiones.at(-1)!.sistema.dinamico.includes("formas de evidencia esperadas para esta producción (étape 15)"));

  // Cantidad suficiente, condición incumplida: no avanza, no se diagnostica y el sistema dice qué falta.
  r = await t.responder("mis 6 frases");
  assertEquals([r.resultado, r.estado.paso], ["requiere_completar", "exercices_n3"]);
  const aviso = r.mensaje_sistema ?? "";
  assert(aviso.includes("al menos 2 plurales irregulares") && aviso.includes("children"));
  assertEquals(t.repo.evidencias.at(-1)!.diagnosticos, null);
  assertEquals(t.repo.sesiones.get(AI)?.requisitos_etapa.errores_acumulados, undefined, "sin evidencia completa no se acumulan errores");
  assert(t.llm.peticiones.at(-1)!.sistema.dinamico.includes("condiciones: por CADA condición"));

  // Complemento: ahora se cumple y avanza.
  r = await t.responder("una frase más con feet");
  assertEquals([r.resultado, r.estado.paso], ["avanza", "production_ecrite"]);

  // Étape 16: la consigna no declara las formas de la étape 15 ni menciona la regla.
  await t.continuar();
  const dinamico16 = t.llm.peticiones.at(-1)!.sistema.dinamico;
  assert(!dinamico16.includes("Declara primero las formas de evidencia"));
  assert(dinamico16.includes("NO menciones la regla"));

  // Étape 16: una condición reportada por error NO bloquea (solo la étape 15 tiene formas de evidencia).
  r = await t.responder("mi texto de 105 palabras");
  assertEquals([r.resultado, r.estado.paso], ["avanza", "correction"]);
  assert(t.llm.peticiones.at(-1)!.sistema.dinamico.includes("condiciones: lista vacía"));
});

// ---------- Cambios 15 y 16: el código cuenta las palabras y «continuar» repite lo que falta ----------
Deno.test("cambio 15+16: étape 16 — conteo del código, cada entrega reemplaza a la anterior, continuar recuerda lo que falta", async () => {
  const sol = (enunciado: string, niveles: unknown[]) => ({ mensaje_para_alumno: enunciado, solicitud: { enunciado, niveles } });
  const t = montar([
    { secciones: PRESENTACION, ...sol("Niveles 1 y 2", [{ nivel: 1, total_pedido: 8, unidad_medida: "ejercicios" }, { nivel: 2, total_pedido: 4, unidad_medida: "ejercicios" }]) },
    eva([{ nivel: 1, total_entregado: 8, items_evaluados: 8, items_correctos: 8 }, { nivel: 2, total_entregado: 4, items_evaluados: 4, items_correctos: 4 }]),
    sol("Niveau 3", [{ nivel: 3, total_pedido: 5, unidad_medida: "frases" }]),
    eva([{ nivel: 3, total_entregado: 5, items_evaluados: 5, items_correctos: 5 }]),
    sol("Escribe unas 100 palabras sobre tu familia.", [{ nivel: null, total_pedido: 100, unidad_medida: "palabras" }]),
    // La IA dice 95 (falso); el texto tiene 68 → no alcanza.
    { ...eva([{ nivel: null, total_entregado: 95, items_evaluados: 3, items_correctos: 3 }]), transcripcion: texto(68) },
    // La IA dice 65 (falso, como en la prueba real); el texto completo ampliado tiene 92 → avanza.
    { ...eva([{ nivel: null, total_entregado: 65, items_evaluados: 4, items_correctos: 3 }], [err("life have been", null)]), transcripcion: texto(92) },
  ]);
  await t.continuar();
  await t.responder("1 y 2");
  await t.continuar();
  await t.responder("nivel 3");
  await t.continuar();

  let r = await t.responder("foto de 68 palabras");
  assertEquals([r.resultado, r.estado.paso], ["requiere_completar", "production_ecrite"]);
  assertEquals(r.mensaje_sistema, "Tu texto tiene 68 palabras; el mínimo es 80. Reenvía el texto COMPLETO, ampliado.");
  assertEquals(t.repo.evidencias.at(-1)!.metricas.total_entregado, 68);
  assertEquals(t.repo.evidencias.at(-1)!.metricas.conteo, "codigo");

  // Cambio 16: «continuar» no llama a la IA y recuerda lo que falta.
  const llamadas = t.llm.peticiones.length;
  r = await t.continuar();
  assertEquals(t.llm.peticiones.length, llamadas);
  assert((r.mensaje_sistema ?? "").includes("Tu texto tiene 68 palabras"));

  // Texto completo ampliado: se evalúa SOLO esta entrega (no la unión) y avanza aunque la IA cuente 65.
  r = await t.responder("foto del texto completo, ampliado");
  const dinamico = t.llm.peticiones.at(-1)!.sistema.dinamico;
  assert(dinamico.includes("REEMPLAZA a las anteriores") && !dinamico.includes("evalúa la UNIÓN"));
  assertEquals([r.resultado, r.estado.paso], ["avanza", "correction"]);
  assertEquals(t.repo.evidencias.at(-1)!.metricas.total_entregado, 92);
  assertEquals(t.repo.sesiones.get(AI)?.requisitos_etapa.ultimo_mensaje_sistema, undefined, "el aviso no se arrastra al paso siguiente");
});

// ---------- Cambios 17 y 18: lista de pendientes del código y errores falsos ----------
const errX = (fragmento: string, correccion: string, nivel: number | null) => ({ ...err(fragmento, nivel), correccion });

function montarHastaCorreccion() {
  const sol = (enunciado: string, niveles: unknown[]) => ({ mensaje_para_alumno: enunciado, solicitud: { enunciado, niveles } });
  return montar([
    { secciones: PRESENTACION, ...sol("Niveles 1 y 2", [{ nivel: 1, total_pedido: 8, unidad_medida: "ejercicios" }, { nivel: 2, total_pedido: 4, unidad_medida: "ejercicios" }]) },
    eva([{ nivel: 1, total_entregado: 8, items_evaluados: 8, items_correctos: 7 }, { nivel: 2, total_entregado: 4, items_evaluados: 4, items_correctos: 4 }],
      [errX("busses", "buses", 1)]),
    sol("Niveau 3", [{ nivel: 3, total_pedido: 5, unidad_medida: "frases" }]),
    // Como en la prueba real: la IA lista aciertos como «errores» (corrección idéntica).
    eva([{ nivel: 3, total_entregado: 6, items_evaluados: 7, items_correctos: 6 }],
      [errX("three brothers", "three brothers", 3), errX("two children", " two children.", 3), errX("sheeps", "sheep", 3), errX("i mean", "I mean", 3)]),
    sol("Texto de 100 palabras", [{ nivel: null, total_pedido: 100, unidad_medida: "palabras" }]),
    { ...eva([{ nivel: null, total_entregado: 100, items_evaluados: 5, items_correctos: 4 }], [errX("eties", "cities", null)]), transcripcion: texto(100) },
    { mensaje_para_alumno: "Corrijamos: busses, sheeps, i mean, eties…" },
    { mensaje_para_alumno: "Bien con buses y sheep.", transcripcion: "buses, sheep", indices_corregidos: [0, 1] },
  ]);
}

Deno.test("cambio 18+17: los aciertos no llegan a la étape 17 y la lista de pendientes la arma el código", async () => {
  const t = montarHastaCorreccion();
  for (const paso of ["1 y 2", "nivel 3", "texto"]) {
    await t.continuar();
    await t.responder(paso);
  }
  // Cambio 18: «three brothers» y «two children» se descartaron; «i mean» → «I mean» SÍ es error (mayúscula).
  assertEquals(t.repo.sesiones.get(AI)?.requisitos_etapa.errores_acumulados?.map((e) => e.fragmento), ["busses", "sheeps", "i mean", "eties"]);
  assert(t.registro.eventos.some((e) => e.codigo === 203 && String(e.mensaje).includes("Se descartaron 2")));

  // Étape 17: aunque la IA omitiera alguno, el sistema los lista TODOS.
  let r = await t.continuar();
  assertEquals(r.mensaje_sistema, "Corrección de las étapes 15 y 16 (se exige el 100 %). Pendientes (4): [0] «busses» · [1] «sheeps» · [2] «i mean» · [3] «eties». Reescribe cada uno.");
  assert(t.llm.peticiones.at(-1)!.sistema.dinamico.includes("Menciona TODOS los errores"));

  // Corrección parcial: el aviso nombra exactamente lo que falta, y «continuar» lo repite.
  r = await t.responder("buses, sheep");
  assertEquals(r.mensaje_sistema, "Corregiste 2 de 4. Pendientes (2): [2] «i mean» · [3] «eties». Reescribe cada uno.");
  r = await t.continuar();
  assert((r.mensaje_sistema ?? "").includes("[2] «i mean» · [3] «eties»"));
});

Deno.test("cambio 18: una sesión guardada con pendientes falsos se arregla sola al pulsar continuar (sin IA)", async () => {
  const t = montarHastaCorreccion();
  for (const paso of ["1 y 2", "nivel 3", "texto"]) {
    await t.continuar();
    await t.responder(paso);
  }
  await t.continuar(); // entra a la étape 17
  // Simula la sesión real de EN-411: solo quedan «errores» idénticos, guardados antes del filtro.
  const guardada = t.repo.sesiones.get(AI)!;
  guardada.requisitos_etapa.errores_senalados = ["three brothers", "two children", "mistakes", "entire days", "good moments", "do things"]
    .map((f, i) => ({ indice: i + 2, fragmento: f, correccion: f, explicacion: "", causa: "no_clasificada", paso: "exercices_n3" }));
  const llamadas = t.llm.peticiones.length;
  const r = await t.continuar();
  assertEquals(t.llm.peticiones.length, llamadas, "no gasta una llamada");
  assertEquals([r.resultado, r.estado.paso], ["avanza", "transformation"]);
  assert((r.mensaje_sistema ?? "").includes("no eran errores"));
});

// ---------- Cambio 19: errores fuera del alcance, mostrados en la étape 17 sin evaluarse ----------
function montarConObservaciones(produccionErrores: unknown[]) {
  const sol = (enunciado: string, niveles: unknown[]) => ({ mensaje_para_alumno: enunciado, solicitud: { enunciado, niveles } });
  const fuera = (f: string, c: string, nivel: number | null) => ({ ...errX(f, c, nivel), fuera_de_scope: true });
  return montar([
    { secciones: PRESENTACION, ...sol("Niveles 1 y 2", [{ nivel: 1, total_pedido: 8, unidad_medida: "ejercicios" }, { nivel: 2, total_pedido: 4, unidad_medida: "ejercicios" }]) },
    eva([{ nivel: 1, total_entregado: 8, items_evaluados: 8, items_correctos: 8 }, { nivel: 2, total_entregado: 4, items_evaluados: 4, items_correctos: 4 }]),
    sol("Niveau 3", [{ nivel: 3, total_pedido: 5, unidad_medida: "frases" }]),
    eva([{ nivel: 3, total_entregado: 6, items_evaluados: 6, items_correctos: 6 }],
      [fuera("life have been", "life has been", 3), fuera("traying", "trying", 3), fuera("two children", "two children", 3)]),
    sol("Texto", [{ nivel: null, total_pedido: 100, unidad_medida: "palabras" }]),
    { ...eva([{ nivel: null, total_entregado: 100, items_evaluados: 5, items_correctos: 4 }],
      [...produccionErrores, fuera("life have been", "life has been", null)]), transcripcion: texto(100) },
    { mensaje_para_alumno: "Corrijamos «eties»." },
    { mensaje_para_alumno: "¡Bien!", transcripcion: "cities", indices_corregidos: [0] },
    { mensaje_para_alumno: "Transformation", solicitud: { enunciado: "t", niveles: [{ nivel: null, total_pedido: 3, unidad_medida: "ejercicios" }] } },
  ]);
}
const NOTA = "Además observé errores de otros temas (no se evalúan ni hay que reescribirlos): «life have been» → «life has been» · «traying» → «trying».";

Deno.test("cambio 19: la étape 17 muestra los errores fuera del alcance sin exigirlos, y no pasan a la étape 18", async () => {
  const t = montarConObservaciones([errX("eties", "cities", null)]);
  for (const paso of ["1 y 2", "nivel 3", "texto"]) {
    await t.continuar();
    await t.responder(paso);
  }
  let r = await t.continuar();
  assertEquals(r.mensaje_sistema, `Corrección de las étapes 15 y 16 (se exige el 100 %). Pendientes (1): [0] «eties». Reescribe cada uno. ${NOTA}`);
  assertEquals(t.repo.sesiones.get(AI)?.requisitos_etapa.errores_senalados?.map((e) => e.fragmento), ["eties"], "las observaciones no se exigen");
  assert(t.llm.peticiones.at(-1)!.sistema.dinamico.includes("No menciones otros errores fuera del objetivo"));

  r = await t.responder("cities");
  assertEquals([r.resultado, r.estado.paso], ["avanza", "transformation"]);
  assertEquals(t.repo.sesiones.get(AI)?.requisitos_etapa.observaciones_acumuladas, undefined, "no se arrastran más allá de la étape 17");
  // Siguen registradas como evidencia (Principio 9).
  assert(t.repo.evidencias.some((e) => (e.diagnosticos ?? []).some((d) => d.fragmento === "traying")));
});

Deno.test("cambio 19: sin errores dentro del alcance, la étape 17 se salta pero igual muestra las observaciones", async () => {
  const t = montarConObservaciones([]);
  t.llm.peticiones.length = 0;
  for (const paso of ["1 y 2", "nivel 3", "texto"]) {
    await t.continuar();
    await t.responder(paso);
  }
  // El guion salta la corrección: se quitan las dos respuestas de la étape 17.
  (t.llm as unknown as { guion: unknown[] }).guion.splice(0, 2);
  const r = await t.continuar();
  assertEquals(r.estado.paso, "transformation");
  assert((r.mensaje_sistema ?? "").startsWith(`Étape 17: no hubo errores que corregir. ${NOTA}`));
});

// ---------- Cambio 20: corrección diferida al propietario (MC-001 v1.0.4 §7.5) ----------
/**
 * Inglés real (EN-GRAFO): EN-411 (EN-410), EN-421 (EN-420), EN-511 (EN-510); fonología EN-100 es transversal.
 * En la lección `actual`, el alumno produce errores fuera del alcance con distintos propietarios.
 */
function montarEN(actual: string, estadoPrevio: Record<string, "acquis" | "en_cours"> = {}) {
  const t = montar([]);
  t.repo.alumnos.set(AI, { id: AI, perfil_id: USUARIO, idioma_codigo: "EN" });
  t.repo.lecciones = [
    { ...leccion("EN-411", "EN-400", "EN-410", 1), titulo: "Pluriel", idioma: "EN", contenido: "# EN-411" },
    { ...leccion("EN-421", "EN-400", "EN-420", 1), titulo: "Articles", idioma: "EN", contenido: "# EN-421" },
    { ...leccion("EN-511", "EN-500", "EN-510", 1), titulo: "Le verbe", idioma: "EN", contenido: "# EN-511" },
  ];
  for (const [u, estado] of Object.entries(estadoPrevio)) {
    t.repo.estados.set(`${AI}|${u}`, { alumno: AI, unidad_id: u, estado, actualizado_en: "2026-10-01T00:00:00Z" });
  }
  // Sesión directa en la étape 17 de `actual`, con observaciones ya reunidas en las étapes 15 y 16.
  t.repo.sesiones.set(AI, {
    id: "s1", alumno_idioma_id: AI, unidad_id: actual, etapa_actual: 17, fase_correccion: null, actualizado_en: "2026-11-01T00:00:00Z",
    requisitos_etapa: {
      paso: "correction", estado_paso: "pendiente_presentar",
      errores_acumulados: [{ indice: 0, fragmento: "busses", correccion: "buses", explicacion: "-es sin duplicar", paso: "exercices_n1_n2" }],
      observaciones_acumuladas: [
        { fragmento: "life have been", correccion: "life has been", paso: "exercices_n3", propietario: "EN-510", explicacion: "concordancia", causa: "no_clasificada" },
        { fragmento: "a apple", correccion: "an apple", paso: "exercices_n3", propietario: "EN-420", explicacion: "an ante vocal", causa: "no_clasificada" },
        { fragmento: "/kæts/ → /kætz/", correccion: "/kæts/", paso: "production_ecrite", propietario: "EN-170" },
        { fragmento: "traying", correccion: "trying", paso: "production_ecrite", propietario: null },
      ],
    },
  });
  return t;
}

Deno.test("cambio 20: ya estudiado → se corrige ahora; no estudiado → diferido; transversal o sin propietario → observación", async () => {
  // En EN-411 con EN-421 (artículos) ya aprobada.
  const t = montarEN("EN-411", { "EN-421": "acquis", "EN-411": "en_cours" });
  (t.llm as unknown as { guion: unknown[] }).guion.push({ mensaje_para_alumno: "Corrijamos." });
  const r = await t.continuar();
  // «a apple» (EN-420, ya estudiado) se exige aquí, con su tema; «life have been» (EN-510) se difiere.
  assertEquals(r.mensaje_sistema,
    "Corrección de las étapes 15 y 16 (se exige el 100 %). Pendientes (2): [0] «busses» · [1] «a apple» (tema EN-420). Reescribe cada uno. " +
    "Además observé errores de otros temas (no se evalúan ni hay que reescribirlos): «life have been» → «life has been» (se corregirá en EN-510) · «/kæts/ → /kætz/» → «/kæts/» · «traying» → «trying».");
  assertEquals(t.repo.diferidos.map((d) => [d.propietario, d.unidad_origen, d.fragmento]), [["EN-510", "EN-411", "life have been"]]);
  assert(t.llm.peticiones.at(-1)!.sistema.dinamico.includes("(otra lección) \"a apple\""));
});

Deno.test("cambio 20: el diferido se exige en la étape 17 de la lección del propietario y se borra al corregirlo", async () => {
  const t = montarEN("EN-511", { "EN-411": "acquis", "EN-511": "en_cours" });
  t.repo.sesiones.get(AI)!.requisitos_etapa.observaciones_acumuladas = [];
  t.repo.diferidos.push({
    id: "d1", alumno_idioma_id: AI, propietario: "EN-510", unidad_origen: "EN-411", fragmento: "life have been",
    correccion: "life has been", explicacion: "concordancia", causa: null, creado_en: "2026-11-01T00:00:00Z",
  });
  const guion = (t.llm as unknown as { guion: unknown[] }).guion;
  guion.push(
    { mensaje_para_alumno: "Corrijamos." },
    { mensaje_para_alumno: "Bien «buses».", transcripcion: "buses", indices_corregidos: [0] },
    { mensaje_para_alumno: "¡Bien!", transcripcion: "life has been", indices_corregidos: [1] },
  );
  let r = await t.continuar();
  assertEquals(r.mensaje_sistema,
    "Corrección de las étapes 15 y 16 (se exige el 100 %). Pendientes (2): [0] «busses» · [1] «life have been» (tema EN-510). Reescribe cada uno.");
  r = await t.responder("buses");
  assertEquals(t.repo.diferidos.length, 1, "sigue pendiente mientras no se corrija");
  r = await t.responder("life has been");
  assertEquals([r.resultado, r.estado.paso], ["avanza", "transformation"]);
  assertEquals(t.repo.diferidos.length, 0, "corregido → se borra");
});

Deno.test("cambio 20: un diferido no vuelve en su propia lección ni en lecciones de otro propietario", async () => {
  const t = montarEN("EN-421", { "EN-421": "en_cours" });
  t.repo.sesiones.get(AI)!.requisitos_etapa.observaciones_acumuladas = [];
  t.repo.diferidos.push(
    { id: "d1", alumno_idioma_id: AI, propietario: "EN-510", unidad_origen: "EN-411", fragmento: "life have been", correccion: "life has been", explicacion: "", causa: null, creado_en: "x" },
    { id: "d2", alumno_idioma_id: AI, propietario: "EN-420", unidad_origen: "EN-421", fragmento: "a apple", correccion: "an apple", explicacion: "", causa: null, creado_en: "x" },
  );
  (t.llm as unknown as { guion: unknown[] }).guion.push({ mensaje_para_alumno: "Corrijamos." });
  const r = await t.continuar();
  assertEquals(r.mensaje_sistema, "Corrección de las étapes 15 y 16 (se exige el 100 %). Pendientes (1): [0] «busses». Reescribe cada uno.");
});

Deno.test("cambio 20: sin la migración 005 la étape 17 sigue funcionando (todo queda como observación)", async () => {
  const t = montarEN("EN-411", { "EN-411": "en_cours" });
  t.repo.fallarDiferidos = true;
  (t.llm as unknown as { guion: unknown[] }).guion.push({ mensaje_para_alumno: "Corrijamos." });
  const r = await t.continuar();
  assertEquals(r.estado.fase, "esperando_correccion");
  assert((r.mensaje_sistema ?? "").includes("«life have been» → «life has been» (se corregirá en EN-510)"));
  assert(t.registro.eventos.some((e) => String(e.mensaje).includes("¿migración 005?")));
});
