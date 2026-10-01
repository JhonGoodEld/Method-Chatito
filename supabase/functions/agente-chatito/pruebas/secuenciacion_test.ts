import { assert, assertEquals, assertThrows } from "./afirmar.ts";
import { GRAFOS, MC } from "../config.ts";
import { ErrorApp } from "../errores.ts";
import { decidirSiguiente, type EntradaSecuenciacion, potencialExpansion } from "../secuenciacion.ts";
import type { Grafo, LeccionDeclarada } from "../tipos.ts";
import { leccion } from "./dobles.ts";

const POLITICA = MC.secuenciacion.politica_desempate_declarada.criterios_en_orden;

function decidir(grafo: Grafo, lecciones: LeccionDeclarada[], ensenadas: string[], extra: Partial<EntradaSecuenciacion> = {}) {
  return decidirSiguiente({
    grafo, lecciones, ensenadas: new Set(ensenadas), pila: [], ramaActiva: null, politicaDesempate: POLITICA, ...extra,
  });
}

const FR = [
  leccion("FR-411", "FR-400", "FR-410", 1),
  leccion("FR-412", "FR-400", "FR-410", 2),
  leccion("FR-421", "FR-400", "FR-420", 1),
  leccion("FR-531", "FR-500", "FR-530", 1),
];

Deno.test("potencial de expansión derivado de los grafos reales", () => {
  const pot = (g: Grafo, id: string) => potencialExpansion(g, id);
  assertEquals([pot(GRAFOS.FR, "FR-300"), pot(GRAFOS.FR, "FR-400"), pot(GRAFOS.FR, "FR-500"), pot(GRAFOS.FR, "FR-800")], [5, 4, 3, 0]);
  assertEquals(pot(GRAFOS.EN, "EN-400"), 4);
  assertEquals([pot(GRAFOS.KO, "KO-400"), pot(GRAFOS.KO, "KO-500"), pot(GRAFOS.KO, "KO-600")], [3, 3, 2]);
});

Deno.test("MC-009 §21: el primer nodo válido del francés es FR-411 (no FR-531)", () => {
  const r = decidir(GRAFOS.FR, FR, []);
  assertEquals(r.tipo, "leccion");
  if (r.tipo === "leccion") {
    assertEquals(r.unidadId, "FR-411");
    assert(r.justificacion.some((j) => j.includes("potencial")));
    assertEquals(r.desempateAplicado, false);
  }
});

Deno.test("progresión vertical: FR-411 → FR-412 → FR-421 (sous-domaine declarado antes)", () => {
  const a = decidir(GRAFOS.FR, FR, ["FR-411"], { ramaActiva: "FR-400" });
  const b = decidir(GRAFOS.FR, FR, ["FR-411", "FR-412"], { ramaActiva: "FR-400" });
  assertEquals(a.tipo === "leccion" && a.unidadId, "FR-412");
  assertEquals(b.tipo === "leccion" && b.unidadId, "FR-421");
});

Deno.test("rama agotada: FR-400 completo abre FR-500 (FR-531)", () => {
  const r = decidir(GRAFOS.FR, FR, ["FR-411", "FR-412", "FR-421"], { ramaActiva: "FR-400" });
  assertEquals(r.tipo === "leccion" && r.unidadId, "FR-531");
});

Deno.test("falta de contenido BLOQUEA en vez de saltar de rama (Principio 7)", () => {
  const conHueco = FR.map((l) => (l.unidad_id === "FR-412" ? { ...l, estado_redaccion: "declarado" as const } : l));
  const r = decidir(GRAFOS.FR, conHueco, ["FR-411"], { ramaActiva: "FR-400" });
  assertEquals(r.tipo, "bloqueado");
  if (r.tipo === "bloqueado") {
    assertEquals(r.razon, "leccion_sin_redactar");
    assertEquals(r.unidadId, "FR-412");
  }
});

Deno.test("dominio sin lecciones declaradas nunca se considera agotado", () => {
  const r = decidir(GRAFOS.FR, [], []);
  assertEquals(r.tipo === "bloqueado" && r.razon, "dominio_sin_lecciones_declaradas");
  assertEquals(r.tipo === "bloqueado" && r.dominioId, "FR-400");
});

const KO = (extra: Record<string, Partial<LeccionDeclarada>> = {}) => [
  leccion("KO-311", "KO-300", "KO-310", 1, extra["KO-311"]),
  leccion("KO-411", "KO-400", "KO-410", 1, extra["KO-411"]),
  leccion("KO-412", "KO-400", "KO-410", 2, extra["KO-412"]),
  leccion("KO-511", "KO-500", "KO-510", 1, extra["KO-511"]),
  leccion("KO-512", "KO-500", "KO-510", 2, extra["KO-512"]),
];

Deno.test("empate KO-400/KO-500: la política declarada prefiere la rama con contenido", () => {
  const r = decidir(GRAFOS.KO, KO({ "KO-411": { estado_redaccion: "declarado" } }), []);
  assertEquals(r.tipo === "leccion" && r.unidadId, "KO-511");
  assertEquals(r.tipo === "leccion" && r.desempateAplicado, true);
  assert(r.justificacion.some((j) => j.includes("contenido_disponible")));
});

Deno.test("empate KO sin diferencia de contenido: orden de declaración de la arquitectura", () => {
  const r = decidir(GRAFOS.KO, KO(), []);
  assertEquals(r.tipo === "leccion" && r.unidadId, "KO-411");
  assert(r.justificacion.some((j) => j.includes("orden_declaracion_arquitectura")));
});

Deno.test("desvío (§13–§15): pausa la rama, enseña el prerrequisito y reanuda", () => {
  const lecciones = KO({ "KO-412": { prerequis: ["KO-511"] } });
  const ida = decidir(GRAFOS.KO, lecciones, ["KO-411"], { ramaActiva: "KO-400" });
  assertEquals(ida.tipo === "leccion" && ida.unidadId, "KO-511");
  assertEquals(ida.pila, ["KO-400"]);

  const vuelta = decidir(GRAFOS.KO, lecciones, ["KO-411", "KO-511"], { ramaActiva: "KO-500", pila: ["KO-400"] });
  assertEquals(vuelta.tipo === "leccion" && vuelta.unidadId, "KO-412");
  assertEquals(vuelta.pila, []);
});

Deno.test("desvío anidado (§14): la pila crece y se deshace en orden LIFO", () => {
  const lecciones = KO({ "KO-412": { prerequis: ["KO-511"] }, "KO-511": { prerequis: ["KO-311"] } });
  const r1 = decidir(GRAFOS.KO, lecciones, ["KO-411"], { ramaActiva: "KO-400" });
  assertEquals(r1.tipo === "leccion" && r1.unidadId, "KO-311");
  assertEquals(r1.pila, ["KO-400", "KO-500"]);

  const r2 = decidir(GRAFOS.KO, lecciones, ["KO-411", "KO-311"], { ramaActiva: "KO-300", pila: r1.pila });
  assertEquals(r2.tipo === "leccion" && r2.unidadId, "KO-511");
  assertEquals(r2.pila, ["KO-400"]);

  const r3 = decidir(GRAFOS.KO, lecciones, ["KO-411", "KO-311", "KO-511"], { ramaActiva: "KO-500", pila: r2.pila });
  assertEquals(r3.tipo === "leccion" && r3.unidadId, "KO-412");
  assertEquals(r3.pila, []);
});

Deno.test("un bloqueo no persiste cambios parciales de la pila", () => {
  const lecciones = KO({ "KO-412": { prerequis: ["KO-511"] }, "KO-511": { estado_redaccion: "declarado" } });
  const r = decidir(GRAFOS.KO, lecciones, ["KO-411"], { ramaActiva: "KO-400" });
  assertEquals(r.tipo, "bloqueado");
  assertEquals(r.pila, []);
});

Deno.test("prerrequisitos contradictorios con el grafo → 309 (ciclo)", () => {
  const contradictorio = FR.map((l) => (l.unidad_id === "FR-412" ? { ...l, prerequis: ["FR-531"] } : l));
  const e = assertThrows(() => decidir(GRAFOS.FR, contradictorio, ["FR-411"], { ramaActiva: "FR-400" }), ErrorApp);
  assertEquals(e.codigo, 309);
});

Deno.test("grafo con ciclo o prerrequisito inexistente → 309", () => {
  const ciclo: Grafo = { idioma: "XX", dominios: [
    { id: "A", nature: "sequentiel", prerequis: ["B"] },
    { id: "B", nature: "sequentiel", prerequis: ["A"] },
  ] };
  assertEquals(assertThrows(() => decidir(ciclo, [], []), ErrorApp).codigo, 309);
  const huerfano: Grafo = { idioma: "XX", dominios: [{ id: "A", nature: "sequentiel", prerequis: ["Z"] }] };
  assertEquals(assertThrows(() => decidir(huerfano, [], []), ErrorApp).codigo, 309);
});

Deno.test("currículo completado cuando todos los secuenciales están agotados", () => {
  const g: Grafo = { idioma: "XX", dominios: [
    { id: "T", nature: "transversal", prerequis: [] },
    { id: "A", nature: "sequentiel", prerequis: ["T"] },
  ] };
  const r = decidir(g, [leccion("A-1", "A", null, 1)], ["A-1"], { ramaActiva: "A" });
  assertEquals(r.tipo, "curriculo_completado");
});
