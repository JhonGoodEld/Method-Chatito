import { assert, assertAlmostEquals, assertEquals, assertThrows } from "./afirmar.ts";
import { evaluarCorreccion, evaluarProduccion, minimoRequerido } from "../completitud.ts";
import { MC, GRAFOS } from "../config.ts";
import { ErrorApp } from "../errores.ts";
import { validarPlan } from "../plan.ts";
import { calcularPuntaje } from "../puntaje.ts";
import { calcularPrioridad, evaluarMotor, pesosEfectivos, type ParametrosMotor } from "../reactivacion.ts";
import { extraerJson, parsearSalida, SalidaEvaluacionSchema } from "../salida_llm.ts";
import { validarCuerpo, validarImagenes } from "../peticion.ts";
import { bloqueDinamico, bloqueEstatico } from "../prompt.ts";
import { obtenerUsuarioDelToken } from "../datos.ts";
import { assertRejects } from "./afirmar.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { FilaEvidencia } from "../tipos.ts";
import { leccion } from "./dobles.ts";

// ---------- Completitud ----------
Deno.test("mínimo: aritmética entera exacta para cualquier factor calibrable", () => {
  assertEquals(Math.ceil(450 * 0.54), 244, "confirma que la versión ingenua SÍ falla con 0.54");
  assertEquals(minimoRequerido(450, 0.54), 243);
  assertEquals(minimoRequerido(25, 0.28), 7);
  assertEquals(minimoRequerido(35, 0.8), 28);
  assertEquals(minimoRequerido(10, 0.8), 8);
  assertEquals(minimoRequerido(7, 0.8), 6);
  assertEquals(minimoRequerido(4, 0.8), 4);
  assertEquals(minimoRequerido(100, 0.8), 80);
  assertEquals(minimoRequerido(1, 0.8), 1);
  for (let n = 1; n <= 500; n++) assertEquals(minimoRequerido(n, 0.8), Math.ceil((n * 8) / 10));
});

Deno.test("mínimo: total inválido → 306", () => {
  const e = assertThrows(() => minimoRequerido(0, 0.8), ErrorApp);
  assertEquals(e.codigo, 306);
});

Deno.test("producción: cada nivel se evalúa por separado", () => {
  const r = evaluarProduccion([
    { nivel: 1, total_pedido: 8, total_entregado: 8 },
    { nivel: 2, total_pedido: 4, total_entregado: 3 },
  ], 0.8);
  assertEquals(r.cumple, false);
  assertEquals(r.detalle[1].minimo, 4);
});

Deno.test("corrección: exige el 100% e ignora índices no señalados", () => {
  assertEquals(evaluarCorreccion([0, 1, 2], [0, 2, 7]), { completa: false, pendientes: [1], corregidos: 2 });
  assertEquals(evaluarCorreccion([0, 1], [1, 0]).completa, true);
});

// ---------- Puntaje ----------
function ev(paso: string, nivel: number | null, m: Partial<FilaEvidencia["metricas"]>, t: string): FilaEvidencia {
  return {
    id: crypto.randomUUID(), creado_en: t, alumno_idioma_id: "a", unidad_id: "FR-411", etapa_mc001: 8,
    nivel_ejercicio: nivel, tipo_contenido: "texto", contenido_alumno: "", url_storage: null, correccion: null,
    diagnosticos: null, metricas: { paso, intento: "inicial", ...m },
  };
}

Deno.test("puntaje: usa el último intento pre-corrección y pondera 0.6/0.4", () => {
  const pesos = MC.evidencia_y_estado.puntaje_leccion.pesos_iniciales_a_calibrar;
  const evidencias = [
    ev("ex", 2, { categoria: "guiada", total_pedido: 4, items_correctos: 0 }, "2026-01-01T00:00:01Z"),
    ev("ex", 2, { categoria: "guiada", total_pedido: 4, items_correctos: 1, intento: "complemento" }, "2026-01-01T00:00:02Z"),
    ev("ex", 2, { intento: "correccion", errores_senalados: 3, errores_corregidos: 3 }, "2026-01-01T00:00:03Z"),
    ev("pe", null, { categoria: "libre", items_evaluados: 10, items_correctos: 10 }, "2026-01-01T00:00:04Z"),
  ];
  assertAlmostEquals(calcularPuntaje(evidencias, pesos)!, 100 * (0.6 * 1 + 0.4 * 0.25), 0.01);
});

Deno.test("puntaje: renormaliza si falta una categoría; null si no hay datos", () => {
  const pesos = { peso_produccion_espontanea: 0.6, peso_produccion_guiada: 0.4 };
  assertEquals(calcularPuntaje([ev("ex", 1, { categoria: "guiada", total_pedido: 10, items_correctos: 5 }, "t1")], pesos), 50);
  assertEquals(calcularPuntaje([], pesos), null);
});

// ---------- Motor de reactivación ----------
const PARAMS: ParametrosMotor = {
  w_errores: 0.5, w_dependencia: 0.2, w_tiempo: 0.3,
  tope_errores: 5, tope_profundidad: 10, tau_dias: 14, umbral_disparo: 0.5, p_azar: 0.08,
};

Deno.test("motor: modo grupo anula w_errores y renormaliza", () => {
  const w = pesosEfectivos(PARAMS, "grupo");
  assertEquals(w.e, 0);
  assertAlmostEquals(w.d + w.t, 1, 1e-12);
  assertAlmostEquals(w.d, 0.4, 1e-12);
});

Deno.test("motor: prioridad con topes y curva creciente", () => {
  const p = calcularPrioridad({ erroresRelacionados: 5, profundidad: 20, dias: 14 }, PARAMS);
  assertAlmostEquals(p, 0.5 * 1 + 0.2 * 1 + 0.3 * (1 - Math.exp(-1)), 1e-12);
});

Deno.test("motor: el azar es un sorteo independiente y excluye la unidad recién completada", () => {
  const lecciones = [leccion("FR-411", "FR-400", "FR-410", 1), leccion("FR-412", "FR-400", "FR-410", 2)];
  const estados = [
    { unidad_id: "FR-411", estado: "acquis" as const, actualizado_en: "2026-01-01T00:00:00Z" },
    { unidad_id: "FR-412", estado: "acquis" as const, actualizado_en: "2026-02-01T00:00:00Z" },
  ];
  const secuencia = [0.01, 0.99];
  const r = evaluarMotor({
    grafo: GRAFOS.FR, lecciones, estados, evidencias: [], excluir: "FR-412",
    ahora: new Date("2026-03-01T00:00:00Z"), parametros: PARAMS, aleatorio: () => secuencia.shift()!,
  });
  assertEquals(r, { tipo: "hasard", unidadId: "FR-411" });
});

Deno.test("motor: errores atribuidos en lecciones posteriores disparan la sugerencia", () => {
  const lecciones = [leccion("FR-411", "FR-400", "FR-410", 1), leccion("FR-412", "FR-400", "FR-410", 2)];
  const estados = [
    { unidad_id: "FR-411", estado: "acquis" as const, actualizado_en: "2026-01-01T00:00:00Z" },
    { unidad_id: "FR-412", estado: "acquis" as const, actualizado_en: "2026-01-02T00:00:00Z" },
  ];
  const diag = (u: string) => ({ fragmento: "", correccion: "", causa: "oubli", explicacion: "", fuera_de_scope: true, unidad_relacionada: u, nivel: null });
  const evidencias = [{ ...ev("x", null, {}, "2026-01-02T00:00:00Z"), unidad_id: "FR-412", diagnosticos: [diag("FR-411"), diag("FR-411"), diag("FR-411"), diag("FR-411"), diag("FR-411")] }];
  const r = evaluarMotor({
    grafo: GRAFOS.FR, lecciones, estados, evidencias, excluir: "FR-412",
    ahora: new Date("2026-01-20T00:00:00Z"), parametros: PARAMS, aleatorio: () => 0.99,
  });
  assertEquals(r.tipo, "prioridad");
  assertEquals(r.unidadId, "FR-411");
  assert(r.prioridad! >= PARAMS.umbral_disparo);
});

// ---------- Salida del LLM ----------
Deno.test("extraerJson tolera cercas, prosa y llaves dentro de cadenas", () => {
  assertEquals(extraerJson('```json\n{"a":1}\n```'), { a: 1 });
  assertEquals(extraerJson('Claro, aquí está: {"a":"x}y{","b":{"c":2}} ¡Suerte!'), { a: "x}y{", b: { c: 2 } });
  assertThrows(() => extraerJson("sin json"));
});

Deno.test("parsearSalida: fuera de contrato → 203 con fragmento para depurar", () => {
  const e = assertThrows(() => parsearSalida(SalidaEvaluacionSchema, '{"mensaje_para_alumno":"hola"}', { tarea: "evaluar" }), ErrorApp);
  assertEquals(e.codigo, 203);
  assert(String(e.contexto.fragmento).includes("hola"));
});

Deno.test("parsearSalida: causa desconocida no rompe (→ no_clasificada)", () => {
  const r = parsearSalida(SalidaEvaluacionSchema, JSON.stringify({
    mensaje_para_alumno: "m", transcripcion: "t",
    niveles: [{ nivel: null, total_entregado: 1, items_evaluados: 1, items_correctos: 0 }],
    errores: [{ fragmento: "le table", correccion: "la table", causa: "inventada", fuera_de_scope: false }],
  }), {});
  assertEquals(r.errores[0].causa, "no_clasificada");
  assertEquals(r.errores[0].unidad_relacionada, null);
});

// ---------- Plan y datos canónicos ----------
Deno.test("el plan de MC-OPERACIONAL v1.3.0 es válido", () => {
  assertEquals(validarPlan(MC.leccion.plan_ejecucion.pasos), []);
  assertEquals(MC.leccion.ciclo_12_etapas.length, 12);
  assertEquals(MC.leccion.ciclo_12_etapas.map((e) => e.n), [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assertEquals(MC.leccion.plan_ejecucion.etapa_correccion, 17);
});

Deno.test("validarPlan: una producción diferida sin paso de corrección posterior es inválida", () => {
  const sinCorreccion = MC.leccion.plan_ejecucion.pasos.filter((p) => p.tipo !== "correccion");
  assert(validarPlan(sinCorreccion).some((x) => x.includes("ningún paso de corrección")));
});

Deno.test("validarPlan detecta un plan roto", () => {
  const roto = validarPlan([{ paso: "a", etapas: [8], tipo: "produccion" }]);
  assert(roto.length >= 2);
});

// ---------- Petición ----------
const jpeg = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(0)));

Deno.test("imágenes: acepta un JPEG real y rechaza un tipo falsificado", () => {
  assertEquals(validarImagenes([{ media_type: "image/jpeg", base64: jpeg }]).length, 1);
  const e = assertThrows(() => validarImagenes([{ media_type: "image/png", base64: jpeg }]), ErrorApp);
  assertEquals(e.codigo, 307);
});

Deno.test("cuerpo: uuid inválido y acción desconocida → 306", () => {
  assertEquals(assertThrows(() => validarCuerpo('{"accion":"continuar","alumno_idioma_id":"x"}'), ErrorApp).codigo, 306);
  assertEquals(assertThrows(() => validarCuerpo('{"accion":"borrar_todo"}'), ErrorApp).codigo, 306);
  assertEquals(validarCuerpo(`{"accion":"continuar","alumno_idioma_id":"${crypto.randomUUID()}"}`).modo, "estudiante");
});

// ---------- Prompt ----------
Deno.test("prompt estático: principios presentes y sin 'undefined'", () => {
  const t = bloqueEstatico(MC, "español");
  assert(!t.includes("undefined"));
  for (const p of ["P8: ", "P9: ", "P10: "]) {
    const linea = t.split("\n").find((l) => l.includes(p))!;
    assert(linea.split(p)[1].trim().length > 20, `principio ${p} vacío`);
  }
});

Deno.test("prompt: regla fija, ejemplos y explicaciones libres (P8)", () => {
  const t = bloqueEstatico(MC, "español");
  assert(t.includes("DECLARATIVO es fijo") && t.includes("PROCEDIMENTAL es libre") && t.includes("No copies los ejemplos"));
  const [p0, p1] = MC.leccion.plan_ejecucion.pasos;
  assert(bloqueDinamico(MC, { tipo: "presentar", paso: p0, siguiente: p1, incluirSolicitud: true }).includes("al menos 5 ejemplos NUEVOS"));
});

Deno.test("prompt dinámico: la presentación declara evidencia y transformaciones antes de producir", () => {
  const [p0, p1] = MC.leccion.plan_ejecucion.pasos;
  const t = bloqueDinamico(MC, { tipo: "presentar", paso: p0, siguiente: p1, incluirSolicitud: true });
  assert(t.includes("étape 15") && t.includes("étape 14") && t.includes("exercices_n1_n2"));
  assert(t.includes("Transformation — transformar") && t.includes("Phrases — construir"), "descripciones de niveaux de MC-001 §15");
});

// ---------- Autenticación ----------
const clienteFalso = (error: unknown, user: unknown = null) =>
  ({ auth: { getUser: () => Promise.resolve({ data: { user }, error }) } }) as unknown as SupabaseClient;

Deno.test("auth caído → 106 (no culpar al alumno); token inválido → 401", async () => {
  const caido = await assertRejects(() => obtenerUsuarioDelToken(clienteFalso({ name: "AuthRetryableFetchError", status: 0, message: "fetch failed" }), "t"), ErrorApp);
  assertEquals(caido.codigo, 106);
  const malo = await assertRejects(() => obtenerUsuarioDelToken(clienteFalso({ name: "AuthApiError", status: 403, message: "invalid JWT" }), "t"), ErrorApp);
  assertEquals(malo.codigo, 401);
  assertEquals(await obtenerUsuarioDelToken(clienteFalso(null, { id: "u1" }), "t"), { id: "u1" });
});
