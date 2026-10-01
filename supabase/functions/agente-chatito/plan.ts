// plan.ts — Navegación del plan de ejecución de MC-001 (módulo PURO).
// El plan vive en MC-OPERACIONAL.leccion.plan_ejecucion: cambiar el orden de
// entrega de las étapes = editar el JSON, no este código.

import { ErrorApp } from "./errores.ts";
import type { EtapaCiclo, PasoPlan } from "./tipos.ts";

/** Devuelve la lista de problemas del plan (vacía = válido). */
export function validarPlan(pasos: PasoPlan[]): string[] {
  const p: string[] = [];
  if (!Array.isArray(pasos) || pasos.length === 0) return ["plan vacío"];
  const nombres = new Set<string>();
  pasos.forEach((paso, i) => {
    if (!paso.paso) p.push(`paso ${i} sin nombre`);
    if (nombres.has(paso.paso)) p.push(`paso duplicado: ${paso.paso}`);
    nombres.add(paso.paso);
    if (!Array.isArray(paso.etapas) || paso.etapas.length === 0) p.push(`${paso.paso}: sin étapes`);
    if (paso.tipo === "produccion") {
      if (!paso.niveles || paso.niveles.length === 0) p.push(`${paso.paso}: producción sin niveles`);
      if (paso.categoria !== "guiada" && paso.categoria !== "libre") p.push(`${paso.paso}: categoría inválida`);
      if (paso.correccion !== "diferida" && paso.correccion !== "inmediata") {
        p.push(`${paso.paso}: correccion debe ser "diferida" o "inmediata"`);
      }
    } else if (paso.tipo === "correccion") {
      if (!paso.fuentes?.length) p.push(`${paso.paso}: paso de corrección sin fuentes`);
      for (const f of paso.fuentes ?? []) {
        const origen = pasos.findIndex((x) => x.paso === f);
        if (origen < 0 || origen > i || pasos[origen].correccion !== "diferida") {
          p.push(`${paso.paso}: fuente inválida ${f} (debe ser un paso anterior con corrección diferida)`);
        }
      }
    } else if (paso.tipo !== "presentacion") {
      p.push(`${paso.paso}: tipo inválido`);
    }
  });
  // Toda producción diferida debe quedar cubierta por un paso de corrección posterior.
  pasos.forEach((paso, i) => {
    if (paso.correccion !== "diferida") return;
    const cubierta = pasos.slice(i + 1).some((x) => x.tipo === "correccion" && x.fuentes?.includes(paso.paso));
    if (!cubierta) p.push(`${paso.paso}: corrección diferida que ningún paso de corrección posterior recoge`);
  });
  const cierres = pasos.filter((x) => x.cierra_unidad);
  if (cierres.length !== 1) p.push("debe existir exactamente un paso que cierra la unidad");
  else if (pasos[pasos.length - 1] !== cierres[0]) p.push("el paso de cierre debe ser el último");
  if (cierres[0] && cierres[0].tipo !== "presentacion") p.push("el paso de cierre debe ser de presentación");
  if (pasos[0].tipo !== "presentacion") p.push("el primer paso debe ser de presentación (MC-001: declarar antes de producir)");
  return p;
}

export function pasoPorNombre(pasos: PasoPlan[], nombre: string | null): PasoPlan {
  const paso = pasos.find((x) => x.paso === nombre);
  if (!paso) throw new ErrorApp(598, `Paso desconocido en la sesión: ${nombre}`);
  return paso;
}

export function siguientePaso(pasos: PasoPlan[], actual: PasoPlan): PasoPlan | null {
  const i = pasos.indexOf(actual);
  return i >= 0 && i < pasos.length - 1 ? pasos[i + 1] : null;
}

export function describirEtapas(ciclo: EtapaCiclo[], numeros: number[]): string {
  return numeros
    .map((n) => {
      const e = ciclo.find((x) => x.n === n);
      return e ? `${n}. ${e.nombre}` : `${n}. (étape desconocida)`;
    })
    .join(", ");
}
