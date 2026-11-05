// config.ts — Datos canónicos empaquetados + parámetros de infraestructura.
//
// Regla: los parámetros PEDAGÓGICOS (pesos, umbrales, plan de étapes) viven en
// MC-OPERACIONAL.json — fuente única (Principio 1). Aquí solo quedan los
// parámetros de INFRAESTRUCTURA (límites, tiempos, tamaños).
//
// Los secrets se leen de forma perezosa (funciones), nunca al importar el
// módulo: así las pruebas no necesitan variables de entorno y un secret
// ausente produce un error con código (598/205), no un fallo opaco.

import mcJson from "./MC-OPERACIONAL.json" with { type: "json" };
import enGrafo from "./EN-GRAFO.json" with { type: "json" };
import frGrafo from "./FR-GRAFO.json" with { type: "json" };
import koGrafo from "./KO-GRAFO.json" with { type: "json" };
import { ErrorApp } from "./errores.ts";
import type { Grafo, McOperacional } from "./tipos.ts";
import { validarPlan } from "./plan.ts";

export const MC: McOperacional = mcJson as unknown as McOperacional;

export const GRAFOS: Readonly<Record<string, Grafo>> = {
  EN: enGrafo as unknown as Grafo,
  FR: frGrafo as unknown as Grafo,
  KO: koGrafo as unknown as Grafo,
};

export const INFRA = {
  /** Mensajes por minuto por usuario. Una lección no requiere más. */
  LIMITE_USUARIO_POR_MINUTO: 6,
  /** Llamadas al LLM por día para TODA la app, si no se define el secret LLM_LIMITE_DIARIO. */
  LIMITE_GLOBAL_LLM_DIARIO_POR_DEFECTO: 200,
  /** Candado anti doble-envío por usuario (segundos). Debe superar 2 × TIMEOUT_LLM_MS (llamada + reparación). */
  CANDADO_TTL_SEGUNDOS: 150,
  CACHE_LIVRABLE_TTL_SEGUNDOS: 3600,
  MAX_IMAGENES: 3,
  /** Bytes decodificados por imagen: el frontend DEBE reducirlas antes de enviar. */
  MAX_BYTES_IMAGEN: 1_500_000,
  MAX_BYTES_PETICION: 6_500_000,
  MAX_CARACTERES_MENSAJE: 8000,
  TIMEOUT_LLM_MS: 60_000,
  /** Si Redis cae: true = la app sigue (sin rate limit ni candado), false = se rechaza todo. */
  FALLAR_ABIERTO_SI_REDIS_CAE: true,
  REGISTRAR_USO_LLM: true,
  /** Solo se guardan en logs_sistema los eventos con esta severidad o mayor. */
  SEVERIDAD_MINIMA_REGISTRO: "warning" as const,
  IDIOMA_INTERFAZ: "español",
  MAX_EVIDENCIAS_MOTOR: 500,
  /** La presentación (étapes 8–14, una sección por étape) es la respuesta más larga. */
  MAX_TOKENS_PRESENTACION: 6000,
  /** Pausa antes de repetir una petición tras un fallo pasajero del proveedor. */
  PAUSA_REINTENTO_MS: 1500,
  /** Pausa más larga cuando el proveedor avisa saturación (503 "high demand" o 429) — cambio 12.
   *  Peor caso de una petición: 60 s + 5 s + 60 s = 125 s < 150 s (límite de Supabase y del candado). */
  PAUSA_SATURACION_MS: 5000,
  /** Tope al duplicar el límite tras una respuesta cortada (cambio 3). */
  MAX_TOKENS_TOPE: 12000,
  MAX_TOKENS_EVALUACION: 2500,
  BUCKET_EVIDENCIAS: "evidencias",
  MODELO_CLAUDE_POR_DEFECTO: "claude-sonnet-5-5",
  /** Pruebas del desarrollador (no apto para menores ni datos reales: ver llm_gemini.ts). */
  MODELO_GEMINI_POR_DEFECTO: "gemini-3.8-flash",
  /** El mínimo que admite gemini-3.8-flash (no tiene MINIMAL). */
  NIVEL_RAZONAMIENTO_GEMINI: "LOW" as const,
  /** Respaldo para el segundo intento tras saturación o tiempo agotado (cambio 11).
   *  Estable, gratis, lee imágenes, admite esquema JSON y el nivel LOW. Se cambia con LLM_MODEL_RESPALDO. */
  MODELO_GEMINI_RESPALDO: "gemini-3.5-flash-lite",
} as const;

// ---------- Secrets (lectura perezosa) ----------
function leer(nombre: string): string | undefined {
  const v = Deno.env.get(nombre);
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export function secretObligatorio(nombre: string): string {
  const v = leer(nombre);
  if (!v) throw new ErrorApp(598, `Falta el secret ${nombre}`);
  return v;
}

export function secretOpcional(nombre: string): string | undefined {
  return leer(nombre);
}

/** Tope diario global de llamadas al LLM: secret LLM_LIMITE_DIARIO (entero 1–100000) o el valor por defecto. */
export function limiteGlobalDiario(): number {
  const crudo = leer("LLM_LIMITE_DIARIO");
  if (crudo === undefined) return INFRA.LIMITE_GLOBAL_LLM_DIARIO_POR_DEFECTO;
  const n = Number(crudo);
  if (!Number.isInteger(n) || n < 1 || n > 100_000) {
    throw new ErrorApp(598, `LLM_LIMITE_DIARIO inválido: "${crudo}" (debe ser un entero entre 1 y 100000)`);
  }
  return n;
}

// ---------- Validación de los datos canónicos ----------
let validado = false;

/** Verifica una vez por instancia que MC-OPERACIONAL y los grafos tienen lo que el código necesita. */
export function validarDatosCanonicos(): void {
  if (validado) return;
  const problemas: string[] = [];
  try {
    problemas.push(...validarPlan(MC.leccion.plan_ejecucion.pasos));
    const f = MC.modos_operacion.estudiante.criterio_completitud.factor_minimo;
    if (typeof f !== "number" || f <= 0 || f > 1) problemas.push("factor_minimo fuera de (0,1]");
    const p = MC.evidencia_y_estado.puntaje_leccion.pesos_iniciales_a_calibrar;
    if (Math.abs(p.peso_produccion_espontanea + p.peso_produccion_guiada - 1) > 1e-9) {
      problemas.push("los pesos de puntaje_leccion no suman 1");
    }
    const w = MC.consolidacion_continua.motor_reactivacion.formula_prioridad_reactivacion.pesos_iniciales_a_calibrar;
    if (Math.abs(w.w_errores + w.w_dependencia + w.w_tiempo - 1) > 1e-9) {
      problemas.push("los pesos del motor de reactivación no suman 1");
    }
    if (!Array.isArray(MC.secuenciacion.politica_desempate_declarada?.criterios_en_orden)) {
      problemas.push("falta secuenciacion.politica_desempate_declarada.criterios_en_orden");
    }
    for (const [codigo, g] of Object.entries(GRAFOS)) {
      if (!Array.isArray(g.dominios) || g.dominios.length === 0) problemas.push(`${codigo}-GRAFO sin dominios`);
    }
  } catch (e) {
    problemas.push(`estructura inesperada: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (problemas.length) {
    throw new ErrorApp(598, `MC-OPERACIONAL/grafos inválidos: ${problemas.join("; ")}`);
  }
  validado = true;
}
