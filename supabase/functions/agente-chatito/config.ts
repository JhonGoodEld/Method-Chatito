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
  /** Llamadas al LLM por día para TODA la app. OpenRouter gratis sin créditos = 50/día. */
  LIMITE_GLOBAL_LLM_DIARIO: 45,
  /** Candado anti doble-envío por usuario (segundos). Debe superar TIMEOUT_LLM_MS. */
  CANDADO_TTL_SEGUNDOS: 90,
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
  MAX_TOKENS_PRESENTACION: 3000,
  MAX_TOKENS_EVALUACION: 2500,
  BUCKET_EVIDENCIAS: "evidencias",
  MODELO_CLAUDE_POR_DEFECTO: "claude-sonnet-5-5",
  MODELO_OPENROUTER_POR_DEFECTO: "openrouter/free",
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
