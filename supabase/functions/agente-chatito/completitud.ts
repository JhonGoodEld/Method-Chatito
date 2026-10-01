// completitud.ts — Umbrales de avance (módulo PURO).
//   Producción inicial: mínimo = techo(total × factor)   (factor = 0.8)
//   Corrección:         100% de los errores señalados
//
// OJO con la coma flotante: con el factor actual (0.8) Math.ceil(n * 0.8) es
// exacto, pero el factor es CALIBRABLE y 10 de los 100 valores entre 0.01 y
// 1.00 fallan: p. ej. 450 * 0.54 = 243.00000000000003 → Math.ceil exigiría 244.
// Por eso se calcula con enteros (puntos básicos), que es exacto siempre.

import { ErrorApp } from "./errores.ts";

export function minimoRequerido(totalPedido: number, factor: number): number {
  if (!Number.isInteger(totalPedido) || totalPedido <= 0) {
    throw new ErrorApp(306, `total_pedido inválido: ${totalPedido}`);
  }
  if (!(factor > 0 && factor <= 1)) throw new ErrorApp(598, `factor de completitud inválido: ${factor}`);
  const puntosBasicos = Math.round(factor * 10_000);
  return Math.floor((totalPedido * puntosBasicos + 9_999) / 10_000);
}

export interface EntregaNivel {
  nivel: number | null;
  total_pedido: number;
  total_entregado: number;
}

export interface ResultadoCompletitud {
  cumple: boolean;
  detalle: Array<{ nivel: number | null; minimo: number; entregado: number; pedido: number; cumple: boolean }>;
}

/** Cada nivel se evalúa por separado: cada conjunto pedido es un requerimiento propio. */
export function evaluarProduccion(niveles: EntregaNivel[], factor: number): ResultadoCompletitud {
  if (niveles.length === 0) throw new ErrorApp(306, "sin niveles que evaluar");
  const detalle = niveles.map((n) => {
    const minimo = minimoRequerido(n.total_pedido, factor);
    const entregado = Math.max(0, Math.floor(n.total_entregado));
    return { nivel: n.nivel, minimo, entregado, pedido: n.total_pedido, cumple: entregado >= minimo };
  });
  return { cumple: detalle.every((d) => d.cumple), detalle };
}

/** 100% de lo señalado. Índices corregidos que no fueron señalados se ignoran. */
export function evaluarCorreccion(
  indicesSenalados: number[],
  indicesCorregidos: number[],
): { completa: boolean; pendientes: number[]; corregidos: number } {
  const corregidos = new Set(indicesCorregidos);
  const pendientes = indicesSenalados.filter((i) => !corregidos.has(i));
  return {
    completa: pendientes.length === 0,
    pendientes,
    corregidos: indicesSenalados.length - pendientes.length,
  };
}
