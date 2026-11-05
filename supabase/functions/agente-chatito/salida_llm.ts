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
  propietario: z.string().nullable().optional().transform((v) => v ?? null),
});

/** Una étape presentada (cambio 5: una sección por étape, cada texto corto). */
export const SeccionSchema = z.object({
  etapa: z.number().int(),
  titulo: z.string(),
  texto: z.string().min(1),
});
export type Seccion = z.infer<typeof SeccionSchema>;

export const SalidaSolicitudSchema = z.object({
  mensaje_para_alumno: z.string().min(1),
  secciones: z.array(SeccionSchema).default([]),
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
  /** Cambio 13: condiciones de contenido de las formas de evidencia (étape 15). La IA percibe; el código decide. */
  condiciones: z
    .array(z.object({ nivel: z.number().int().nullable(), condicion: z.string().min(1), cumple: z.boolean(), detalle: z.string() }))
    .default([]),
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

/**
 * Cambio 1: algunos modelos escapan dos veces los saltos de línea y envían los
 * caracteres «\» + «n» sueltos. Se convierten en saltos reales en todos los
 * textos de la respuesta. Solo actúa si hay una barra invertida.
 */
export function normalizarTextos(valor: unknown): unknown {
  if (typeof valor === "string") {
    if (!valor.includes("\\")) return valor;
    return valor
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"');
  }
  if (Array.isArray(valor)) return valor.map(normalizarTextos);
  if (valor && typeof valor === "object") {
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, normalizarTextos(v)]));
  }
  return valor;
}

/**
 * Valida contra el esquema; cualquier fallo → código 203 con un fragmento truncado
 * para depurar. contexto.tipo_fallo le dice a la reparación qué hacer (cambio 3):
 *   ilegible = ni siquiera es JSON → repetir desde cero
 *   contrato = JSON válido con campos mal → pedir al modelo que lo corrija
 */
export function parsearSalida<T>(esquema: z.ZodType<T, z.ZodTypeDef, unknown>, texto: string, contexto: Record<string, unknown>): T {
  let crudo: unknown;
  try {
    crudo = extraerJson(texto);
  } catch (e) {
    throw new ErrorApp(203, `JSON ilegible: ${e instanceof Error ? e.message : String(e)}`, {
      ...contexto,
      tipo_fallo: "ilegible",
      fragmento: texto.slice(0, 300),
    });
  }
  const r = esquema.safeParse(normalizarTextos(crudo));
  if (!r.success) {
    const problemas = r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`);
    throw new ErrorApp(203, `JSON fuera de contrato: ${problemas.join(" | ")}`, {
      ...contexto,
      tipo_fallo: "contrato",
      fragmento: texto.slice(0, 300),
    });
  }
  return r.data;
}

/**
 * Alarma del cambio 5: un texto de EXACTAMENTE 4096 caracteres casi seguro es
 * un corte impuesto por el proveedor. Devuelve las rutas sospechosas.
 */
export function camposSospechosos(texto: string, limite = 4096): string[] {
  let crudo: unknown;
  try {
    crudo = extraerJson(texto);
  } catch {
    return [];
  }
  const rutas: string[] = [];
  const recorrer = (v: unknown, ruta: string) => {
    if (typeof v === "string" && v.length === limite) rutas.push(ruta || "(raíz)");
    else if (Array.isArray(v)) v.forEach((x, i) => recorrer(x, `${ruta}[${i}]`));
    else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => recorrer(x, ruta ? `${ruta}.${k}` : k));
  };
  recorrer(crudo, "");
  return rutas;
}

// =====================================================================
// Contratos completos: validación (zod) + esquema JSON estricto que se envía
// al proveedor (mejora A) + ejemplo concreto para el prompt (mejora C).
// Esquemas en formato "strict": todos los campos son obligatorios (los
// opcionales admiten null) y additionalProperties es false. Los rangos
// (mínimos, máximos) los sigue validando zod, porque el modo estricto de
// los proveedores no los admite.
// =====================================================================

export interface Contrato<T> {
  nombre: string;
  zod: z.ZodType<T, z.ZodTypeDef, unknown>;
  json: Record<string, unknown>;
  ejemplo: unknown;
}

const obj = (props: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(props),
  properties: props,
});
const texto = { type: "string" };
const entero = { type: "integer" };
const enteroONulo = { type: ["integer", "null"] };

export const CONTRATO_SOLICITUD: Contrato<SalidaSolicitud> = {
  nombre: "solicitud",
  zod: SalidaSolicitudSchema,
  json: obj({
    mensaje_para_alumno: texto,
    secciones: { type: "array", items: obj({ etapa: entero, titulo: texto, texto: texto }) },
    solicitud: {
      anyOf: [
        { type: "null" },
        obj({
          enunciado: texto,
          niveles: {
            type: "array",
            items: obj({
              nivel: enteroONulo,
              total_pedido: entero,
              unidad_medida: { type: "string", enum: ["ejercicios", "palabras", "frases"] },
            }),
          },
        }),
      ],
    },
  }),
  ejemplo: {
    mensaje_para_alumno: "Formas de evidencia esperadas: … Ahora, los ejercicios.",
    secciones: [
      { etapa: 8, titulo: "Description grammaticale", texto: "…" },
      { etapa: 9, titulo: "Utilisation", texto: "…" },
    ],
    solicitud: {
      enunciado: "Nivel 1: …\n1. …\n2. …\nNivel 2: …\n1. …",
      niveles: [
        { nivel: 1, total_pedido: 8, unidad_medida: "ejercicios" },
        { nivel: 2, total_pedido: 4, unidad_medida: "frases" },
      ],
    },
  },
};

export const CONTRATO_EVALUACION: Contrato<SalidaEvaluacion> = {
  nombre: "evaluacion",
  zod: SalidaEvaluacionSchema,
  json: obj({
    mensaje_para_alumno: texto,
    transcripcion: texto,
    niveles: {
      type: "array",
      items: obj({ nivel: enteroONulo, total_entregado: entero, items_evaluados: entero, items_correctos: entero }),
    },
    errores: {
      type: "array",
      items: obj({
        fragmento: texto,
        correccion: texto,
        causa: { type: "string", enum: [...CAUSAS] },
        explicacion: texto,
        fuera_de_scope: { type: "boolean" },
        unidad_relacionada: { type: ["string", "null"] },
        nivel: enteroONulo,
        propietario: { type: ["string", "null"] },
      }),
    },
    condiciones: {
      type: "array",
      items: obj({ nivel: enteroONulo, condicion: texto, cumple: { type: "boolean" }, detalle: texto }),
    },
  }),
  ejemplo: {
    mensaje_para_alumno: "Recibí tus respuestas…",
    transcripcion: "1. …\n2. …",
    niveles: [{ nivel: 1, total_entregado: 8, items_evaluados: 8, items_correctos: 7 }],
    errores: [{
      fragmento: "…",
      correccion: "…",
      causa: "generalisation_excessive",
      explicacion: "…",
      fuera_de_scope: false,
      unidad_relacionada: null,
      nivel: 1,
      propietario: null,
    }],
    condiciones: [{ nivel: 3, condicion: "al menos 2 plurales irregulares", cumple: false, detalle: "solo hay 1: …" }],
  },
};

export const CONTRATO_CORRECCION: Contrato<SalidaCorreccion> = {
  nombre: "correccion",
  zod: SalidaCorreccionSchema,
  json: obj({ mensaje_para_alumno: texto, transcripcion: texto, indices_corregidos: { type: "array", items: entero } }),
  ejemplo: { mensaje_para_alumno: "Corregiste bien los puntos 0 y 2…", transcripcion: "…", indices_corregidos: [0, 2] },
};

export const CONTRATO_MENSAJE: Contrato<z.infer<typeof SalidaMensajeSchema>> = {
  nombre: "mensaje",
  zod: SalidaMensajeSchema,
  json: obj({ mensaje_para_alumno: texto }),
  ejemplo: { mensaje_para_alumno: "Corrección détaillée: 1) … → … porque …" },
};
