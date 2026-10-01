// salida_llm.ts — Contratos de salida del agente y su validación.
//
// División de responsabilidades:
//   el LLM PERCIBE  → transcribe, cuenta lo entregado, detecta errores, diagnostica
//   el CÓDIGO DECIDE → umbral 80%/100%, avance de étape, estado de la unidad
// Los totales pedidos los fija el sistema al registrar la solicitud; en la
// evaluación el LLM solo reporta lo ENTREGADO y lo CORRECTO.

import { z } from "npm:zod@3.23.8";
import { ErrorApp } from "./errores.ts";

/** Causas de MC-002 §15 (en snake_case). */
export const CAUSAS = [
  "connaissance_non_acquise",
  "connaissance_partielle",
  "confusion_structures",
  "generalisation_excessive",
  "interference_autre_langue",
  "automatisme_incorrect",
  "surcharge_cognitive",
  "oubli",
  "manque_vocabulaire",
  "registre",
  "comprehension_consigne",
  "no_clasificada",
] as const;

const ErrorDetectadoSchema = z.object({
  fragmento: z.string(),
  correccion: z.string(),
  causa: z.enum(CAUSAS).catch("no_clasificada"),
  explicacion: z.string().default(""),
  fuera_de_scope: z.boolean(),
  unidad_relacionada: z.string().nullable().optional().transform((v) => v ?? null),
  nivel: z.number().int().nullable().optional().transform((v) => v ?? null),
});

export const SalidaSolicitudSchema = z.object({
  mensaje_para_alumno: z.string().min(1),
  solicitud: z
    .object({
      enunciado: z.string().min(1),
      niveles: z
        .array(
          z.object({
            nivel: z.number().int().min(1).max(3).nullable(),
            total_pedido: z.number().int().positive().max(500),
            unidad_medida: z.enum(["ejercicios", "palabras", "frases"]),
          }),
        )
        .min(1),
    })
    .nullable(),
});

export const SalidaEvaluacionSchema = z.object({
  mensaje_para_alumno: z.string().min(1),
  transcripcion: z.string(),
  niveles: z
    .array(
      z.object({
        nivel: z.number().int().nullable(),
        total_entregado: z.number().int().min(0),
        items_evaluados: z.number().int().min(0),
        items_correctos: z.number().int().min(0),
      }),
    )
    .min(1),
  errores: z.array(ErrorDetectadoSchema).default([]),
});

export const SalidaCorreccionSchema = z.object({
  mensaje_para_alumno: z.string().min(1),
  transcripcion: z.string(),
  indices_corregidos: z.array(z.number().int().min(0)).default([]),
});

/** Tarea «corregir»: el agente solo redacta la corrección; el sistema ya tiene los errores. */
export const SalidaMensajeSchema = z.object({ mensaje_para_alumno: z.string().min(1) });

export type SalidaSolicitud = z.infer<typeof SalidaSolicitudSchema>;
export type SalidaEvaluacion = z.infer<typeof SalidaEvaluacionSchema>;
export type SalidaCorreccion = z.infer<typeof SalidaCorreccionSchema>;

/**
 * Extrae el primer objeto JSON de un texto. Tolera lo que suelen hacer los
 * modelos gratuitos: envolver en ```json, o añadir prosa antes/después.
 */
export function extraerJson(texto: string): unknown {
  const sinCercas = texto.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(sinCercas);
  } catch {
    // continuar con la búsqueda de llaves
  }
  const inicio = sinCercas.indexOf("{");
  if (inicio < 0) throw new Error("no hay ningún objeto JSON en la respuesta");
  let profundidad = 0;
  let enCadena = false;
  let escape = false;
  for (let i = inicio; i < sinCercas.length; i++) {
    const c = sinCercas[i];
    if (enCadena) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') enCadena = false;
      continue;
    }
    if (c === '"') enCadena = true;
    else if (c === "{") profundidad++;
    else if (c === "}") {
      profundidad--;
      if (profundidad === 0) return JSON.parse(sinCercas.slice(inicio, i + 1));
    }
  }
  throw new Error("objeto JSON sin cerrar");
}

/** Valida contra el esquema; cualquier fallo → código 203 con un fragmento truncado para depurar. */
export function parsearSalida<T>(esquema: z.ZodType<T, z.ZodTypeDef, unknown>, texto: string, contexto: Record<string, unknown>): T {
  let crudo: unknown;
  try {
    crudo = extraerJson(texto);
  } catch (e) {
    throw new ErrorApp(203, `JSON ilegible: ${e instanceof Error ? e.message : String(e)}`, {
      ...contexto,
      fragmento: texto.slice(0, 300),
    });
  }
  const r = esquema.safeParse(crudo);
  if (!r.success) {
    const problemas = r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`);
    throw new ErrorApp(203, `JSON fuera de contrato: ${problemas.join(" | ")}`, {
      ...contexto,
      fragmento: texto.slice(0, 300),
    });
  }
  return r.data;
}
