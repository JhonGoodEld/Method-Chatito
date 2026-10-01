// reactivacion.ts — Motor de prioridad de reactivación, MC-006 §15bis (módulo PURO).
//
// PRINCIPIO NO NEGOCIABLE (MC-006 §26, MC-002 §29): este módulo solo produce
// una SUGERENCIA. Nunca modifica el estado de una unidad. El estado solo cambia
// con evidencia nueva observada durante una reactivación real.
//
// El azar NO es una señal sumada: es un sorteo independiente (MC-006 §15bis.1).

import { dependientesTransitivos } from "./secuenciacion.ts";
import type { FilaEvidencia, FilaEstadoUnidad, Grafo, LeccionDeclarada } from "./tipos.ts";

export interface ParametrosMotor {
  w_errores: number;
  w_dependencia: number;
  w_tiempo: number;
  tope_errores: number;
  tope_profundidad: number;
  tau_dias: number;
  umbral_disparo: number;
  p_azar: number;
}

export interface Senales {
  erroresRelacionados: number;
  profundidad: number;
  dias: number;
}

export type ModoMotor = "estudiante" | "grupo";

const normalizar = (x: number, tope: number) => (tope > 0 ? Math.min(Math.max(x, 0) / tope, 1) : 0);
const curvaCreciente = (dias: number, tau: number) => (tau > 0 ? 1 - Math.exp(-Math.max(dias, 0) / tau) : 0);

/** Pesos efectivos. En modo grupo no existe evidencia individual: w_errores = 0 y se renormaliza. */
export function pesosEfectivos(p: ParametrosMotor, modo: ModoMotor) {
  if (modo === "estudiante") return { e: p.w_errores, d: p.w_dependencia, t: p.w_tiempo };
  const suma = p.w_dependencia + p.w_tiempo;
  return suma > 0 ? { e: 0, d: p.w_dependencia / suma, t: p.w_tiempo / suma } : { e: 0, d: 0, t: 0 };
}

export function calcularPrioridad(s: Senales, p: ParametrosMotor, modo: ModoMotor = "estudiante"): number {
  const w = pesosEfectivos(p, modo);
  return (
    w.e * normalizar(s.erroresRelacionados, p.tope_errores) +
    w.d * normalizar(s.profundidad, p.tope_profundidad) +
    w.t * curvaCreciente(s.dias, p.tau_dias)
  );
}

/** Errores de lecciones POSTERIORES que el diagnóstico atribuyó a cada unidad. */
export function contarErroresRelacionados(evidencias: FilaEvidencia[]): Map<string, number> {
  const conteo = new Map<string, number>();
  for (const ev of evidencias) {
    for (const d of ev.diagnosticos ?? []) {
      const u = d.unidad_relacionada;
      if (u && u !== ev.unidad_id) conteo.set(u, (conteo.get(u) ?? 0) + 1);
    }
  }
  return conteo;
}

export interface ResultadoMotor {
  tipo: "hasard" | "prioridad" | "ninguna";
  unidadId?: string;
  prioridad?: number;
  desglose?: Array<{ unidadId: string; prioridad: number; senales: Senales }>;
}

export function evaluarMotor(args: {
  grafo: Grafo;
  lecciones: LeccionDeclarada[];
  estados: FilaEstadoUnidad[];
  evidencias: FilaEvidencia[];
  excluir: string | null;
  ahora: Date;
  parametros: ParametrosMotor;
  modo?: ModoMotor;
  aleatorio?: () => number;
}): ResultadoMotor {
  const aleatorio = args.aleatorio ?? Math.random;
  const modo = args.modo ?? "estudiante";
  const dominioDe = new Map(args.lecciones.map((l) => [l.unidad_id, l.dominio_id]));
  const ensenadas = args.estados.filter((e) => e.estado === "acquis" || e.estado === "consolide");
  const candidatos = ensenadas.filter((e) => e.unidad_id !== args.excluir && dominioDe.has(e.unidad_id));
  if (candidatos.length === 0) return { tipo: "ninguna" };

  // Sorteo independiente (MC-006 §11 / §15bis.1).
  if (aleatorio() < args.parametros.p_azar) {
    const elegido = candidatos[Math.floor(aleatorio() * candidatos.length) % candidatos.length];
    return { tipo: "hasard", unidadId: elegido.unidad_id };
  }

  const errores = contarErroresRelacionados(args.evidencias);
  const ultimaEvidencia = new Map<string, number>();
  for (const ev of args.evidencias) {
    const t = Date.parse(ev.creado_en);
    if (!Number.isNaN(t) && t > (ultimaEvidencia.get(ev.unidad_id) ?? 0)) ultimaEvidencia.set(ev.unidad_id, t);
  }

  const desglose = candidatos.map((c) => {
    const dominio = dominioDe.get(c.unidad_id)!;
    const alcance = dependientesTransitivos(args.grafo, dominio);
    alcance.add(dominio);
    const completadaEn = Date.parse(c.actualizado_en);
    // Profundidad de rama (MC-006 §12): lecciones de la misma rama o de ramas
    // dependientes que se enseñaron DESPUÉS de esta.
    const profundidad = ensenadas.filter(
      (o) =>
        o.unidad_id !== c.unidad_id &&
        alcance.has(dominioDe.get(o.unidad_id) ?? "") &&
        Date.parse(o.actualizado_en) > completadaEn,
    ).length;
    const referencia = ultimaEvidencia.get(c.unidad_id) ?? completadaEn;
    const dias = Number.isNaN(referencia) ? 0 : (args.ahora.getTime() - referencia) / 86_400_000;
    const senales: Senales = { erroresRelacionados: errores.get(c.unidad_id) ?? 0, profundidad, dias };
    return { unidadId: c.unidad_id, prioridad: calcularPrioridad(senales, args.parametros, modo), senales };
  });

  desglose.sort((a, b) => b.prioridad - a.prioridad);
  const mejor = desglose[0];
  if (mejor.prioridad >= args.parametros.umbral_disparo) {
    return { tipo: "prioridad", unidadId: mejor.unidadId, prioridad: mejor.prioridad, desglose };
  }
  return { tipo: "ninguna", desglose };
}
