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

/**
 * Cambio 15: palabras contadas por el código, no por la IA (que se equivocaba ±10).
 * Ignora lo que va entre corchetes (marcas como «[ilegible]») y los signos sueltos.
 */
export function contarPalabras(texto: string): number {
  return texto
    .replace(/\[[^\]]*\]/g, " ")
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .length;
}

/**
 * Cambio 15: un paso de un solo nivel medido en palabras es UN texto (étape 16):
 * cada entrega es el texto completo y reemplaza a la anterior.
 */
export function esTextoUnico(niveles: Array<{ unidad_medida: string }> | undefined): boolean {
  return niveles?.length === 1 && niveles[0].unidad_medida === "palabras";
}

/**
 * Cambio 18: un «error» cuya corrección es idéntica al fragmento no es un error.
 * Solo se ignoran los espacios y la puntuación de los extremos; las mayúsculas
 * SÍ cuentan («i mean» → «I mean» es un error real en inglés).
 */
export function esErrorReal(e: { fragmento: string; correccion: string }): boolean {
  const limpiar = (t: string) =>
    t.normalize("NFC").replace(/\s+/g, " ").trim().replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "");
  return limpiar(e.fragmento) !== limpiar(e.correccion);
}

/** Cambio 17: la lista de pendientes la arma el código, completa y numerada. */
export function listaPendientes(errores: Array<{ indice: number; fragmento: string; tema?: string }>): string {
  const item = (e: { indice: number; fragmento: string; tema?: string }) =>
    `[${e.indice}] «${e.fragmento}»${e.tema ? ` (tema ${e.tema})` : ""}`;
  return `Pendientes (${errores.length}): ${errores.map(item).join(" · ")}. Reescribe cada uno.`;
}

/**
 * Cambio 19: errores fuera del alcance, mostrados sin evaluar ni exigir reescritura.
 * Sin duplicados; como mucho `max` para no saturar al alumno.
 */
export function notaObservaciones(obs: Array<{ fragmento: string; correccion: string; destino?: string }>, max = 10): string {
  const vistos = new Set<string>();
  const unicas = obs.filter((o) => {
    const clave = `${o.fragmento}→${o.correccion}`;
    return vistos.has(clave) ? false : (vistos.add(clave), true);
  });
  if (unicas.length === 0) return "";
  const resto = unicas.length - max;
  return `Además observé errores de otros temas (no se evalúan ni hay que reescribirlos): ` +
    unicas.slice(0, max).map((o) => `«${o.fragmento}» → «${o.correccion}»${o.destino ? ` (se corregirá en ${o.destino})` : ""}`).join(" · ") +
    (resto > 0 ? ` (+${resto} más)` : "") + ".";
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
