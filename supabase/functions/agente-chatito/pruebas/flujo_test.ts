import { assert, assertAlmostEquals, assertEquals, assertRejects } from "./afirmar.ts";
import { GRAFOS, MC } from "../config.ts";
import { ErrorApp } from "../errores.ts";
import { type ContextoFlujo, manejarEstudiante } from "../flujo_estudiante.ts";
import { RegistradorConsola } from "../registro.ts";
import { AuxiliaresFalsos, leccion, LLMFalso, RepositorioMemoria } from "./dobles.ts";

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
    fallarAbiertoSiRedisCae: true,
  };
  const continuar = () => manejarEstudiante(ctx, { accion: "continuar", alumno_idioma_id: AI });
  const responder = (mensaje: string) => manejarEstudiante(ctx, { accion: "responder", alumno_idioma_id: AI, mensaje });
  return { repo, llm, registro, auxiliares, ctx, continuar, responder };
}

const eva = (niveles: unknown[], errores: unknown[] = []) => ({
  mensaje_para_alumno: "retroalimentación", transcripcion: "transcripción", niveles, errores,
});
const err = (fragmento: string, nivel: number | null, fuera = false, rel: string | null = null) => ({
  fragmento, correccion: "forma correcta", causa: "connaissance_partielle", explicacion: "porque…",
  fuera_de_scope: fuera, unidad_relacionada: rel, nivel,
});

Deno.test("piloto FR-411 según MC-001 real: corrección diferida en étape 17, cierre y siguiente unidad", async () => {
  const sol = (enunciado: string, niveles: unknown[]) => ({ mensaje_para_alumno: enunciado, solicitud: { enunciado, niveles } });
  const t = montar([
    /* 1 */ sol("Étapes 8–14 … Ejercicios niveles 1 y 2", [{ nivel: 1, total_pedido: 8, unidad_medida: "ejercicios" }, { nivel: 2, total_pedido: 4, unidad_medida: "ejercicios" }]),
    /* 2 */ eva([{ nivel: 1, total_entregado: 8, items_evaluados: 8, items_correctos: 8 }, { nivel: 2, total_entregado: 2, items_evaluados: 2, items_correctos: 0 }]),
    /* 3 */ eva(
      [{ nivel: 1, total_entregado: 8, items_evaluados: 8, items_correctos: 8 }, { nivel: 2, total_entregado: 4, items_evaluados: 4, items_correctos: 1 }],
      [err("un maison", 2), err("le table", 2), err("une livre", 2), err("il a allé", 2, true)],
    ),
    /* 4 */ sol("Niveau 3 — production libre", [{ nivel: 3, total_pedido: 5, unidad_medida: "frases" }]),
    /* 5 */ eva([{ nivel: 3, total_entregado: 5, items_evaluados: 5, items_correctos: 4 }], [err("la problème", 3)]),
    /* 6 */ sol("Production écrite", [{ nivel: null, total_pedido: 100, unidad_medida: "palabras" }]),
    /* 7 */ eva([{ nivel: null, total_entregado: 110, items_evaluados: 10, items_correctos: 10 }]),
    /* 8 */ { mensaje_para_alumno: "Correction détaillée: 1) un maison → une maison…" },
    /* 9 */ { mensaje_para_alumno: "Bien, faltan dos.", transcripcion: "…", indices_corregidos: [0, 1] },
    /* 10 */ { mensaje_para_alumno: "¡Todo corregido!", transcripcion: "…", indices_corregidos: [2, 3] },
    /* 11 */ sol("Transformation", [{ nivel: null, total_pedido: 5, unidad_medida: "ejercicios" }]),
    /* 12 */ eva([{ nivel: null, total_entregado: 5, items_evaluados: 5, items_correctos: 4 }], [err("elle était allé", null)]),
    /* 13 */ { mensaje_para_alumno: "Correcto.", transcripcion: "…", indices_corregidos: [0] },
    /* 14 */ { mensaje_para_alumno: "Vocabulaire…", solicitud: null },
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

  // Étape 18 — transformación: su corrección es inmediata (a ratificar).
  await t.continuar();
  assert(t.llm.peticiones.at(-1)!.sistema.dinamico.includes("étape 14 del livrable"));
  r = await t.responder("transformaciones");
  assertEquals([r.resultado, r.estado.etapa_actual], ["requiere_correccion", 17]);
  r = await t.responder("corrijo");
  assertEquals(r.estado.paso, "vocabulaire");

  // Étape 19 — cierre: acquis, puntaje, FR-412.
  r = await t.continuar();
  assertEquals(r.resultado, "unidad_completada");
  assertEquals(t.repo.estados.get(`${AI}|FR-411`)?.estado, "acquis");
  assertEquals([r.estado.unidad_id, r.estado.fase], ["FR-412", "listo_para_continuar"]);
  // guiada: niveles 1–2 (8+1)/(8+4) y transformación 4/5 → 13/17 ; libre: nivel 3 4/5 y producción 10/10 → 14/15
  assertAlmostEquals(t.repo.puntajes.get(`${AI}|FR-411`)!, 100 * (0.6 * (14 / 15) + 0.4 * (13 / 17)), 0.01);
  assertEquals(t.llm.peticiones.length, 14, "una llamada al LLM por turno que la necesita");
  assert(t.registro.eventos.some((e) => e.codigo === 901));
});

Deno.test("étape 17 sin errores acumulados: se salta sola y entrega la transformación en la misma petición", async () => {
  const t = montar([
    { mensaje_para_alumno: "x", solicitud: { enunciado: "e", niveles: [
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

Deno.test("respuesta basura del LLM → 203 y la sesión no avanza", async () => {
  const t = montar(["Lo siento, no puedo ayudar con eso."]);
  assertEquals((await assertRejects(() => t.continuar(), ErrorApp)).codigo, 203);
  assertEquals(t.repo.sesiones.get(AI)?.requisitos_etapa.estado_paso, "pendiente_presentar");
});

Deno.test("Redis caído: se sigue funcionando (fallo abierto) y queda registrado 501", async () => {
  const t = montar([{ mensaje_para_alumno: "x", solicitud: {
    enunciado: "e", niveles: [{ nivel: 1, total_pedido: 8, unidad_medida: "ejercicios" }, { nivel: 2, total_pedido: 4, unidad_medida: "ejercicios" }],
  } }]);
  t.auxiliares.romper = true;
  const r = await t.continuar();
  assertEquals(r.estado.fase, "esperando_evidencia");
  assert(t.registro.eventos.some((e) => e.codigo === 501));
});

Deno.test("Storage caído: la evidencia (transcripción) se guarda igual y se registra 502", async () => {
  const t = montar([
    { mensaje_para_alumno: "x", solicitud: { enunciado: "e", niveles: [
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
  const llm = new LLMFalso([{ mensaje_para_alumno: "Présentation", solicitud: {
    enunciado: "e", niveles: [{ nivel: 1, total_pedido: 8, unidad_medida: "ejercicios" }, { nivel: 2, total_pedido: 4, unidad_medida: "ejercicios" }],
  } }]);
  t.ctx.obtenerLLM = () => llm;
  r = await t.continuar();
  assertEquals(r.estado.unidad_id, "FR-411");
  assertEquals(r.estado.fase, "esperando_evidencia");
});
