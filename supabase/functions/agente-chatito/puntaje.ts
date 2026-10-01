// puntaje.ts — score_lecon (MC-002 §17bis), módulo PURO.
//
// NO es la evaluación pedagógica (MC-002 §17 prohíbe la nota aditiva): es una
// señal de entrada acotada para el motor de reactivación de MC-006.
//
// Regla v1 (MC-OPERACIONAL.evidencia_y_estado.puntaje_leccion.regla_de_calculo_v1):
//  - por cada (paso, nivel) se toma la última evidencia ANTERIOR a la corrección;
//  - guiada: correctos / total_pedido (denominador del sistema, no del LLM);
//  - libre:  correctos / ocurrencias del objetivo (items_evaluados);
//  - si una categoría no tiene datos, se renormalizan los pesos.

import type { FilaEvidencia } from "./tipos.ts";

export interface PesosPuntaje {
  peso_produccion_espontanea: number;
  peso_produccion_guiada: number;
}

export function calcularPuntaje(evidencias: FilaEvidencia[], pesos: PesosPuntaje): number | null {
  // Última evidencia pre-corrección por (paso, nivel).
  const ultimas = new Map<string, FilaEvidencia>();
  for (const ev of [...evidencias].sort((a, b) => a.creado_en.localeCompare(b.creado_en))) {
    const m = ev.metricas;
    if (!m || m.intento === "correccion" || !m.categoria) continue;
    ultimas.set(`${m.paso}|${ev.nivel_ejercicio ?? "-"}`, ev);
  }

  const acumulado = { guiada: { num: 0, den: 0 }, libre: { num: 0, den: 0 } };
  for (const ev of ultimas.values()) {
    const m = ev.metricas;
    const correctos = Math.max(0, m.items_correctos ?? 0);
    if (m.categoria === "guiada") {
      const den = m.total_pedido ?? 0;
      if (den > 0) {
        acumulado.guiada.num += Math.min(correctos, den);
        acumulado.guiada.den += den;
      }
    } else if (m.categoria === "libre") {
      const den = m.items_evaluados ?? 0;
      if (den > 0) {
        acumulado.libre.num += Math.min(correctos, den);
        acumulado.libre.den += den;
      }
    }
  }

  const partes: Array<{ peso: number; ratio: number }> = [];
  if (acumulado.libre.den > 0) {
    partes.push({ peso: pesos.peso_produccion_espontanea, ratio: acumulado.libre.num / acumulado.libre.den });
  }
  if (acumulado.guiada.den > 0) {
    partes.push({ peso: pesos.peso_produccion_guiada, ratio: acumulado.guiada.num / acumulado.guiada.den });
  }
  if (partes.length === 0) return null;
  const sumaPesos = partes.reduce((s, p) => s + p.peso, 0);
  if (sumaPesos <= 0) return null;
  const valor = (100 * partes.reduce((s, p) => s + p.peso * p.ratio, 0)) / sumaPesos;
  return Math.round(valor * 100) / 100;
}
