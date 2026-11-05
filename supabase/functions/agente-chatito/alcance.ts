// alcance.ts — Tratamiento de los errores fuera del alcance (MC-001 v1.0.4 §7.5, MC-002 v1.2.0 §16).
//
// Funciones puras: el flujo les pasa el grafo, las lecciones declaradas y los
// estados del alumno, y ellas deciden. Tres tratamientos según el propietario:
//   corregir_ahora → propietario ya estudiado: se corrige en la étape 17 en curso
//   diferir        → aún no estudiado: observación ahora, corrección en su lección
//   observar       → transversal, sin propietario o inexistente en el grafo

import type { DominioGrafo, FilaEstadoUnidad, Grafo, LeccionDeclarada } from "./tipos.ts";

export type Tratamiento = "corregir_ahora" | "diferir" | "observar";

/** Extrae el identificador del grafo de lo que copió la IA ("EN-510 — Le verbe" → "EN-510"). */
export function normalizarPropietario(texto: string | null | undefined): string | null {
  return texto?.match(/\b([A-Z]{2}-\d{3})\b/)?.[1] ?? null;
}

/** ¿La lección pertenece al propietario? (es la lección misma, o está en su sous-domaine o dominio) */
export function perteneceA(
  leccion: Pick<LeccionDeclarada, "unidad_id" | "sous_domaine_id" | "dominio_id">,
  propietario: string,
): boolean {
  return leccion.unidad_id === propietario || leccion.sous_domaine_id === propietario || leccion.dominio_id === propietario;
}

/** Dominio del grafo al que pertenece un identificador (dominio, sous-domaine o lección). */
function dominioDelPropietario(grafo: Grafo, lecciones: LeccionDeclarada[], id: string): DominioGrafo | null {
  const directo = grafo.dominios.find((d) => d.id === id || d.sous_domaines?.includes(id));
  if (directo) return directo;
  const leccion = lecciones.find((l) => l.unidad_id === id);
  if (leccion) return grafo.dominios.find((d) => d.id === leccion.dominio_id) ?? null;
  // Lección aún no declarada en «livrables» (p. ej. EN-412): su sous-domaine por convención (EN-410).
  const sous = id.replace(/\d$/, "0");
  return sous !== id ? grafo.dominios.find((d) => d.sous_domaines?.includes(sous)) ?? null : null;
}

export function clasificarFueraDeAlcance(
  propietario: string | null,
  datos: { grafo: Grafo; lecciones: LeccionDeclarada[]; estados: FilaEstadoUnidad[] },
): Tratamiento {
  if (!propietario) return "observar";
  const dominio = dominioDelPropietario(datos.grafo, datos.lecciones, propietario);
  if (!dominio || dominio.nature === "transversal") return "observar";
  const estudiadas = new Set(
    datos.estados.filter((e) => e.estado === "acquis" || e.estado === "consolide").map((e) => e.unidad_id),
  );
  const delPropietario = datos.lecciones.filter((l) => perteneceA(l, propietario));
  return delPropietario.length > 0 && delPropietario.every((l) => estudiadas.has(l.unidad_id)) ? "corregir_ahora" : "diferir";
}
