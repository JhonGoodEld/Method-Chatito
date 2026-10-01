// =====================================================================
// agente-chatito — ARCHIVO GENERADO AUTOMÁTICAMENTE. NO EDITAR A MANO.
// Fuente: módulos de la carpeta agente-chatito/ → herramientas/empaquetar.ts
// Módulos (20): errores.ts, tipos.ts, plan.ts, config.ts, datos.ts, completitud.ts, llm_tipos.ts, peticion.ts, salida_llm.ts, prompt.ts, puntaje.ts, secuenciacion.ts, reactivacion.ts, registro.ts, flujo_estudiante.ts, llm_claude.ts, llm_openrouter.ts, llm_fabrica.ts, redis.ts, index.ts
// =====================================================================
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { z } from "npm:zod@3.23.8";
import { Redis } from "npm:@upstash/redis@1";
import { Ratelimit } from "npm:@upstash/ratelimit@2";

// ───────────── errores.ts ─────────────
// errores.ts — Catálogo único de códigos de error del agente Método Chatito.
//
// Esquema por rangos (idea original de J. Good, extendida):
//   1xx  Base de datos
//   2xx  Proveedor de IA (agente / API key)
//   3xx  Reglas de negocio y validación de la petición
//   4xx  Acceso: autenticación, permisos, abuso (rate limit)
//   5xx  Infraestructura (Redis, Storage, configuración)
//   9xx  Telemetría (no son errores: registros de uso)
//
// Cada código tiene: estado HTTP, mensaje para el usuario final (nunca
// detalles técnicos ni secretos) y severidad por defecto para el registro.
// Este módulo es PURO (sin acceso a red ni a variables de entorno).

export type Severidad = "info" | "warning" | "error" | "critico";

interface DefinicionError {
  readonly nombre: string;
  readonly http: number;
  readonly mensaje: string;
  readonly severidad: Severidad;
}

export const CATALOGO = {
  // ---------- 1xx Base de datos ----------
  101: { nombre: "DB_LECTURA", http: 500, severidad: "critico", mensaje: "No pudimos leer tu progreso. Intenta de nuevo en un momento." },
  102: { nombre: "DB_RESTRICCION", http: 409, severidad: "error", mensaje: "La operación choca con una regla de la base de datos." },
  103: { nombre: "DB_NO_ENCONTRADO", http: 404, severidad: "warning", mensaje: "No encontramos el recurso solicitado." },
  104: { nombre: "DB_ESCRITURA", http: 500, severidad: "critico", mensaje: "No pudimos guardar tu progreso. Intenta de nuevo en un momento." },
  106: { nombre: "SUPABASE_NO_DISPONIBLE", http: 503, severidad: "critico", mensaje: "El servicio no está disponible en este momento. Intenta en unos minutos." },
  105: { nombre: "DB_CONFLICTO_CONCURRENCIA", http: 409, severidad: "warning", mensaje: "Tu sesión cambió mientras procesábamos la petición. Recarga e intenta de nuevo." },

  // ---------- 2xx Proveedor de IA ----------
  201: { nombre: "LLM_AUTENTICACION", http: 502, severidad: "critico", mensaje: "El agente no está disponible en este momento (configuración)." },
  202: { nombre: "LLM_LIMITE_PROVEEDOR", http: 503, severidad: "warning", mensaje: "El agente está saturado. Intenta de nuevo en unos minutos." },
  203: { nombre: "LLM_RESPUESTA_MALFORMADA", http: 502, severidad: "error", mensaje: "El agente respondió en un formato inesperado. Intenta de nuevo." },
  204: { nombre: "LLM_TIEMPO_AGOTADO", http: 504, severidad: "error", mensaje: "El agente tardó demasiado en responder. Intenta de nuevo." },
  205: { nombre: "LLM_NO_CONFIGURADO", http: 500, severidad: "critico", mensaje: "El agente no está configurado todavía." },
  206: { nombre: "LLM_ERROR_PROVEEDOR", http: 502, severidad: "error", mensaje: "El proveedor del agente falló. Intenta de nuevo." },
  207: { nombre: "LLM_SIN_CREDITO", http: 502, severidad: "critico", mensaje: "El agente no está disponible en este momento (cuota agotada)." },

  // ---------- 3xx Negocio y validación ----------
  301: { nombre: "LIMITE_IDIOMAS", http: 409, severidad: "info", mensaje: "Ya tienes 3 idiomas en curso, que es el máximo." },
  303: { nombre: "SOLICITUD_PENDIENTE_EXISTENTE", http: 409, severidad: "info", mensaje: "Ya tienes una solicitud de idioma nuevo en espera." },
  304: { nombre: "IDIOMA_YA_EXISTE", http: 409, severidad: "info", mensaje: "Ese idioma ya existe en el catálogo: inscríbete directamente, tu solicitud no se consumió." },
  305: { nombre: "SIN_CONTENIDO_DECLARATIVO", http: 409, severidad: "warning", mensaje: "La siguiente lección todavía no está disponible. Vuelve pronto." },
  306: { nombre: "PETICION_INVALIDA", http: 400, severidad: "info", mensaje: "La petición no es válida." },
  307: { nombre: "EVIDENCIA_INVALIDA", http: 400, severidad: "info", mensaje: "La imagen enviada no es válida (formato o tamaño)." },
  308: { nombre: "IDIOMA_SIN_GRAFO", http: 500, severidad: "critico", mensaje: "Este idioma aún no tiene su arquitectura cargada." },
  309: { nombre: "GRAFO_INCONSISTENTE", http: 500, severidad: "critico", mensaje: "Hay un problema con la estructura del curso. Ya fue reportado." },
  310: { nombre: "ACCION_NO_ESPERADA", http: 409, severidad: "info", mensaje: "En este momento no se espera una respuesta; pulsa «continuar»." },
  311: { nombre: "PETICION_EN_CURSO", http: 409, severidad: "info", mensaje: "Ya estamos procesando tu petición anterior. Espera un momento." },

  // ---------- 4xx Acceso ----------
  401: { nombre: "NO_AUTENTICADO", http: 401, severidad: "info", mensaje: "Tu sesión no es válida. Vuelve a iniciar sesión." },
  403: { nombre: "SIN_PERMISO", http: 403, severidad: "warning", mensaje: "No tienes acceso a este recurso." },
  429: { nombre: "LIMITE_USUARIO", http: 429, severidad: "warning", mensaje: "Estás enviando mensajes muy rápido. Espera un momento." },
  430: { nombre: "LIMITE_GLOBAL_DIARIO", http: 429, severidad: "critico", mensaje: "El agente alcanzó su límite diario. Vuelve mañana." },

  // ---------- 5xx Infraestructura ----------
  501: { nombre: "REDIS_NO_DISPONIBLE", http: 503, severidad: "warning", mensaje: "Servicio temporalmente degradado." },
  502: { nombre: "STORAGE_FALLIDO", http: 500, severidad: "warning", mensaje: "No pudimos guardar tu imagen, pero tu respuesta sí quedó registrada." },
  503: { nombre: "MODO_NO_IMPLEMENTADO", http: 501, severidad: "info", mensaje: "Este modo todavía no está disponible." },
  598: { nombre: "CONFIGURACION_INVALIDA", http: 500, severidad: "critico", mensaje: "El servicio está mal configurado. Ya fue reportado." },
  599: { nombre: "ERROR_INESPERADO", http: 500, severidad: "critico", mensaje: "Ocurrió un error inesperado. Ya fue reportado." },

  // ---------- 9xx Telemetría ----------
  900: { nombre: "LLM_USO", http: 200, severidad: "info", mensaje: "Uso del proveedor de IA." },
  901: { nombre: "DECISION_SECUENCIACION", http: 200, severidad: "info", mensaje: "Decisión de MC-009 registrada." },
} as const satisfies Record<number, DefinicionError>;

export type CodigoError = keyof typeof CATALOGO;

/** Error de la aplicación: siempre lleva un código del catálogo. */
export class ErrorApp extends Error {
  readonly codigo: CodigoError;
  /** Detalle técnico: va al registro, NUNCA al usuario final. */
  readonly detalleTecnico: string;
  readonly contexto: Record<string, unknown>;

  constructor(
    codigo: CodigoError,
    detalleTecnico?: string,
    contexto: Record<string, unknown> = {},
    opciones?: { cause?: unknown },
  ) {
    const def = CATALOGO[codigo];
    super(`[${codigo} ${def.nombre}] ${detalleTecnico ?? def.mensaje}`, opciones);
    this.name = "ErrorApp";
    this.codigo = codigo;
    this.detalleTecnico = detalleTecnico ?? def.mensaje;
    this.contexto = contexto;
  }

  get http(): number {
    return CATALOGO[this.codigo].http;
  }
  get severidad(): Severidad {
    return CATALOGO[this.codigo].severidad;
  }
  get mensajeUsuario(): string {
    return CATALOGO[this.codigo].mensaje;
  }
  get nombreCodigo(): string {
    return CATALOGO[this.codigo].nombre;
  }
}

/** Convierte cualquier excepción en ErrorApp (lo desconocido → 599). */
export function normalizarError(e: unknown): ErrorApp {
  if (e instanceof ErrorApp) return e;
  const detalle = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return new ErrorApp(599, detalle, {}, { cause: e });
}

// ───────────── tipos.ts ─────────────
// tipos.ts — Tipos compartidos. Módulo PURO (solo tipos).

// ---------- MC-OPERACIONAL (solo lo que el código lee) ----------
export interface PasoPlan {
  paso: string;
  etapas: number[];
  tipo: "presentacion" | "produccion" | "correccion";
  niveles?: (number | null)[];
  categoria?: "guiada" | "libre";
  /** diferida = los errores se acumulan hasta el paso de corrección (MC-001 §17). */
  correccion?: "diferida" | "inmediata";
  /** Solo en pasos de corrección: pasos cuya producción se corrige aquí. */
  fuentes?: string[];
  cierra_unidad?: boolean;
  declara_antes_de_producir?: string[];
}

export interface EtapaCiclo {
  /** Número de étape de MC-001 (8–19, igual a su número de sección). */
  n: number;
  /** Lugar en el ciclo de 12 (MC-000 §10). */
  posicion: number;
  nombre: string;
  tipo: "presentacion" | "produccion" | "correccion";
  niveles?: Record<string, string>;
  incluye?: string;
}

export interface McOperacional {
  version: string;
  principios_rectores: Record<string, { regla: string }>;
  leccion: {
    ciclo_12_etapas: EtapaCiclo[];
    plan_ejecucion: { etapa_correccion: number; pasos: PasoPlan[] };
    precisiones_mc001: Record<string, unknown>;
  };
  evidencia_y_estado: {
    regla_de_scope_de_correccion: { regla: string };
    puntaje_leccion: {
      pesos_iniciales_a_calibrar: { peso_produccion_espontanea: number; peso_produccion_guiada: number };
    };
  };
  secuenciacion: {
    politica_desempate_declarada: { criterios_en_orden: CriterioDesempate[] };
  };
  consolidacion_continua: {
    motor_reactivacion: {
      hasard: { p_azar_inicial_a_calibrar: number };
      formula_prioridad_reactivacion: {
        pesos_iniciales_a_calibrar: { w_errores: number; w_dependencia: number; w_tiempo: number };
        parametros_normalizacion_iniciales_a_calibrar: {
          tope_errores: number;
          tope_profundidad: number;
          tau_dias: number;
          umbral_disparo: number;
        };
      };
    };
  };
  modos_operacion: {
    estudiante: { criterio_completitud: { factor_minimo: number } };
  };
}

// ---------- Arquitectura (XX-GRAFO) ----------
export type Naturaleza = "transversal" | "sequentiel";

export interface DominioGrafo {
  id: string;
  nombre?: string;
  nature: Naturaleza;
  prerequis: string[];
  sous_domaines?: string[];
}

export interface Grafo {
  idioma: string;
  version?: string;
  dominios: DominioGrafo[];
}

export type CriterioDesempate = "contenido_disponible" | "orden_declaracion_arquitectura";

// ---------- Lecciones declaradas (tabla livrables) ----------
export interface LeccionDeclarada {
  unidad_id: string;
  dominio_id: string;
  sous_domaine_id: string | null;
  titulo: string;
  orden_declarado: number;
  prerequis: string[];
  estado_redaccion: "declarado" | "redactado";
}

// ---------- Estado de la unidad (MC-002) ----------
export type EstadoUnidad = "non_acquis" | "en_cours" | "acquis" | "consolide";

export interface FilaEstadoUnidad {
  unidad_id: string;
  estado: EstadoUnidad;
  actualizado_en: string;
}

// ---------- Evidencia ----------
export interface ErrorDetectado {
  fragmento: string;
  correccion: string;
  causa: string;
  explicacion: string;
  fuera_de_scope: boolean;
  unidad_relacionada: string | null;
  nivel: number | null;
}

export type Intento = "inicial" | "complemento" | "correccion";

export interface MetricasEvidencia {
  paso: string;
  intento: Intento;
  categoria?: "guiada" | "libre";
  total_pedido?: number;
  unidad_medida?: string;
  minimo_requerido?: number;
  total_entregado?: number;
  items_evaluados?: number;
  items_correctos?: number;
  errores_senalados?: number;
  errores_corregidos?: number;
  diagnostico_diferido?: boolean;
  archivos?: string[];
}

export interface FilaEvidenciaNueva {
  alumno_idioma_id: string;
  unidad_id: string;
  etapa_mc001: number;
  nivel_ejercicio: number | null;
  tipo_contenido: "texto" | "imagen" | "audio";
  contenido_alumno: string;
  url_storage: string | null;
  correccion: string | null;
  diagnosticos: ErrorDetectado[] | null;
  metricas: MetricasEvidencia;
}

export interface FilaEvidencia extends FilaEvidenciaNueva {
  id: string;
  creado_en: string;
}

// ---------- Sesión de lección (sesion_leccion.requisitos_etapa) ----------
export type EstadoPaso =
  | "pendiente_presentar"
  | "esperando_evidencia"
  | "esperando_correccion"
  | "curriculo_bloqueado"
  | "curriculo_completado";

export interface NivelRequerido {
  nivel: number | null;
  total_pedido: number;
  unidad_medida: string;
  minimo_requerido: number;
}

export interface ErrorSenalado {
  indice: number;
  fragmento: string;
  correccion: string;
  explicacion: string;
  causa?: string;
  /** Paso de producción donde apareció el error. */
  paso?: string;
}

export interface Requisitos {
  paso: string | null;
  estado_paso: EstadoPaso;
  enunciado?: string;
  niveles?: NivelRequerido[];
  transcripciones_previas?: string[];
  errores_senalados?: ErrorSenalado[];
  /** Errores de pasos con corrección diferida, pendientes para la étape 17. */
  errores_acumulados?: ErrorSenalado[];
  ultimo_mensaje_agente?: string;
  justificacion_secuenciacion?: string[];
  bloqueo?: { razon: string; unidad_id?: string; dominio_id?: string };
}

export interface Sesion {
  id: string;
  alumno_idioma_id: string;
  unidad_id: string;
  etapa_actual: number;
  fase_correccion: "collecte_evidence" | "correction_differee" | "diagnostic" | null;
  requisitos_etapa: Requisitos;
  actualizado_en: string;
}

// ---------- Contrato público de la respuesta ----------
export type FasePublica =
  | "esperando_evidencia"
  | "esperando_correccion"
  | "listo_para_continuar"
  | "curriculo_bloqueado"
  | "curriculo_completado";

export interface EstadoPublico {
  unidad_id: string | null;
  etapa_actual: number | null;
  paso: string | null;
  fase: FasePublica;
  niveles?: NivelRequerido[];
  errores_pendientes?: number;
  bloqueo?: Requisitos["bloqueo"];
}

export interface SugerenciaReactivacion {
  unidad_id: string;
  motivo: "hasard" | "prioridad";
  prioridad: number | null;
}

export interface RespuestaFlujo {
  mensaje_agente: string | null;
  mensaje_sistema: string | null;
  resultado?: "avanza" | "requiere_completar" | "requiere_correccion" | "correccion_incompleta" | "unidad_completada";
  estado: EstadoPublico;
  sugerencia_reactivacion?: SugerenciaReactivacion | null;
}

// ───────────── plan.ts ─────────────
// plan.ts — Navegación del plan de ejecución de MC-001 (módulo PURO).
// El plan vive en MC-OPERACIONAL.leccion.plan_ejecucion: cambiar el orden de
// entrega de las étapes = editar el JSON, no este código.


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

// ───────────── config.ts ─────────────
// config.ts — Datos canónicos empaquetados + parámetros de infraestructura.
//
// Regla: los parámetros PEDAGÓGICOS (pesos, umbrales, plan de étapes) viven en
// MC-OPERACIONAL.json — fuente única (Principio 1). Aquí solo quedan los
// parámetros de INFRAESTRUCTURA (límites, tiempos, tamaños).
//
// Los secrets se leen de forma perezosa (funciones), nunca al importar el
// módulo: así las pruebas no necesitan variables de entorno y un secret
// ausente produce un error con código (598/205), no un fallo opaco.

const mcJson = {"documento":"MC-OPERACIONAL","version":"1.4.0","historial":[{"version":"1.0.0","cambio":"Versión inicial."},{"version":"1.1.0","cambio":"Tras la ejecución piloto FR-411: (a) regla de scope de corrección (el agente solo corrige el objetivo de la unidad activa, nunca dominios no enseñados); (b) regla de agrupación de evidencia por turno (agrupar niveles que no dependan de corrección previa, nunca reordenar étapes); (c) motor_reactivacion formalizado en consolidacion_continua; (d) puntaje_leccion añadido a evidencia_y_estado, con alcance acotado (ver nota_MC002_S17)."},{"version":"1.2.0","cambio":"Formalización de modos_operacion (estudiante, docente_aprender, docente_crear), a partir del diagrama de flujo de navegación de la app. docente_crear queda explícitamente marcado como no probado, pendiente por tiempo indefinido."},{"version":"1.3.0","cambio":"Preparación para la Edge Function: (a) CORRECCIÓN de un error introducido en v1.0.0: 'etapas_en_orden' mezclaba el ciclo de 12 étapes con los números de SECCIÓN 14/15/17 de MC-001 y omitía corrección y transformación — reemplazada por ciclo_12_etapas + precisiones_mc001 + plan_ejecucion; (b) reglas operativas v1 de secuenciación (accesibilidad, dominio agotado, bloqueo por falta de contenido, política de desempate PROPUESTA); (c) regla provisional de transición de estados; (d) parámetros numéricos del motor de reactivación y factor de completitud como datos, no como texto."},{"version":"1.4.0","cambio":"Contrastado con MC-001 v1.0.2 real: (a) numeración de étapes = la de MC-001 (8–19, igual a su número de sección), con 'posicion' 1–12 del ciclo; (b) corrección DIFERIDA: la étape 17 corrige juntas las producciones de las étapes 15 y 16 (MC-001 §17 fase 1), ya no después de cada nivel; (c) niveau 3 = production libre (categoría libre); (d) descripciones de los 3 niveaux de MC-001 §15. Se retira la marca 'a ratificar' sobre 14/15/17: confirmado."}],"proposito":"Capa operativa derivada de la saga MC-00X (Método Chatito). Contiene solo las reglas que el agente de IA debe aplicar en tiempo de ejecución, sin la justificación narrativa ni el historial de decisiones que sí viven en los documentos MC originales del repositorio. Es agnóstica de idioma: se usa igual para FR, KO, EN o cualquier arquitectura futura.","fuente_canonica":"https://github.com/JhonGoodEld/Method-Chatito (carpeta Specification/MC)","principios_rectores":{"P7_progresion_por_profundidad":{"regla":"La profundidad de una unidad transformacional se gestiona vía MC-009, no vía intuición del agente en el momento."},"P8_declarativo_procedimental":{"regla":"El agente NUNCA decide qué existe en la lengua (eso vive en las tablas XX-X00 declarativas). El agente solo decide CÓMO enseñarlo, dentro de las reglas de esta capa."},"P9_ejecucion_interactiva":{"regla":"Un documento de lección describe; el agente ejecuta. Prohibido: (a) que el agente reescriba o reinterprete la definición declarativa durante la conversación, (b) que la conversación misma se convierta en la fuente de la definición.","evidencia_previa":"Nunca se descarta evidencia ya recolectada, aunque cambie el estado del alumno.","reactivacion":"Es un evento posterior y distinto, gobernado por MC-006, no por la ejecución de la lección en curso."},"P10_separacion_declaracion_secuenciamiento":{"regla":"El ID o número de un livrable (ej. KO-511, EN-411) NO determina su prioridad ni orden de enseñanza. El orden SIEMPRE se decide vía el grafo de MC-009, nunca por numeración ni por razonamiento libre del LLM.","error_historico_a_evitar":"No elegir una lección 'porque existe' o 'porque es autocontenida' — ese razonamiento viola este principio aunque parezca práctico."}},"leccion":{"fuente":"MC-001 — Structure Standard d'une Leçon v1.0.2 (contrastado con el documento real).","regla_maestra":"No se avanza a la etapa N+1 sin haber completado y declarado la etapa N. El agente no puede saltar a producción/ejercicios antes de declarar el conocimiento completo.","ciclo_12_etapas":[{"n":8,"posicion":1,"nombre":"description","tipo":"presentacion"},{"n":9,"posicion":2,"nombre":"utilisation","tipo":"presentacion"},{"n":10,"posicion":3,"nombre":"structure","tipo":"presentacion"},{"n":11,"posicion":4,"nombre":"expressions_frequentes","tipo":"presentacion"},{"n":12,"posicion":5,"nombre":"erreurs_frequentes","tipo":"presentacion"},{"n":13,"posicion":6,"nombre":"exemples","tipo":"presentacion"},{"n":14,"posicion":7,"nombre":"notes_et_exceptions","tipo":"presentacion","incluye":"transformations_prevues (declarativo)"},{"n":15,"posicion":8,"nombre":"exercices_guides","tipo":"produccion","incluye":"formes_evidence_attendues (declarativo, obligatorio)","niveles":{"1":"Transformation — transformar frases dadas según una consigna precisa (aplicación directa de la regla)","2":"Phrases — construir frases propias a partir de elementos dados (contextualización guiada)","3":"Production libre — producir libremente, sin soporte dado (escrita, oral, o foto de producción manuscrita)"}},{"n":16,"posicion":9,"nombre":"production_ecrite","tipo":"produccion"},{"n":17,"posicion":10,"nombre":"correction_detaillee","tipo":"correccion"},{"n":18,"posicion":11,"nombre":"transformation","tipo":"produccion"},{"n":19,"posicion":12,"nombre":"vocabulaire","tipo":"presentacion"}],"precisiones_mc001":{"etape_14_transformations_prevues":"Declarativo: anticipa las transformaciones que se ejecutarán en la étape 18. No las ejecuta.","etape_15_formes_evidence_attendues":"Declarativo y OBLIGATORIO: la LECCIÓN (livrable) precisa, por nivel, el tipo exacto de producción exigida, antes de ejecutar. Si el livrable no lo declara, el agente lo señala y usa los ejemplos de MC-001 §15.","etape_17_correction_detaillee":{"fases_obligatorias_en_orden":["collecte_evidence","correction_differee","diagnostic"],"fuentes":"Las producciones de las étapes 15 y 16 (MC-001 §17, fase 1).","regla":"Ninguna fase empieza antes de que termine la anterior. La corrección es frase por frase con explicación gramatical; el diagnóstico clasifica cada error con la tipología de MC-002 §13."}},"plan_ejecucion":{"nota":"Orden de ENTREGA en turnos. Agrupa sin reordenar el ciclo. Producciones con correccion 'diferida' acumulan sus errores hasta el paso de corrección (étape 17).","etapa_correccion":17,"pasos":[{"paso":"presentacion","etapas":[8,9,10,11,12,13,14],"tipo":"presentacion","declara_antes_de_producir":["etape_14_transformations_prevues","etape_15_formes_evidence_attendues"]},{"paso":"exercices_n1_n2","etapas":[15],"tipo":"produccion","niveles":[1,2],"categoria":"guiada","correccion":"diferida"},{"paso":"exercices_n3","etapas":[15],"tipo":"produccion","niveles":[3],"categoria":"libre","correccion":"diferida"},{"paso":"production_ecrite","etapas":[16],"tipo":"produccion","niveles":[null],"categoria":"libre","correccion":"diferida"},{"paso":"correction","etapas":[17],"tipo":"correccion","fuentes":["exercices_n1_n2","exercices_n3","production_ecrite"]},{"paso":"transformation","etapas":[18],"tipo":"produccion","niveles":[null],"categoria":"guiada","correccion":"inmediata","nota":"MC-001 no especifica si la étape 18 se corrige; se aplica la regla general del 100% de J. Good. A ratificar."},{"paso":"vocabulaire","etapas":[19],"tipo":"presentacion","cierra_unidad":true}]},"numeracion":"n = número de étape de MC-001, que coincide con su número de sección (8–19); posicion = lugar en el ciclo de 12 (MC-000 §10). Toda referencia 'étape N' en documentos, evidencia y registros usa n."},"evidencia_y_estado":{"fuente":"MC-002 — Modèle d'Apprentissage","estados_posibles":["non_acquis","en_cours","acquis","consolide"],"principio_evidencia_no_igual_estado":"El estado es una inferencia; la evidencia es el registro bruto que la sustenta. La evidencia NUNCA se borra ni se sobrescribe, aunque el estado cambie.","modelo_observacion":{"pasos":8,"regla":"Un cambio de estado requiere haber completado el modelo de observación de 8 pasos, no una sola respuesta correcta o incorrecta."},"no_regresion_automatica":"Una respuesta incorrecta puntual NO degrada automáticamente el estado del alumno; requiere el diagnóstico completo de la etapa 17.","formula_consolidacion":"Se descubre empíricamente por idioma/alumno — el agente no debe asumir un umbral fijo universal.","regla_de_scope_de_correccion":{"origen":"Piloto FR-411 (v1.1.0) — el alumno produjo estructuras de dominios no enseñados aún (ej. conjugación verbal en una lección de género nominal).","regla":"El agente corrige ÚNICAMENTE el objetivo declarado de la unidad activa. Errores de otros dominios se observan y se registran como evidencia (nunca se descartan, Principio 9), pero NO se corrigen ni se evalúan fuera de secuencia — evita violar el Principio 7 (profundidad antes que anchura)."},"puntaje_leccion":{"origen":"Piloto FR-411 (v1.1.0) — necesario como señal de entrada para consolidacion_continua.motor_reactivacion, NO como evaluación pedagógica.","nota_MC002_S17":"MC-002 §17 prohíbe explícitamente reducir la evaluación pedagógica a una nota aditiva de sus 6 dimensiones diagnósticas (exactitude, adéquation, maîtrise structurelle, autonomie, stabilité, flexibilité). Este puntaje NO es esa nota — es una métrica de alcance acotado, exclusiva para alimentar la priorización de reactivación de MC-006. La decisión pedagógica de MC-002 §18 sigue siendo cualitativa y nunca se sustituye por este número.","formula":"puntaje_leccion = (peso_produccion_espontanea × %acierto_produccion_libre) + (peso_produccion_guiada × %acierto_ejercicios_y_transformacion)","pesos_iniciales_a_calibrar":{"peso_produccion_espontanea":0.6,"peso_produccion_guiada":0.4,"justificacion":"MC-002 §26 (Principe de production authentique): la producción espontánea mide mejor la mobilización real que la sollicitée. Confirmado empíricamente en FR-411: 100% en producción libre vs. 25% en ejercicio guiado al primer intento — evidencias de naturaleza distinta, no equivalentes."},"regla_de_calculo_v1":"Se usa la última evidencia ANTERIOR a la corrección de cada paso (primer intento completo). Guiada: correctos / total_pedido (denominador del sistema, no del LLM). Libre: correctos / ocurrencias del objetivo. Si una categoría no tiene datos, se renormalizan los pesos."},"regla_transicion_estados_v1":{"estado":"Regla operativa PROVISIONAL mientras el modelo de 8 pasos no esté formalizado.","non_acquis_a_en_cours":"Al iniciar la unidad (MC-009 la selecciona).","en_cours_a_acquis":"Al completar el ciclo MC-001 con todos los umbrales superados (completitud 80% y corrección 100%).","a_consolide":"NO automático en v1: exige evidencia de reactivación fuera de la lección original (MC-002 §8.4, MC-006). Pendiente.","nunca":"Ninguna transición es regresiva de forma automática (MC-002 §29)."}},"transformacion":{"fuente":"MC-004 — Consolidation par Transformation","mecanismos":["controlee","guidee","autonome","inverse","chainage","croisee"],"unidad_transformacional":"Entidad formal mínima sobre la que se aplica un mecanismo de transformación; es el objeto que lleva el estado de MC-002."},"vocabulario":{"fuente":"MC-005 — Gestion du Vocabulaire","criterio_priorizacion":["frecuencia","utilidad","reutilizacion"],"distincion":"activo (el alumno debe producirlo) vs pasivo (el alumno debe reconocerlo)"},"consolidacion_continua":{"fuente":"MC-006 — Consolidation Continue","estrategias":["hasard","dependance","erreurs_frequentes","temporelle"],"nota":"Una 'ruleta' de repaso aleatorio es solo UNA implementación posible de la estrategia 'hasard', no la estrategia completa.","motor_reactivacion":{"origen":"Formalizado en v1.1.0, cierra 3 ítems del roadmap de MC-006 §30 (representación formal de prioridad, combinación de las 4 estrategias, cálculo del intervalo entre reactivaciones).","principio_no_negociable":"El cálculo de prioridad de reactivación NUNCA sobrescribe el campo 'estado' de una unidad directamente — viola MC-002 §29 y MC-006 §25.5 (régression artificielle). Solo dispara una reactivación real; el estado únicamente cambia cuando esa reactivación produce evidencia nueva, evaluada por el modelo de 8 pasos de MC-002.","hasard":{"tratamiento":"Sorteo INDEPENDIENTE de la fórmula ponderada, no una de las señales sumadas. Con probabilidad p_azar en cada sesión, se ignora la prioridad calculada y se reactiva una unidad al azar entre las ya consolidadas.","p_azar_inicial_a_calibrar":0.08,"justificacion":"Sumarlo a la fórmula le daría peso conceptual de 'evidencia de olvido' que no tiene — MC-006 §11 solo pide que exista, sin dominar la selección."},"formula_prioridad_reactivacion":{"entradas":{"errores_en_unidades_dependientes":"Conteo de diagnósticos en lecciones POSTERIORES que señalan esta unidad como causa del error (MC-002 §15).","profundidad_de_rama":"Cuántas unidades subsecuentes ya se enseñaron desde que esta unidad se consolidó (vía XX-GRAFO) — implementa MC-006 §12 (révision par dépendance).","dias_desde_ultima_evidencia":"Días desde la fila más reciente en evidencia para esta unidad — implementa MC-006 §14 (révision temporelle), como curva creciente, no lineal fija."},"formula":"prioridad = (w_errores × normalizar(errores_en_unidades_dependientes)) + (w_dependencia × normalizar(profundidad_de_rama)) + (w_tiempo × curva_creciente(dias_desde_ultima_evidencia))","pesos_iniciales_a_calibrar":{"w_errores":0.5,"w_dependencia":0.2,"w_tiempo":0.3,"justificacion":"Orden de prioridad según MC-006 §25.3 (los errores pueden aumentar prioridad, no pueden monopolizarla) y el principio de profundidad de MC-000 §8.7 — errores activos sobre conocimiento previo bloquean avance real, por eso pesan más que el simple paso del tiempo."},"disparo":"Si prioridad supera un umbral configurable, se genera una reactivación real (MC-006 §9: forma distinta a la lección original, nunca repetición mecánica — prohibido por §25.1).","parametros_normalizacion_iniciales_a_calibrar":{"tope_errores":5,"tope_profundidad":10,"tau_dias":14,"umbral_disparo":0.5,"definiciones":"normalizar(x) = min(x / tope, 1); curva_creciente(dias) = 1 - exp(-dias / tau_dias)."}},"candidatos_v1":"Unidades en estado acquis o consolide, excluyendo la recién completada. v1.1.0 decía 'consolidadas'; se amplía a acquis porque reactivar lo adquirido es el camino hacia consolidé (MC-006 §5). A ratificar.","momento_de_evaluacion_v1":"Al cierre de cada unidad, no en cada mensaje, para no interrumpir la lección en curso.","salida_v1":"Solo una SUGERENCIA de reactivación; la lección de reactivación (forma distinta, MC-006 §9) no está implementada en v1."}},"fonologia_y_escritura":{"fuente":"MC-008 — Prononciation et Systèmes d'Écriture","interlingua":"IPA se usa como sistema de representación intermedio entre cualquier lengua origen y destino.","puente_fonetico":["representation","comparaison","interpretation"],"implementacion_referencia":"hangulito (módulo Fonetizador) — no requiere deep learning, es un problema de reglas + tablas de mapeo"},"secuenciacion":{"fuente":"MC-009 — Moteur de Séquencement Curriculaire","regla_maestra":"El orden de enseñanza lo decide EXCLUSIVAMENTE el grafo de prerrequisitos declarado en la tabla canónica XX-000 del idioma activo. El agente nunca decide el orden por numeración, por 'lo que existe', ni por razonamiento libre.","fuente_de_datos_requerida":"tabla_canonica_XX-000 (ejemplo: KO-000 v9.0) — Type (sequentiel/transversal) + Prerequis por dominio","criterio_seleccion_desempate":"potentiel_d_expansion (nodo → cuántas ramas nuevas habilita)","mecanismo_detour":"Si una rama se interrumpe (ej. por dificultad detectada), se apila y se puede retomar después sin perder el progreso.","nodos_transversales":{"regla":"No compiten por turno de enseñanza secuencial. Se consumen incrementalmente en paralelo.","activacion_reforzada":"Solo se prioriza un nodo transversal fuera de su consumo incremental normal si MC-002 detecta dificultad persistente asociada a él."},"distincion_critica":"orden_de_construccion (documental, taxonómico, gobierna en qué secuencia se REDACTAN los documentos XX-X00) ≠ orden_de_enseñanza (este motor, gobierna en qué secuencia se ENSEÑAN los dominios al alumno). Nunca usar uno para decidir el otro.","regla_accesibilidad_v1":"Un nodo es accesible si todos sus prerrequisitos fueron ENSEÑADOS (MC-009 §8), no consolidados. En v1, 'enseñada' = unidad en estado acquis o consolide (ciclo MC-001 completado). Un prerrequisito que sea un dominio transversal se considera siempre satisfecho (MC-009 §21).","dominio_agotado_v1":"Un dominio secuencial está agotado cuando tiene al menos una lección declarada y todas sus lecciones declaradas fueron enseñadas. Un dominio sin lecciones declaradas NUNCA se considera agotado: bloquea en lugar de saltarse (Principio 7).","bloqueo_por_falta_de_contenido":"Si la siguiente lección de la rama activa está declarada pero no redactada, el motor se BLOQUEA (código 305) en lugar de abrir otra rama: saltar de rama por falta de contenido violaría la progresión por profundidad. El bloqueo se registra para que el autor sepa qué lección redactar.","orden_intra_dominio":"Dentro de un dominio: primer sous-domaine en el orden en que la arquitectura lo declara, y dentro de él el primer contenido declarado (MC-009 §21), salvo prerrequisitos explícitos de lección.","politica_desempate_declarada":{"estado":"PROPUESTA — pendiente de ratificación. MC-009 §9 exige que el criterio secundario sea declarado; MC-009 §26 lo deja sin definir.","criterios_en_orden":["contenido_disponible","orden_declaracion_arquitectura"],"descripcion":{"contenido_disponible":"Entre ramas de igual potencial, preferir aquella cuya siguiente lección ya está redactada.","orden_declaracion_arquitectura":"Si persiste el empate, el orden en que la arquitectura (XX-GRAFO) declara sus dominios."},"trazabilidad":"Cada uso del desempate queda en la justificación de la decisión (MC-009 §23)."},"no_implementado_v1":["Aceleración e interrupción pedagógica (MC-009 §17): la interfaz MC-002↔MC-009 no está definida (MC-009 §26).","Activación reforzada de nodos transversales por dificultad persistente (MC-009 §16): el umbral de 'difficulté persistante' no está definido (MC-002 §32)."]},"modos_operacion":{"origen":"Formalizado en v1.2.0, a partir del diagrama de flujo de navegación de la app (rol docente/estudiante) discutido antes de la piloto FR-411.","regla_general":"El modo no es un documento operativo aparte — es un parámetro que el backend pasa al prompt. Todo modo reutiliza MC-OPERACIONAL y/o LG-OPERACIONAL tal cual existen; nunca se duplica contenido de las 12 etapas de MC-001 por modo.","estudiante":{"usa":"MC-OPERACIONAL completo (leccion + evidencia_y_estado + consolidacion_continua).","limite_idiomas":{"max_idiomas_en_curso":3,"max_solicitudes_idioma_nuevo_pendientes":1,"regla_anti_desperdicio":"Antes de registrar una solicitud como 'idioma nuevo', el backend verifica primero si el idioma YA EXISTE en el catálogo (aunque esté con activo=false, precargado). Si existe, se asigna directo como uno de los 3 — la solicitud NUNCA se consume por un idioma que ya estaba disponible."},"nivel_previo":"El agente NUNCA pregunta nivel de conocimiento previo. Toda unidad_alumno_idioma nueva inicia en la primera unidad que entregue MC-009 (mayor potencial de expansión entre transversales sin prerrequisitos) — no existe campo en el sistema para registrar un nivel autodeclarado.","criterio_completitud":{"produccion_inicial":"mínimo_requerido = techo(total_pedido × 0.8) — ej. 10 ejercicios → mínimo 8; 100 palabras → mínimo 80; 7 ejercicios → mínimo 6 (redondeo hacia arriba, nunca hacia abajo).","fase_correccion":"100% de lo señalado como error debe quedar corregido antes de avanzar — asimetría intencional frente al 80% de producción inicial (MC-001 étape 17 exige colecta→corrección→diagnóstico completos).","factor_minimo":0.8},"evidencia_multimedia":{"regla":"Fotos/audio de producción NUNCA viven en la base de datos relacional. Se suben una sola vez a Supabase Storage; Claude las analiza UNA sola vez (ahí se paga el costo de visión) y devuelve el resultado en texto; evidencia.url_storage guarda solo la referencia."},"agrupacion_de_turnos":{"origen":"Piloto FR-411 — costo de visión es por imagen (overhead fijo), no por contenido de la imagen.","regla":"Agrupar en un solo turno de presentación los niveles de ejercicio que NO dependan de corrección previa (ej. niveau 1 + niveau 2 juntos). Producción escrita libre puede presentarse aparte por su extensión. Transformation SIEMPRE va después de corrección — NUNCA se agrupa antes, así ahorre fotos: agrupar por étape en vez de por dependencia de corrección violaría el orden canónico de MC-001 (riesgo de practicar transformación sobre un error aún no corregido)."},"limitacion_v1_evidencia_oral":"MC-001 §15 admite producción oral en el niveau 3; v1 solo acepta texto e imágenes (tipo_contenido 'audio' existe en la BD pero no se procesa)."},"docente_aprender":{"usa":"MC-OPERACIONAL solo para las etapas 1-12 de MC-001 (explicación/práctica guiada). Las etapas 14/15/17 (evidencia esperada, corrección diferida) quedan DESACTIVADAS en este modo — no se evalúa, no se diagnostica, no se corrige vía el agente.","sin_evidencia":"Regla explícita del usuario: este modo NO requiere evidencia de ningún tipo. La validación del aprendizaje del grupo es responsabilidad exclusiva del docente, a su discreción (típicamente en físico, fuera del sistema).","nivel_previo":"El agente NUNCA pregunta nivel de conocimiento previo del grupo — misma regla que en modo estudiante.","estructura_de_progreso":{"unidad":"sesion_grupo (no alumno_idioma) — un docente puede tener VARIAS sesiones de grupo simultáneas (distintos grupos, mismo o distinto idioma, distinto nivel de avance cada una).","regla_de_exclusividad":"Un idioma en progreso por SESIÓN DE GRUPO hasta terminarlo — la exclusividad es por grupo, no por docente. Un docente puede enseñar el mismo idioma a dos grupos en paralelo sin conflicto."},"seguro_tiempo_minimo":{"duracion":"2 horas desde que se presenta una unidad nueva al grupo, antes de poder marcarla como vista/avanzar.","enforcement":"Backend valida `now() - iniciado_unidad_en >= 2h` en cada intento de avance, independientemente de si el frontend ya deshabilitó el botón — nunca confiar solo en el cliente.","auditoria":"Se registra avanzado_por (username del docente) y avanzado_en (timestamp real de confirmación), aunque la decisión sea a discreción — para trazabilidad, no para restringir la decisión."},"motor_reactivacion_variante":{"origen":"El modo no genera evidencia individual, así que la señal 'errores_en_unidades_dependientes' del motor_reactivacion base NO APLICA aquí — no existe diagnóstico individual que la alimente.","regla":"w_errores = 0 en este modo (la entrada no existe, no se sustituye por un valor artificial). Prioridad de reactivación de grupo se calcula solo con w_dependencia + w_tiempo (recalibrados para sumar 1 entre ambos) + el sorteo independiente de hasard. El sistema puede sugerir al docente qué repasar por dependencia/tiempo, nunca por errores."}},"docente_crear":{"usa":"LG-OPERACIONAL, no MC-OPERACIONAL — es generación/validación de arquitectura, no ejecución de lección.","pool_de_idiomas":{"estructura":"Tabla de solicitudes con estado (pendiente/en_proceso/completado/rechazada_ya_existe).","regla_de_exclusividad":"Solo puede existir UNA solicitud con estado 'en_proceso' a la vez — restricción real (aplicación o constraint de base de datos), no solo sugerencia de flujo, para no perder trazabilidad de arquitecturas a medias."},"validacion_paso_a_paso":{"diferencia_con_LG_OPERACIONAL_base":"LG-OPERACIONAL original solo exigía confirmación humana en las Étapes 4 (décision) y 6 (rédaction) de LG-100. En modo docente_crear, el usuario exigió validación explícita en las 6 étapes (inventaire, points_critiques, recherche, decision, numerotation, redaction) — NINGUNA avanza sin validación del docente.","estructura":"sesion_creacion_arquitectura lleva el paso actual (1-6); cada paso queda con validado_por y validado_en antes de que el agente pueda generar el siguiente — mismo patrón de auditoría que evidencia (nunca se sobrescribe, solo se acumula)."},"seguro_anti_aprobacion_sin_lectura":{"condicion_1_scroll":"Elemento centinela al final del contenido (IntersectionObserver) confirma que el docente vio el final real, no solo que la barra de scroll se ve completa.","condicion_2_tiempo_minimo":"Calculado a partir de la extensión del contenido presentado (ej. cantidad de palabras ÷ velocidad de lectura promedio) — NO un número fijo arbitrario igual para todo documento.","ambas_obligatorias":"El botón 'Validar este paso' permanece deshabilitado hasta cumplir AMBAS condiciones.","enforcement_backend":"El backend guarda su propio timestamp de 'cuándo se mostró el contenido' y lo compara contra 'cuándo llegó la validación' — si alguien intenta forzar una validación vía API directa sin pasar por la UI, se rechaza por tiempo insuficiente. Mismo principio de no confiar solo en el cliente que el seguro de 2h de docente_aprender."},"registro_de_auditoria_final":"El documento de arquitectura final (XX-000/XX-X00) lleva estampado validado_por (username del docente) y fecha_validacion como campos estructurados obligatorios.","estado_de_madurez":"Modo definido pero NO ejecutado ni probado — a diferencia de estudiante (probado con FR-411), queda pendiente de validación real por tiempo indefinido, según decisión explícita del usuario."}},"notas_de_implementacion_para_el_agente":["Este documento se carga siempre en el contexto del agente, sin importar el idioma activo.","Junto a este documento, cargar solo la tabla canónica XX-000 del idioma en curso (ligera, son datos tabulares, no prosa).","El orden de las 12 etapas y las reglas de evidencia deben imponerse vía lógica de backend (máquina de estados), no confiarse a la interpretación del LLM en cada turno.","LG-OPERACIONAL es un documento separado y solo se carga cuando el agente debe generar o validar arquitectura nueva (ej. un idioma sin arquitectura previa), no durante la ejecución normal de lecciones."]};
const enGrafo = {"documento":"EN-GRAFO","version":"1.0.0","idioma":"EN","arquitectura_fuente":"EN-000 v1.0.0 (arquitectura completa, terminada)","proposito":"Extracto de datos puro para el motor de secuenciación MC-009. Contiene solo Type + Prérequis + sous-domaines por dominio — sin Genèse, sin justificación, sin tabla de Frontières. Se carga junto a MC-OPERACIONAL.json cuando el idioma activo del alumno es inglés.","estado_validacion":"RESUELTO vía procedimiento LG-100 (Points critiques → Recherche → Décision) el mismo día de generación de este archivo. Ver 'justificacion' en EN-700/EN-800. Pendiente únicamente de ratificación formal por el usuario en el documento EN-000 original — no se ha modificado EN-000 todavía.","dominios":[{"id":"EN-100","nombre":"Phonologie","nivel":"Ressource","nature":"transversal","prerequis":[],"sous_domaines":["EN-110","EN-120","EN-130","EN-140","EN-150","EN-160","EN-170","EN-180","EN-190"]},{"id":"EN-200","nombre":"Orthographe","nivel":"Ressource","nature":"transversal","prerequis":[],"sous_domaines":["EN-210","EN-220","EN-230","EN-240","EN-250"]},{"id":"EN-300","nombre":"Lexique","nivel":"Ressource","nature":"transversal","prerequis":[],"sous_domaines":["EN-310","EN-330","EN-340","EN-350","EN-360","EN-370","EN-380"]},{"id":"EN-400","nombre":"Système nominal","nivel":"Système","nature":"sequentiel","prerequis":["EN-300"],"sous_domaines":["EN-410","EN-420","EN-430","EN-440","EN-450"],"livrables_conocidos":[]},{"id":"EN-500","nombre":"Système verbal","nivel":"Système","nature":"sequentiel","prerequis":["EN-300","EN-400"],"nota_tipologica":"Depende de EN-400 por concordancia sujeto-verbo real en inglés (divergencia legítima confirmada frente a KO-500, que NO depende de KO-400 por ausencia de esa concordancia en coreano)","sous_domaines":["EN-510","EN-520","EN-530","EN-540","EN-550","EN-560"],"livrables_conocidos":["EN-411 (piloto, nota: EN-411 es livrable de EN-400, no de EN-500 — se deja aquí solo como referencia de ejemplo de livrable ya generado en la arquitectura)"]},{"id":"EN-600","nombre":"Syntaxe","nivel":"Système","nature":"sequentiel","prerequis":["EN-400","EN-500"],"sous_domaines":["EN-610","EN-620","EN-630","EN-640","EN-650","EN-660"]},{"id":"EN-700","nombre":"Discours","nivel":"Communication","nature":"sequentiel","prerequis":["EN-600"],"justificacion":"Los mecanismos de cohesión discursiva (référence, ellipse, conjonction) operan sobre estructuras gramaticales ya formadas (référence nominale de EN-440, combinaison de propositions de EN-640), no las crean. Fuente: Halliday & Hasan — la cohesión usa recursos gramaticales existentes de la lengua, no constituye un sistema aparte. Resuelto vía LG-100 (Points critiques→Recherche→Décision), pendiente de ratificación formal en EN-000.","sous_domaines":["EN-710","EN-720","EN-730","EN-740","EN-750","EN-760"]},{"id":"EN-800","nombre":"Pragmatique","nivel":"Communication","nature":"sequentiel","prerequis":["EN-700"],"justificacion":"Las estrategias de indirección/cortesía (EN-830) y los géneros discursivos que EN-800 hereda de EN-760 presuponen coherencia discursiva ya lograda por el alumno. Resuelto vía LG-100, pendiente de ratificación formal en EN-000.","sous_domaines":["EN-810","EN-820","EN-830","EN-840"]}],"livrables_declarativos_ya_redactados":[{"id":"EN-411","dominio":"EN-400","nombre":"Le pluriel régulier et irrégulier","tipo":"piloto"}],"potencial_expansion_calculado":{"nota":"Cuenta de cuántos dominios dependen, directa o indirectamente, de cada uno — ya incluye la resolución de EN-700/EN-800.","EN-300":5,"EN-400":4,"EN-500":3,"EN-600":2,"EN-700":1,"EN-800":0},"notas_de_implementacion":["Este archivo se usa junto a MC-OPERACIONAL.json solo cuando idioma_activo = EN.","No confundir con EN-000: este documento es datos puros para MC-009, EN-000 sigue siendo la fuente canónica con prosa, Genèse y Frontières.","Grafo completo y sin cabos sueltos: EN-100 a EN-800 con Type+Prérequis resueltos. Pendiente únicamente trasladar la resolución de EN-700/EN-800 al documento EN-000 original para que ambos queden sincronizados."]};
const frGrafo = {"documento":"FR-GRAFO","version":"1.0.0","idioma":"FR","arquitectura_fuente":"FR-000 v1.1.0 (alineada a plantilla madura, dependencia FR-500 auditada y confirmada)","proposito":"Extracto de datos puro para el motor de secuenciación MC-009. Se carga junto a MC-OPERACIONAL.json cuando el idioma activo del alumno es francés.","estado_validacion":"Tabla de dependencias (Type+Prérequis) CERRADA y confirmada por auditoría explícita. Lista de sous_domaines PARCIAL — solo incluye los ya documentados en la tabla de Frontières de FR-000; el resto no se ha declarado formalmente todavía.","dominios":[{"id":"FR-100","nombre":"Phonologie","nivel":"Ressource","nature":"transversal","prerequis":[],"sous_domaines":[],"lista_sous_domaines_incompleta":true},{"id":"FR-200","nombre":"Orthographe","nivel":"Ressource","nature":"transversal","prerequis":[],"sous_domaines":["FR-280"],"lista_sous_domaines_incompleta":true},{"id":"FR-300","nombre":"Lexique","nivel":"Ressource","nature":"transversal","prerequis":[],"sous_domaines":["FR-310","FR-340","FR-380"],"lista_sous_domaines_incompleta":true},{"id":"FR-400","nombre":"Système nominal","nivel":"Système","nature":"sequentiel","prerequis":["FR-300"],"sous_domaines":["FR-410","FR-420","FR-440","FR-460","FR-480"],"lista_sous_domaines_incompleta":true,"identifiants_retires":[{"id":"FR-470","absorbe_par":"FR-420"}]},{"id":"FR-500","nombre":"Système verbal","nivel":"Système","nature":"sequentiel","prerequis":["FR-300","FR-400"],"nota_tipologica":"Dependencia CONFIRMADA por auditoría (FR-000 v1.1.0): el acuerdo sujeto-verbo francés consume morfología nominal (FR-410) y mecanismo pronominal (FR-440) — no es un arrastre sin examinar. Divergencia frente a KO-500 (independiente), paralela a EN-500.","sous_domaines":["FR-530","FR-531","FR-550","FR-560"],"lista_sous_domaines_incompleta":true},{"id":"FR-600","nombre":"Syntaxe","nivel":"Système","nature":"sequentiel","prerequis":["FR-400","FR-500"],"sous_domaines":["FR-660"],"lista_sous_domaines_incompleta":true},{"id":"FR-700","nombre":"Discours","nivel":"Communication","nature":"sequentiel","prerequis":["FR-600"],"sous_domaines":["FR-720","FR-740"],"lista_sous_domaines_incompleta":true},{"id":"FR-800","nombre":"Pragmatique et communication","nivel":"Communication","nature":"sequentiel","prerequis":["FR-700"],"sous_domaines":["FR-810"],"lista_sous_domaines_incompleta":true}],"livrables_declarativos_ya_redactados":[{"id":"FR-531","dominio":"FR-500","sous_domaine":"FR-531 (Indicatif)","tipo":"con evidencia real registrada"}],"potencial_expansion_calculado":{"nota":"Cuenta de dominios que dependen, directa o indirectamente, de cada uno.","FR-300":5,"FR-400":4,"FR-500":3,"FR-600":2,"FR-700":1,"FR-800":0},"notas_de_implementacion":["Este archivo se usa junto a MC-OPERACIONAL.json solo cuando idioma_activo = FR.","Tabla de dependencias lista para producción. La lista de sous_domaines es parcial — completar sin bloquear el uso del grafo para secuenciación de dominios (MC-009 solo necesita el nivel de dominio XX-X00, no el de sous-domaine, para su algoritmo principal)."]};
const koGrafo = {"documento":"KO-GRAFO","version":"1.0.0","idioma":"KO","arquitectura_fuente":"KO-000 v0.1.1 (tabla canónica sección 9.0 ya formalizada por el usuario, la más madura de las tres)","proposito":"Extracto de datos puro para el motor de secuenciación MC-009. Se carga junto a MC-OPERACIONAL.json cuando el idioma activo del alumno es coreano.","estado_validacion":"CERRADO. Tomado directamente de la tabla canónica 9.0 de KO-000, ya marcada ahí como fuente única de verdad — no requiere auditoría adicional.","dominios":[{"id":"KO-100","nombre":"Phonologie","nivel":"Ressource","nature":"transversal","prerequis":[],"sous_domaines":["KO-110","KO-120","KO-130","KO-140","KO-150","KO-160","KO-170","KO-180","KO-190"]},{"id":"KO-200","nombre":"Système d'Écriture","nivel":"Ressource","nature":"transversal","prerequis":[],"sous_domaines":["KO-210","KO-220","KO-230","KO-240","KO-250","KO-260","KO-270","KO-280","KO-290"]},{"id":"KO-300","nombre":"Lexique","nivel":"Ressource","nature":"transversal","prerequis":[],"sous_domaines":["KO-310","KO-320","KO-330","KO-340","KO-350","KO-360","KO-370","KO-380"]},{"id":"KO-400","nombre":"Système morphologique et nominal","nivel":"Système","nature":"sequentiel","prerequis":["KO-300"],"nota_estructural":"Hermano de KO-500, no cadena — ambos dependen únicamente de KO-300. MC-009 calculará el potencial de expansión de cada uno para elegir la rama activa; el otro se vuelve détour obligatorio antes de que KO-600 sea accesible (KO-600 exige ambos).","sous_domaines":["KO-410","KO-420","KO-430","KO-440","KO-460"],"identifiants_retires":[{"id":"KO-450","absorbe_par":"KO-420"},{"id":"KO-470","absorbe_par":"KO-420"},{"id":"KO-480","absorbe_por":"table Frontières de KO-400"}]},{"id":"KO-500","nombre":"Système verbal","nivel":"Système","nature":"sequentiel","prerequis":["KO-300"],"nota_tipologica":"Independiente de KO-400 (ver nota en KO-400) — el verbo coreano no marca acuerdo de género/número con el sujeto, a diferencia de FR-500/EN-500.","sous_domaines":["KO-510","KO-520","KO-530","KO-540","KO-550","KO-560","KO-570","KO-580","KO-590"]},{"id":"KO-600","nombre":"Syntaxe","nivel":"Système","nature":"sequentiel","prerequis":["KO-400","KO-500"],"sous_domaines":["KO-610","KO-620","KO-630","KO-640"],"identifiants_retires":[{"id":"KO-680","absorbe_por":"table Frontières de KO-600"}]},{"id":"KO-700","nombre":"Discours","nivel":"Communication","nature":"sequentiel","prerequis":["KO-600"],"sous_domaines":["KO-710","KO-720","KO-730","KO-740","KO-750","KO-760","KO-770"],"identifiants_retires":[{"id":"KO-780","absorbe_por":"table Frontières de KO-700"}]},{"id":"KO-800","nombre":"Pragmatique et communication","nivel":"Communication","nature":"sequentiel","prerequis":["KO-700"],"sous_domaines":["KO-810","KO-820","KO-830","KO-840","KO-850","KO-860","KO-870"]}],"livrables_declarativos_ya_redactados":[{"id":"KO-511","dominio":"KO-500","tipo":"con evidencia real registrada — caso donde se detectó y corrigió un error de secuenciación previo"}],"potencial_expansion_calculado":{"nota":"Cuenta de dominios que dependen, directa o indirectamente, de cada uno. KO-400 y KO-500 quedan empatados — MC-009 decide la rama activa por su propio algoritmo (secciones 9-10), no por este número.","KO-300":5,"KO-400":3,"KO-500":3,"KO-600":2,"KO-700":1,"KO-800":0},"notas_de_implementacion":["Este archivo se usa junto a MC-OPERACIONAL.json solo cuando idioma_activo = KO.","Es el grafo más confiable de los tres — viene de una tabla ya marcada como canónica por el propio usuario, sin necesidad de auditoría adicional de este lado.","El backend debe implementar la lógica de 'détour' (ver mecanismo_detour en MC-OPERACIONAL) específicamente para el par KO-400/KO-500 — es el único caso de hermanos reales entre los tres idiomas."]};

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

// ───────────── datos.ts ─────────────
// datos.ts — Acceso a datos (patrón repositorio).
//
// La lógica del método depende de la INTERFAZ Repositorio, no de Supabase:
// así las pruebas usan un repositorio en memoria y el flujo completo se
// verifica sin base de datos real.
//
// ⚠ SEGURIDAD: esta implementación usa la service role key, que IGNORA RLS.
// Por eso el flujo verifica a mano que alumno_idioma.perfil_id == usuario del
// JWT antes de leer o escribir nada (ver flujo_estudiante.ts). Nunca exponer
// esta key al frontend.


export interface AlumnoIdioma {
  id: string;
  perfil_id: string;
  idioma_codigo: string;
}

export type CambiosSesion = Partial<Pick<Sesion, "unidad_id" | "etapa_actual" | "fase_correccion" | "requisitos_etapa">>;

export interface Repositorio {
  obtenerAlumnoIdioma(id: string): Promise<AlumnoIdioma | null>;
  obtenerRolPerfil(usuarioId: string): Promise<string | null>;
  obtenerSesion(alumnoIdiomaId: string): Promise<Sesion | null>;
  crearSesion(d: { alumno_idioma_id: string; unidad_id: string; etapa_actual: number; requisitos_etapa: Requisitos }): Promise<Sesion>;
  /** Compare-and-set sobre actualizado_en: si otra petición cambió la sesión → 105. */
  actualizarSesion(sesion: Sesion, cambios: CambiosSesion): Promise<Sesion>;
  obtenerEstados(alumnoIdiomaId: string): Promise<FilaEstadoUnidad[]>;
  /** non_acquis → en_cours. Nunca degrada una unidad ya acquis/consolide. */
  iniciarUnidad(alumnoIdiomaId: string, unidadId: string): Promise<void>;
  /** → acquis. Nunca degrada una unidad consolide. */
  marcarAcquis(alumnoIdiomaId: string, unidadId: string): Promise<void>;
  insertarEvidencias(filas: FilaEvidenciaNueva[]): Promise<void>;
  obtenerEvidenciasUnidad(alumnoIdiomaId: string, unidadId: string): Promise<FilaEvidencia[]>;
  obtenerEvidenciasRecientes(alumnoIdiomaId: string, limite: number): Promise<FilaEvidencia[]>;
  guardarPuntaje(alumnoIdiomaId: string, unidadId: string, puntaje: number): Promise<void>;
  obtenerPila(alumnoIdiomaId: string): Promise<string[]>;
  reemplazarPila(alumnoIdiomaId: string, pila: string[], motivo: string): Promise<void>;
  obtenerLecciones(idiomaCodigo: string): Promise<LeccionDeclarada[]>;
  obtenerContenidoLivrable(unidadId: string): Promise<string | null>;
  subirArchivo(ruta: string, bytes: Uint8Array, mediaType: string): Promise<void>;
  ping(): Promise<boolean>;
}

export function crearClienteAdmin(): SupabaseClient {
  // Supabase inyecta SUPABASE_SERVICE_ROLE_KEY. Como no deja crear secrets que
  // empiecen por SUPABASE_, CLAVE_SERVICIO es la alternativa manual (p. ej. si
  // el proyecto solo usa las claves nuevas sb_secret_...).
  const clave = secretOpcional("SUPABASE_SERVICE_ROLE_KEY") ?? secretOpcional("CLAVE_SERVICIO");
  if (!clave) throw new ErrorApp(598, "Falta SUPABASE_SERVICE_ROLE_KEY (o el secret alternativo CLAVE_SERVICIO)");
  return createClient(secretObligatorio("SUPABASE_URL"), clave, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Valida el JWT del usuario con Supabase Auth. */
export async function obtenerUsuarioDelToken(db: SupabaseClient, jwt: string): Promise<{ id: string }> {
  const { data, error } = await db.auth.getUser(jwt);
  // No confundir "Auth no respondió" con "tu sesión no vale": lo primero es
  // problema nuestro, y pedirle al alumno que vuelva a entrar no lo arreglaría.
  const status = (error as { status?: number } | null)?.status;
  if (error && (error.name === "AuthRetryableFetchError" || status === 0 || (status ?? 0) >= 500)) {
    throw new ErrorApp(106, `Supabase Auth no respondió: ${error.message}`, { status });
  }
  if (error || !data?.user) throw new ErrorApp(401, `JWT inválido: ${error?.message ?? "sin usuario"}`);
  return { id: data.user.id };
}

type ErrorPg = { message: string; code?: string } | null;

function fallo(error: ErrorPg, operacion: string, escritura: boolean): never {
  const e = error ?? { message: "desconocido" };
  if (e.code === "23505" || e.code === "23503" || e.code === "23514" || e.code === "P0001") {
    throw new ErrorApp(102, `${operacion}: ${e.message}`, { pg: e.code });
  }
  throw new ErrorApp(escritura ? 104 : 101, `${operacion}: ${e.message}`, { pg: e.code });
}

const SESION_COLUMNAS = "id, alumno_idioma_id, unidad_id, etapa_actual, fase_correccion, requisitos_etapa, actualizado_en";

export class RepositorioSupabase implements Repositorio {
  constructor(private readonly db: SupabaseClient, private readonly bucket: string) {}

  async obtenerAlumnoIdioma(id: string): Promise<AlumnoIdioma | null> {
    const { data, error } = await this.db
      .from("alumno_idioma")
      .select("id, perfil_id, idiomas!inner(codigo)")
      .eq("id", id)
      .maybeSingle();
    if (error) fallo(error, "leer alumno_idioma", false);
    if (!data) return null;
    const idiomas = (data as unknown as { idiomas: { codigo: string } | { codigo: string }[] }).idiomas;
    const codigo = Array.isArray(idiomas) ? idiomas[0]?.codigo : idiomas?.codigo;
    return { id: data.id, perfil_id: data.perfil_id, idioma_codigo: codigo };
  }

  async obtenerRolPerfil(usuarioId: string): Promise<string | null> {
    const { data, error } = await this.db.from("perfiles").select("rol").eq("id", usuarioId).maybeSingle();
    if (error) fallo(error, "leer perfil", false);
    return data?.rol ?? null;
  }

  async obtenerSesion(alumnoIdiomaId: string): Promise<Sesion | null> {
    const { data, error } = await this.db
      .from("sesion_leccion")
      .select(SESION_COLUMNAS)
      .eq("alumno_idioma_id", alumnoIdiomaId)
      .maybeSingle();
    if (error) fallo(error, "leer sesion_leccion", false);
    return (data as Sesion | null) ?? null;
  }

  async crearSesion(d: { alumno_idioma_id: string; unidad_id: string; etapa_actual: number; requisitos_etapa: Requisitos }): Promise<Sesion> {
    const { data, error } = await this.db
      .from("sesion_leccion")
      .insert({ ...d, fase_correccion: null, actualizado_en: new Date().toISOString() })
      .select(SESION_COLUMNAS)
      .single();
    if (error?.code === "23505") throw new ErrorApp(105, "sesion_leccion ya existe (creación concurrente)");
    if (error || !data) fallo(error, "crear sesion_leccion", true);
    return data as Sesion;
  }

  async actualizarSesion(sesion: Sesion, cambios: CambiosSesion): Promise<Sesion> {
    const { data, error } = await this.db
      .from("sesion_leccion")
      .update({ ...cambios, actualizado_en: new Date().toISOString() })
      .eq("id", sesion.id)
      .eq("actualizado_en", sesion.actualizado_en)
      .select(SESION_COLUMNAS);
    if (error) fallo(error, "actualizar sesion_leccion", true);
    if (!data || data.length === 0) {
      throw new ErrorApp(105, "sesion_leccion modificada por otra petición (CAS)", { sesion_id: sesion.id });
    }
    return data[0] as Sesion;
  }

  async obtenerEstados(alumnoIdiomaId: string): Promise<FilaEstadoUnidad[]> {
    const { data, error } = await this.db
      .from("unidad_estado")
      .select("unidad_id, estado, actualizado_en")
      .eq("alumno_idioma_id", alumnoIdiomaId);
    if (error) fallo(error, "leer unidad_estado", false);
    return (data ?? []) as FilaEstadoUnidad[];
  }

  private async estadoActual(alumnoIdiomaId: string, unidadId: string): Promise<string | null> {
    const { data, error } = await this.db
      .from("unidad_estado")
      .select("estado")
      .eq("alumno_idioma_id", alumnoIdiomaId)
      .eq("unidad_id", unidadId)
      .maybeSingle();
    if (error) fallo(error, "leer unidad_estado", false);
    return data?.estado ?? null;
  }

  async iniciarUnidad(alumnoIdiomaId: string, unidadId: string): Promise<void> {
    const actual = await this.estadoActual(alumnoIdiomaId, unidadId);
    if (actual && actual !== "non_acquis") return; // nunca regresivo (MC-002 §29)
    const { error } = await this.db.from("unidad_estado").upsert(
      { alumno_idioma_id: alumnoIdiomaId, unidad_id: unidadId, estado: "en_cours", actualizado_en: new Date().toISOString() },
      { onConflict: "alumno_idioma_id,unidad_id" },
    );
    if (error) fallo(error, "iniciar unidad", true);
  }

  async marcarAcquis(alumnoIdiomaId: string, unidadId: string): Promise<void> {
    const actual = await this.estadoActual(alumnoIdiomaId, unidadId);
    if (actual === "acquis" || actual === "consolide") return;
    const { error } = await this.db.from("unidad_estado").upsert(
      { alumno_idioma_id: alumnoIdiomaId, unidad_id: unidadId, estado: "acquis", actualizado_en: new Date().toISOString() },
      { onConflict: "alumno_idioma_id,unidad_id" },
    );
    if (error) fallo(error, "marcar acquis", true);
  }

  async insertarEvidencias(filas: FilaEvidenciaNueva[]): Promise<void> {
    if (filas.length === 0) return;
    const { error } = await this.db.from("evidencia").insert(filas);
    if (error) fallo(error, "insertar evidencia", true);
  }

  async obtenerEvidenciasUnidad(alumnoIdiomaId: string, unidadId: string): Promise<FilaEvidencia[]> {
    const { data, error } = await this.db
      .from("evidencia")
      .select("*")
      .eq("alumno_idioma_id", alumnoIdiomaId)
      .eq("unidad_id", unidadId)
      .order("creado_en", { ascending: true });
    if (error) fallo(error, "leer evidencia de la unidad", false);
    return (data ?? []) as FilaEvidencia[];
  }

  async obtenerEvidenciasRecientes(alumnoIdiomaId: string, limite: number): Promise<FilaEvidencia[]> {
    const { data, error } = await this.db
      .from("evidencia")
      .select("id, unidad_id, creado_en, diagnosticos, metricas, nivel_ejercicio, etapa_mc001")
      .eq("alumno_idioma_id", alumnoIdiomaId)
      .order("creado_en", { ascending: false })
      .limit(limite);
    if (error) fallo(error, "leer evidencia reciente", false);
    return (data ?? []) as unknown as FilaEvidencia[];
  }

  async guardarPuntaje(alumnoIdiomaId: string, unidadId: string, puntaje: number): Promise<void> {
    const { error } = await this.db.from("puntaje_leccion").upsert(
      { alumno_idioma_id: alumnoIdiomaId, unidad_id: unidadId, puntaje, calculado_en: new Date().toISOString() },
      { onConflict: "alumno_idioma_id,unidad_id" },
    );
    if (error) fallo(error, "guardar puntaje", true);
  }

  async obtenerPila(alumnoIdiomaId: string): Promise<string[]> {
    const { data, error } = await this.db
      .from("rama_interrumpida")
      .select("unidad_id, orden_pila")
      .eq("alumno_idioma_id", alumnoIdiomaId)
      .order("orden_pila", { ascending: true });
    if (error) fallo(error, "leer pila", false);
    return (data ?? []).map((f) => f.unidad_id as string);
  }

  async reemplazarPila(alumnoIdiomaId: string, pila: string[], motivo: string): Promise<void> {
    const { error: e1 } = await this.db.from("rama_interrumpida").delete().eq("alumno_idioma_id", alumnoIdiomaId);
    if (e1) fallo(e1, "vaciar pila", true);
    if (pila.length === 0) return;
    const { error: e2 } = await this.db.from("rama_interrumpida").insert(
      pila.map((dominio, i) => ({ alumno_idioma_id: alumnoIdiomaId, unidad_id: dominio, motivo, orden_pila: i })),
    );
    if (e2) fallo(e2, "escribir pila", true);
  }

  async obtenerLecciones(idiomaCodigo: string): Promise<LeccionDeclarada[]> {
    const { data, error } = await this.db
      .from("livrables")
      .select("unidad_id, dominio_id, sous_domaine_id, titulo, orden_declarado, prerequis, estado_redaccion")
      .eq("idioma_codigo", idiomaCodigo);
    if (error) fallo(error, "leer livrables", false);
    return (data ?? []).map((l) => ({ ...l, prerequis: l.prerequis ?? [] })) as LeccionDeclarada[];
  }

  async obtenerContenidoLivrable(unidadId: string): Promise<string | null> {
    const { data, error } = await this.db
      .from("livrables")
      .select("contenido")
      .eq("unidad_id", unidadId)
      .eq("estado_redaccion", "redactado")
      .maybeSingle();
    if (error) fallo(error, "leer contenido de livrable", false);
    return data?.contenido ?? null;
  }

  async subirArchivo(ruta: string, bytes: Uint8Array, mediaType: string): Promise<void> {
    const { error } = await this.db.storage.from(this.bucket).upload(ruta, bytes, { contentType: mediaType, upsert: false });
    if (error) throw new ErrorApp(502, `subir ${ruta}: ${error.message}`);
  }

  async ping(): Promise<boolean> {
    const { error } = await this.db.from("idiomas").select("id").limit(1);
    return !error;
  }
}

// ───────────── completitud.ts ─────────────
// completitud.ts — Umbrales de avance (módulo PURO).
//   Producción inicial: mínimo = techo(total × factor)   (factor = 0.8)
//   Corrección:         100% de los errores señalados
//
// OJO con la coma flotante: con el factor actual (0.8) Math.ceil(n * 0.8) es
// exacto, pero el factor es CALIBRABLE y 10 de los 100 valores entre 0.01 y
// 1.00 fallan: p. ej. 450 * 0.54 = 243.00000000000003 → Math.ceil exigiría 244.
// Por eso se calcula con enteros (puntos básicos), que es exacto siempre.


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

// ───────────── llm_tipos.ts ─────────────
// llm_tipos.ts — Contrato común para cualquier proveedor de IA (patrón adapter).
//
// La lógica del Método Chatito SOLO conoce esta interfaz. Cambiar de proveedor
// = cambiar el secret LLM_PROVIDER; ninguna otra línea del flujo cambia.


export interface ImagenEntrada {
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  base64: string;
}

export interface PeticionLLM {
  /** Tres bloques de system prompt, de más estable a más variable (orden = caché). */
  sistema: {
    /** Idéntico en todas las peticiones → cacheable. */
    estatico: string;
    /** Estable durante una unidad (livrable) → cacheable. */
    contexto: string;
    /** Cambia en cada turno. */
    dinamico: string;
  };
  mensajeUsuario: string;
  imagenes: ImagenEntrada[];
  maxTokens: number;
  temperatura: number;
}

export interface RespuestaLLM {
  texto: string;
  proveedor: string;
  /** Modelo que REALMENTE respondió (con openrouter/free puede variar en cada llamada). */
  modelo: string;
  uso: { entrada?: number; salida?: number; cacheLeida?: number; cacheCreada?: number };
  latenciaMs: number;
}

export interface ProveedorLLM {
  readonly nombre: string;
  readonly modelo: string;
  generar(peticion: PeticionLLM): Promise<RespuestaLLM>;
}

/** Traduce el estado HTTP de un proveedor a nuestro código 2xx. */
export function codigoPorHttp(status: number): CodigoError {
  if (status === 401 || status === 403) return 201;
  if (status === 402) return 207;
  if (status === 429) return 202;
  if (status === 408 || status === 504) return 204;
  return 206;
}

/** fetch con tiempo límite: el agotamiento se convierte en 204, la red caída en 206. */
export async function fetchConLimite(url: string, init: RequestInit, timeoutMs: number, proveedor: string): Promise<Response> {
  const control = new AbortController();
  const temporizador = setTimeout(() => control.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: control.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new ErrorApp(204, `${proveedor}: sin respuesta en ${timeoutMs} ms`, { proveedor });
    }
    throw new ErrorApp(206, `${proveedor}: fallo de red — ${e instanceof Error ? e.message : String(e)}`, { proveedor });
  } finally {
    clearTimeout(temporizador);
  }
}

/** Lee un cuerpo de error del proveedor sin exponer nunca la API key. */
export async function detalleError(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "(cuerpo ilegible)";
  }
}

// ───────────── peticion.ts ─────────────
// peticion.ts — Validación de lo que envía el frontend (módulo PURO).
//
// Contrato del cuerpo (POST, JSON):
//   { "modo": "estudiante", "accion": "continuar",  "alumno_idioma_id": "<uuid>" }
//   { "modo": "estudiante", "accion": "responder",  "alumno_idioma_id": "<uuid>",
//     "mensaje": "texto opcional", "imagenes": [{ "media_type": "image/jpeg", "base64": "..." }] }
//   { "accion": "diagnostico", "probar_llm": false }            (solo rol admin)


const Modo = z.enum(["estudiante", "docente_aprender", "docente_crear"]).default("estudiante");

const ImagenSchema = z.object({
  media_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
  base64: z.string().min(16),
});

export const CuerpoSchema = z.discriminatedUnion("accion", [
  z.object({ accion: z.literal("continuar"), modo: Modo, alumno_idioma_id: z.string().uuid() }),
  z.object({
    accion: z.literal("responder"),
    modo: Modo,
    alumno_idioma_id: z.string().uuid(),
    mensaje: z.string().max(INFRA.MAX_CARACTERES_MENSAJE).optional(),
    imagenes: z.array(ImagenSchema).max(INFRA.MAX_IMAGENES).optional(),
  }),
  z.object({ accion: z.literal("diagnostico"), modo: Modo, probar_llm: z.boolean().optional() }),
]);

export type Cuerpo = z.infer<typeof CuerpoSchema>;

export function validarCuerpo(texto: string): Cuerpo {
  let crudo: unknown;
  try {
    crudo = JSON.parse(texto);
  } catch {
    throw new ErrorApp(306, "el cuerpo no es JSON válido");
  }
  const r = CuerpoSchema.safeParse(crudo);
  if (!r.success) {
    const problemas = r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`);
    throw new ErrorApp(306, `cuerpo fuera de contrato: ${problemas.join(" | ")}`);
  }
  return r.data;
}

export function decodificarBase64(b64: string): Uint8Array {
  const limpio = b64.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
  let binario: string;
  try {
    binario = atob(limpio);
  } catch {
    throw new ErrorApp(307, "base64 inválido");
  }
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

/** Comprueba que el contenido real coincide con el tipo declarado. */
function bytesCoinciden(bytes: Uint8Array, tipo: ImagenEntrada["mediaType"]): boolean {
  const empieza = (...firma: number[]) => firma.every((b, i) => bytes[i] === b);
  switch (tipo) {
    case "image/jpeg":
      return empieza(0xff, 0xd8, 0xff);
    case "image/png":
      return empieza(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/webp":
      return empieza(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  }
}

export function validarImagenes(imagenes: Array<{ media_type: ImagenEntrada["mediaType"]; base64: string }> = []): ImagenEntrada[] {
  return imagenes.map((img, i) => {
    const bytes = decodificarBase64(img.base64);
    if (bytes.length > INFRA.MAX_BYTES_IMAGEN) {
      throw new ErrorApp(307, `imagen ${i}: ${bytes.length} bytes (máx. ${INFRA.MAX_BYTES_IMAGEN}); redúcela en el frontend`);
    }
    if (!bytesCoinciden(bytes, img.media_type)) {
      throw new ErrorApp(307, `imagen ${i}: el contenido no es un ${img.media_type} real`);
    }
    return { mediaType: img.media_type, base64: img.base64.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "") };
  });
}

// ───────────── salida_llm.ts ─────────────
// salida_llm.ts — Contratos de salida del agente y su validación.
//
// División de responsabilidades:
//   el LLM PERCIBE  → transcribe, cuenta lo entregado, detecta errores, diagnostica
//   el CÓDIGO DECIDE → umbral 80%/100%, avance de étape, estado de la unidad
// Los totales pedidos los fija el sistema al registrar la solicitud; en la
// evaluación el LLM solo reporta lo ENTREGADO y lo CORRECTO.


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

// ───────────── prompt.ts ─────────────
// prompt.ts — Construcción del prompt (módulo PURO).
//
// Carga selectiva: el agente NO recibe MC-OPERACIONAL completo. El orden de
// étapes, los umbrales y la secuenciación los ejecuta el código; el agente solo
// recibe las reglas que necesita para la tarea de ESTE turno.
//
// Tres bloques, ordenados de más estable a más variable para aprovechar la
// caché de prompt del proveedor:
//   estatico  → idéntico en todas las peticiones
//   contexto  → livrable de la unidad (estable durante toda la unidad)
//   dinamico  → tarea y estado del turno


export type Tarea =
  | { tipo: "presentar"; paso: PasoPlan; siguiente: PasoPlan | null; incluirSolicitud: boolean }
  | { tipo: "solicitar"; paso: PasoPlan }
  | { tipo: "evaluar"; paso: PasoPlan; requisitos: Requisitos; estudiadas: Array<{ id: string; titulo: string }> }
  | { tipo: "corregir"; paso: PasoPlan; errores: ErrorSenalado[] }
  | { tipo: "verificar_correccion"; paso: PasoPlan; errores: ErrorSenalado[] };

export function bloqueEstatico(mc: McOperacional, idiomaInterfaz: string): string {
  const p = mc.principios_rectores;
  return `# Rol
Eres el agente pedagógico del Método Chatito. EJECUTAS lecciones; no diseñas el currículo.

# Principios no negociables
- P8: ${p.P8_declarativo_procedimental?.regla ?? ""}
- P9: ${p.P9_ejecucion_interactiva?.regla ?? ""}
- P10: ${p.P10_separacion_declaracion_secuenciamiento?.regla ?? ""}
- El SISTEMA (no tú) decide qué unidad se enseña, en qué étape se está y si el alumno avanza. Nunca anuncies que el alumno "pasa", "aprueba" o "avanza": el sistema lo comunica aparte.
- Nunca preguntes por el nivel previo del alumno.
- Todo el contenido sale EXCLUSIVAMENTE del livrable incluido en el contexto. No inventes reglas, excepciones ni ejemplos que contradigan el livrable. Si algo necesario no está en él, dilo en tu mensaje en vez de inventarlo.

# Corrección (MC-002)
- Alcance: ${mc.evidencia_y_estado.regla_de_scope_de_correccion.regla}
- Los errores fuera de alcance se reportan con fuera_de_scope=true y NO se mencionan en el mensaje al alumno.
- Corrección analítica: qué está mal, la forma correcta, por qué y qué regla del livrable aplica.
- Un error por causa: si una misma producción tiene causas independientes, repórtalas como errores separados.
- causa ∈ {${CAUSAS.join(", ")}}.
- Si un error fuera de alcance corresponde a una unidad ya estudiada (lista en el contexto del turno), pon su id en unidad_relacionada; si no, null.
- Corrección proporcional: no conviertas cada detalle en una lección.

# Idioma
- Explicaciones e instrucciones al alumno: en ${idiomaInterfaz}. Ejemplos y ejercicios: en la lengua meta.

# Formato de salida (OBLIGATORIO)
Responde SOLO con un objeto JSON válido: sin texto antes ni después y sin bloques de código.
Según la TAREA indicada en el contexto del turno:
- presentar / solicitar:
  {"mensaje_para_alumno": string, "solicitud": null | {"enunciado": string, "niveles": [{"nivel": 1|2|3|null, "total_pedido": entero>0, "unidad_medida": "ejercicios"|"palabras"|"frases"}]}}
- evaluar:
  {"mensaje_para_alumno": string, "transcripcion": string, "niveles": [{"nivel": entero|null, "total_entregado": entero>=0, "items_evaluados": entero>=0, "items_correctos": entero>=0}], "errores": [{"fragmento": string, "correccion": string, "causa": string, "explicacion": string, "fuera_de_scope": boolean, "unidad_relacionada": string|null, "nivel": entero|null}]}
- corregir:
  {"mensaje_para_alumno": string}
- verificar_correccion:
  {"mensaje_para_alumno": string, "transcripcion": string, "indices_corregidos": [entero]}`;
}

export function bloqueContexto(unidad: { id: string; titulo: string; dominio: string; idioma: string }, livrable: string): string {
  return `# Unidad activa
- id: ${unidad.id} — ${unidad.titulo}
- dominio: ${unidad.dominio} — lengua meta: ${unidad.idioma}

# Livrable (fuente declarativa ÚNICA de esta lección)
<livrable>
${livrable}
</livrable>`;
}

export function bloqueDinamico(mc: McOperacional, tarea: Tarea): string {
  const ciclo = mc.leccion.ciclo_12_etapas;
  const etapas = describirEtapas(ciclo, tarea.paso.etapas);

  switch (tarea.tipo) {
    case "presentar": {
      const partes = [
        `TAREA: presentar`,
        `Presenta, en este orden y basándote solo en el livrable, las étapes: ${etapas}.`,
      ];
      if (tarea.paso.cierra_unidad) {
        partes.push(`Es el CIERRE de la unidad: recapitula el vocabulario. "solicitud" debe ser null.`);
      } else if (tarea.incluirSolicitud && tarea.siguiente) {
        partes.push(
          `Dentro de la étape 14, declara las transformaciones previstas para la étape 18, sin ejecutarlas.`,
          `Antes de pedir producción, declara las formas de evidencia esperadas por nivel (étape 15). Tómalas del livrable; si el livrable no las declara, dilo y usa los ejemplos de MC-001 §15 (nivel 1: respuesta escrita corta; nivel 2: frase completa; nivel 3: producción libre escrita o foto de producción manuscrita).`,
          instruccionSolicitud(mc, tarea.siguiente),
        );
      } else {
        partes.push(`"solicitud" debe ser null.`);
      }
      return partes.join("\n");
    }
    case "solicitar":
      return [
        `TAREA: solicitar`,
        `Declara primero las formas de evidencia esperadas para esta producción (étape 15), tomándolas del livrable.`,
        instruccionSolicitud(mc, tarea.paso),
        tarea.paso.etapas.includes(18)
          ? `Ejecuta, con el alumno, las transformaciones previstas declaradas en la étape 14 del livrable, sobre las frases principales producidas o estudiadas en la lección (ya corregidas en la étape 17).`
          : "",
      ].filter(Boolean).join("\n");

    case "evaluar": {
      const r = tarea.requisitos;
      const niveles = (r.niveles ?? [])
        .map((n) => `  - nivel ${n.nivel ?? "único"}: pedido ${n.total_pedido} ${n.unidad_medida}, mínimo ${n.minimo_requerido}`)
        .join("\n");
      const previas = (r.transcripciones_previas ?? []).length
        ? `Entregas ANTERIORES de este mismo paso (evalúa la UNIÓN de todo lo entregado):\n${
          r.transcripciones_previas!.map((t, i) => `  [${i + 1}] ${t}`).join("\n")
        }`
        : `Es la primera entrega de este paso.`;
      const estudiadas = tarea.estudiadas.length
        ? tarea.estudiadas.map((u) => `${u.id} (${u.titulo})`).join(", ")
        : "ninguna";
      return [
        `TAREA: evaluar`,
        `Paso: ${tarea.paso.paso} — étapes ${etapas} — categoría ${tarea.paso.categoria}.`,
        `Enunciado que recibió el alumno:\n${r.enunciado ?? "(no disponible)"}`,
        `Requisitos:\n${niveles}`,
        previas,
        `Unidades ya estudiadas (para unidad_relacionada): ${estudiadas}.`,
        `Métricas por nivel: total_entregado = ítems (o palabras) realmente entregados; items_correctos = correctos SOLO respecto del objetivo de la unidad.`,
        tarea.paso.categoria === "libre"
          ? `Producción libre: items_evaluados = ocurrencias del objetivo de la unidad en el texto; items_correctos = las correctas.`
          : `Ejercicios: items_evaluados = ítems entregados que pudiste evaluar.`,
        `Si en algún nivel lo entregado no alcanza el mínimo: pide completar SOLO lo que falta.`,
        tarea.paso.correccion === "diferida"
          ? `La corrección de este paso es DIFERIDA a la étape 17 (MC-001 §17): en tu mensaje NO corrijas ni señales errores; acusa recibo y, si procede, pide lo que falta. Aun así, reporta TODOS los errores en el JSON.`
          : `Si alcanza el mínimo y hay errores dentro del alcance: presenta la corrección con su diagnóstico y pide reescribir SOLO lo señalado. Si no alcanza el mínimo, no corrijas todavía.`,
        `transcripcion: transcribe fielmente lo que produjo el alumno (texto e imágenes).`,
      ].join("\n");
    }

    case "corregir":
      return [
        `TAREA: corregir`,
        `Étape 17 — Correction détaillée. La fase 1 (colecta de evidencia de las étapes 15 y 16) ya terminó.`,
        `Fase 2 — corrección diferida: corrige frase por frase, con la explicación gramatical de cada error según el livrable.`,
        `Fase 3 — diagnóstico: indica para cada error su causa probable (tipología de MC-002).`,
        `Errores que debes corregir (no añadas otros):`,
        ...tarea.errores.map((e) =>
          `  [${e.indice}] (${e.paso ?? "?"}) "${e.fragmento}" → "${e.correccion}" — causa: ${e.causa ?? "?"} — ${e.explicacion}`
        ),
        `Termina pidiendo al alumno que reescriba cada fragmento señalado.`,
      ].join("\n");

    case "verificar_correccion":
      return [
        `TAREA: verificar_correccion`,
        `Errores señalados que el alumno debía corregir:`,
        ...tarea.errores.map((e) => `  [${e.indice}] "${e.fragmento}" → esperado: "${e.correccion}" (${e.explicacion})`),
        `Devuelve en indices_corregidos los índices corregidos CORRECTAMENTE.`,
        `Una corrección vale aunque difiera de la forma sugerida, si es gramaticalmente correcta respecto del objetivo de la unidad.`,
        `En el mensaje: confirma lo corregido y explica brevemente lo que siga pendiente.`,
      ].join("\n");
  }
}

function instruccionSolicitud(mc: McOperacional, paso: PasoPlan): string {
  const descripciones = mc.leccion.ciclo_12_etapas.find((e) => paso.etapas.includes(e.n))?.niveles ?? {};
  const niveles = (paso.niveles ?? [null])
    .map((n) => (n === null ? "único (nivel null)" : `${n}${descripciones[String(n)] ? ` = ${descripciones[String(n)]}` : ""}`))
    .join("; ");
  return `Después, solicita la producción del paso "${paso.paso}" (étapes ${describirEtapas(mc.leccion.ciclo_12_etapas, paso.etapas)}), niveles: ${niveles}. ` +
    `En "solicitud" incluye el enunciado COMPLETO y numerado, y un elemento en "niveles" por cada nivel con su total_pedido.`;
}

// ───────────── puntaje.ts ─────────────
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

// ───────────── secuenciacion.ts ─────────────
// secuenciacion.ts — Motor de secuenciación MC-009 (módulo PURO, sin IA).
//
// Implementa MC-009 v1.0.0:
//   §8   nodo accesible = todos sus prerrequisitos ENSEÑADOS (no consolidados)
//   §9   potencial de expansión = nº de nodos alcanzables por dependencia
//   §10  selección de rama por mayor potencial
//   §11  progresión vertical dentro de la rama activa
//   §13  desvío por prerrequisito indispensable de otra rama
//   §14  pila de ramas interrumpidas (último en entrar, primero en salir)
//   §15  retorno a la rama pausada, sin reevaluar potencial
//   §16  los nodos transversales NO compiten por selección de rama
//   §23  cada decisión es justificable a posteriori (campo `justificacion`)
//
// Reglas operativas v1 (MC-OPERACIONAL.secuenciacion): dominio agotado,
// bloqueo por falta de contenido, política de desempate declarada.
//
// El LLM NUNCA participa en esta decisión (Principio 10).


export interface EntradaSecuenciacion {
  grafo: Grafo;
  lecciones: LeccionDeclarada[];
  /** unidad_id de las lecciones enseñadas (estado acquis o consolide). */
  ensenadas: ReadonlySet<string>;
  /** Dominios pausados, de la base al tope. */
  pila: string[];
  /** Dominio de la última lección completada (null si es la primera decisión). */
  ramaActiva: string | null;
  politicaDesempate: CriterioDesempate[];
}

export type RazonBloqueo = "leccion_sin_redactar" | "dominio_sin_lecciones_declaradas" | "sin_rama_accesible";

export type ResultadoSecuenciacion =
  | {
    tipo: "leccion";
    unidadId: string;
    dominioId: string;
    pila: string[];
    justificacion: string[];
    desempateAplicado: boolean;
  }
  | {
    tipo: "bloqueado";
    razon: RazonBloqueo;
    unidadId?: string;
    dominioId?: string;
    pila: string[];
    justificacion: string[];
  }
  | { tipo: "curriculo_completado"; pila: string[]; justificacion: string[] };

type Bloqueo = { bloqueo: RazonBloqueo; unidadId?: string; dominioId?: string };

/** Dominios que dependen (directa o transitivamente) de `dominioId`. */
export function dependientesTransitivos(grafo: Grafo, dominioId: string): Set<string> {
  const inversas = new Map<string, string[]>();
  for (const d of grafo.dominios) {
    for (const p of d.prerequis) inversas.set(p, [...(inversas.get(p) ?? []), d.id]);
  }
  const vistos = new Set<string>();
  const cola = [...(inversas.get(dominioId) ?? [])];
  while (cola.length) {
    const actual = cola.shift()!;
    if (vistos.has(actual)) continue;
    vistos.add(actual);
    cola.push(...(inversas.get(actual) ?? []));
  }
  return vistos;
}

export function potencialExpansion(grafo: Grafo, dominioId: string): number {
  return dependientesTransitivos(grafo, dominioId).size;
}

class MotorSecuenciacion {
  private readonly dominios = new Map<string, DominioGrafo>();
  private readonly indiceDeclaracion = new Map<string, number>();
  private readonly lecciones = new Map<string, LeccionDeclarada>();
  private readonly porDominio = new Map<string, LeccionDeclarada[]>();
  readonly justificacion: string[] = [];
  desempateAplicado = false;

  constructor(private readonly e: EntradaSecuenciacion) {
    e.grafo.dominios.forEach((d, i) => {
      if (this.dominios.has(d.id)) throw new ErrorApp(309, `Dominio duplicado en el grafo: ${d.id}`);
      if (d.nature !== "transversal" && d.nature !== "sequentiel") {
        throw new ErrorApp(309, `Naturaleza inválida en ${d.id}: ${d.nature}`);
      }
      this.dominios.set(d.id, d);
      this.indiceDeclaracion.set(d.id, i);
    });
    for (const d of e.grafo.dominios) {
      for (const p of d.prerequis) {
        if (!this.dominios.has(p)) throw new ErrorApp(309, `${d.id} declara un prerrequisito inexistente: ${p}`);
      }
    }
    this.verificarAciclicoDominios();

    for (const l of e.lecciones) {
      if (this.lecciones.has(l.unidad_id)) throw new ErrorApp(309, `Lección duplicada: ${l.unidad_id}`);
      if (!this.dominios.has(l.dominio_id)) {
        throw new ErrorApp(309, `La lección ${l.unidad_id} apunta a un dominio inexistente: ${l.dominio_id}`);
      }
      this.lecciones.set(l.unidad_id, l);
      this.porDominio.set(l.dominio_id, [...(this.porDominio.get(l.dominio_id) ?? []), l]);
    }
    for (const [dominioId, lista] of this.porDominio) {
      lista.sort((a, b) => this.compararIntraDominio(dominioId, a, b));
    }
  }

  // ---------- Estructura ----------
  private verificarAciclicoDominios(): void {
    const estado = new Map<string, 1 | 2>(); // 1 = visitando, 2 = terminado
    const visitar = (id: string, camino: string[]) => {
      if (estado.get(id) === 2) return;
      if (estado.get(id) === 1) throw new ErrorApp(309, `Ciclo de prerrequisitos: ${[...camino, id].join(" → ")}`);
      estado.set(id, 1);
      for (const p of this.dominios.get(id)!.prerequis) visitar(p, [...camino, id]);
      estado.set(id, 2);
    };
    for (const id of this.dominios.keys()) visitar(id, []);
  }

  /** MC-009 §21: primer sous-domaine declarado, y dentro de él el primer contenido declarado. */
  private compararIntraDominio(dominioId: string, a: LeccionDeclarada, b: LeccionDeclarada): number {
    const sous = this.dominios.get(dominioId)!.sous_domaines ?? [];
    const ia = a.sous_domaine_id ? sous.indexOf(a.sous_domaine_id) : -1;
    const ib = b.sous_domaine_id ? sous.indexOf(b.sous_domaine_id) : -1;
    const pa = ia < 0 ? Number.MAX_SAFE_INTEGER : ia;
    const pb = ib < 0 ? Number.MAX_SAFE_INTEGER : ib;
    if (pa !== pb) return pa - pb;
    if (a.orden_declarado !== b.orden_declarado) return a.orden_declarado - b.orden_declarado;
    // Ambigüedad de datos: se desempata técnicamente y se deja constancia.
    this.justificacion.push(
      `AVISO: ${a.unidad_id} y ${b.unidad_id} comparten sous-domaine y orden_declarado; ` +
        `se usó el identificador como desempate técnico. Declarar orden_declarado distinto.`,
    );
    return a.unidad_id.localeCompare(b.unidad_id);
  }

  // ---------- Consultas ----------
  private esLeccion(id: string): boolean {
    return this.lecciones.has(id);
  }

  private agotado(dominioId: string): boolean {
    const lista = this.porDominio.get(dominioId) ?? [];
    return lista.length > 0 && lista.every((l) => this.e.ensenadas.has(l.unidad_id));
  }

  private satisfecho(prerequisito: string): boolean {
    const dominio = this.dominios.get(prerequisito);
    if (dominio) return dominio.nature === "transversal" || this.agotado(prerequisito);
    if (this.esLeccion(prerequisito)) return this.e.ensenadas.has(prerequisito);
    throw new ErrorApp(309, `Prerrequisito desconocido (ni dominio ni lección declarada): ${prerequisito}`);
  }

  private siguienteDelDominio(dominioId: string): LeccionDeclarada | null {
    return (this.porDominio.get(dominioId) ?? []).find((l) => !this.e.ensenadas.has(l.unidad_id)) ?? null;
  }

  private pendientesDe(l: LeccionDeclarada): string[] {
    const propios = this.dominios.get(l.dominio_id)!.prerequis;
    return [...new Set([...l.prerequis, ...propios])].filter((p) => !this.satisfecho(p));
  }

  private accesible(d: DominioGrafo): boolean {
    return d.prerequis.every((p) => this.satisfecho(p));
  }

  private potencial(dominioId: string): number {
    return potencialExpansion(this.e.grafo, dominioId);
  }

  // ---------- Resolución de una lección objetivo (desvíos §13–§14) ----------
  private resolver(l: LeccionDeclarada, pila: string[], visitados: Set<string>): LeccionDeclarada | Bloqueo {
    if (visitados.has(l.unidad_id)) {
      throw new ErrorApp(309, `Ciclo de prerrequisitos entre lecciones en ${l.unidad_id}`);
    }
    visitados.add(l.unidad_id);

    const pendientes = this.pendientesDe(l);
    if (pendientes.length === 0) {
      if (l.estado_redaccion !== "redactado") {
        this.justificacion.push(`${l.unidad_id} está declarada pero no redactada: bloqueo (no se salta de rama).`);
        return { bloqueo: "leccion_sin_redactar", unidadId: l.unidad_id, dominioId: l.dominio_id };
      }
      return l;
    }

    const falta = pendientes[0];
    let objetivo: LeccionDeclarada | null;
    if (this.esLeccion(falta)) {
      objetivo = this.lecciones.get(falta)!;
    } else {
      objetivo = this.siguienteDelDominio(falta);
      if (!objetivo) {
        this.justificacion.push(`El prerrequisito ${falta} no tiene lecciones declaradas: bloqueo.`);
        return { bloqueo: "dominio_sin_lecciones_declaradas", dominioId: falta };
      }
    }

    if (objetivo.dominio_id !== l.dominio_id && pila[pila.length - 1] !== l.dominio_id) {
      pila.push(l.dominio_id);
      this.justificacion.push(
        `Desvío (MC-009 §13): ${l.unidad_id} requiere ${falta}; se pausa la rama ${l.dominio_id}.`,
      );
    }
    return this.resolver(objetivo, pila, visitados);
  }

  // ---------- Decisión principal ----------
  decidir(): ResultadoSecuenciacion {
    const pila = this.e.pila.filter((id) => {
      const existe = this.dominios.has(id);
      if (!existe) this.justificacion.push(`AVISO: la pila contenía un dominio inexistente (${id}); se descarta.`);
      return existe;
    });

    // 1. Ramas pausadas (MC-009 §15): se reanuda por continuidad.
    while (pila.length) {
      const tope = pila[pila.length - 1];
      const sig = this.siguienteDelDominio(tope);
      if (!sig) {
        pila.pop();
        this.justificacion.push(`La rama pausada ${tope} ya no tiene lecciones pendientes; se desapila.`);
        continue;
      }
      if (this.pendientesDe(sig).length === 0) {
        pila.pop();
        this.justificacion.push(`Prerrequisito satisfecho: se reanuda la rama ${tope} en ${sig.unidad_id} (MC-009 §15).`);
        return this.terminar(this.resolver(sig, pila, new Set()), pila);
      }
      this.justificacion.push(`La rama pausada ${tope} aún espera prerrequisitos; el desvío continúa.`);
      return this.terminar(this.resolver(sig, pila, new Set()), pila);
    }

    // 2. Progresión vertical en la rama activa (MC-009 §11).
    if (this.e.ramaActiva) {
      const d = this.dominios.get(this.e.ramaActiva);
      if (d && d.nature === "sequentiel" && !this.agotado(d.id)) {
        const sig = this.siguienteDelDominio(d.id);
        if (!sig) {
          return this.terminar({ bloqueo: "dominio_sin_lecciones_declaradas", dominioId: d.id }, pila);
        }
        this.justificacion.push(`Progresión vertical en la rama activa ${d.id} (MC-009 §11).`);
        return this.terminar(this.resolver(sig, pila, new Set()), pila);
      }
      if (d) this.justificacion.push(`La rama ${d.id} está agotada; se selecciona una nueva rama.`);
    }

    // 3. Selección de una nueva rama (MC-009 §10) — solo nodos secuenciales (§16).
    const secuenciales = [...this.dominios.values()].filter((d) => d.nature === "sequentiel");
    const sinAgotar = secuenciales.filter((d) => !this.agotado(d.id));
    if (sinAgotar.length === 0) {
      this.justificacion.push("Todos los dominios secuenciales están agotados.");
      return { tipo: "curriculo_completado", pila, justificacion: this.justificacion };
    }
    const accesibles = sinAgotar.filter((d) => this.accesible(d));
    if (accesibles.length === 0) {
      this.justificacion.push(`Ningún dominio pendiente es accesible: ${sinAgotar.map((d) => d.id).join(", ")}.`);
      return this.terminar({ bloqueo: "sin_rama_accesible" }, pila);
    }

    const elegida = this.elegirRama(accesibles);
    const sig = this.siguienteDelDominio(elegida.id);
    if (!sig) {
      this.justificacion.push(`La rama ${elegida.id} no tiene lecciones declaradas.`);
      return this.terminar({ bloqueo: "dominio_sin_lecciones_declaradas", dominioId: elegida.id }, pila);
    }
    return this.terminar(this.resolver(sig, pila, new Set()), pila);
  }

  private elegirRama(accesibles: DominioGrafo[]): DominioGrafo {
    const conPotencial = accesibles.map((d) => ({ d, pot: this.potencial(d.id) }));
    const maximo = Math.max(...conPotencial.map((x) => x.pot));
    let grupo = conPotencial.filter((x) => x.pot === maximo).map((x) => x.d);
    const resumen = conPotencial.map((x) => `${x.d.id}=${x.pot}`).join(", ");

    if (grupo.length === 1) {
      this.justificacion.push(`Rama elegida ${grupo[0].id} por mayor potencial de expansión (${resumen}) (MC-009 §10).`);
      return grupo[0];
    }

    this.desempateAplicado = true;
    this.justificacion.push(`Empate de potencial (${resumen}): se aplica la política de desempate declarada.`);
    for (const criterio of this.e.politicaDesempate) {
      if (grupo.length === 1) break;
      if (criterio === "contenido_disponible") {
        const conContenido = grupo.filter((d) => this.siguienteDelDominio(d.id)?.estado_redaccion === "redactado");
        if (conContenido.length > 0 && conContenido.length < grupo.length) {
          this.justificacion.push(`Criterio «contenido_disponible»: quedan ${conContenido.map((d) => d.id).join(", ")}.`);
          grupo = conContenido;
        }
      } else if (criterio === "orden_declaracion_arquitectura") {
        grupo = [...grupo].sort((a, b) => this.indiceDeclaracion.get(a.id)! - this.indiceDeclaracion.get(b.id)!);
        this.justificacion.push(`Criterio «orden_declaracion_arquitectura»: se elige ${grupo[0].id}.`);
        grupo = [grupo[0]];
      }
    }
    if (grupo.length > 1) {
      grupo.sort((a, b) => this.indiceDeclaracion.get(a.id)! - this.indiceDeclaracion.get(b.id)!);
      this.justificacion.push(`AVISO: la política declarada no resolvió el empate; desempate técnico por orden de declaración.`);
    }
    return grupo[0];
  }

  private terminar(r: LeccionDeclarada | Bloqueo, pila: string[]): ResultadoSecuenciacion {
    if ("bloqueo" in r) {
      // En un bloqueo NO se persisten cambios parciales de la pila.
      return {
        tipo: "bloqueado",
        razon: r.bloqueo,
        unidadId: r.unidadId,
        dominioId: r.dominioId,
        pila: [...this.e.pila],
        justificacion: this.justificacion,
      };
    }
    this.justificacion.push(`Siguiente lección: ${r.unidad_id}.`);
    return {
      tipo: "leccion",
      unidadId: r.unidad_id,
      dominioId: r.dominio_id,
      pila,
      justificacion: this.justificacion,
      desempateAplicado: this.desempateAplicado,
    };
  }
}

export function decidirSiguiente(entrada: EntradaSecuenciacion): ResultadoSecuenciacion {
  return new MotorSecuenciacion(entrada).decidir();
}

// ───────────── reactivacion.ts ─────────────
// reactivacion.ts — Motor de prioridad de reactivación, MC-006 §15bis (módulo PURO).
//
// PRINCIPIO NO NEGOCIABLE (MC-006 §26, MC-002 §29): este módulo solo produce
// una SUGERENCIA. Nunca modifica el estado de una unidad. El estado solo cambia
// con evidencia nueva observada durante una reactivación real.
//
// El azar NO es una señal sumada: es un sorteo independiente (MC-006 §15bis.1).


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

// ───────────── registro.ts ─────────────
// registro.ts — Registro de eventos en la tabla logs_sistema.
//
// Reglas:
//  1. Registrar NUNCA rompe la petición: si la inserción falla, se escribe en la
//     consola (visible en Supabase → Edge Functions → Logs) y se sigue.
//  2. A la tabla solo van eventos con severidad >= INFRA.SEVERIDAD_MINIMA_REGISTRO,
//     más la telemetría explícita (9xx). Todo va también a la consola.
//  3. Privacidad: el contexto lleva identificadores y datos técnicos, no el
//     contenido del alumno (única excepción: fragmento truncado de 300
//     caracteres en errores 203, para depurar respuestas malformadas).


const ORDEN: Record<Severidad, number> = { info: 0, warning: 1, error: 2, critico: 3 };

export interface EventoRegistro {
  codigo: CodigoError;
  severidad?: Severidad;
  mensaje?: string;
  contexto?: Record<string, unknown>;
  stack?: string;
  duracionMs?: number;
}

export interface Registrador {
  usuarioId: string | null;
  registrar(evento: EventoRegistro): Promise<void>;
  registrarError(error: ErrorApp, duracionMs?: number): Promise<void>;
}

export class RegistradorSupabase implements Registrador {
  usuarioId: string | null = null;

  constructor(
    private readonly db: SupabaseClient,
    private readonly requestId: string,
  ) {}

  async registrar(e: EventoRegistro): Promise<void> {
    const severidad = e.severidad ?? CATALOGO[e.codigo].severidad;
    const fila = {
      request_id: this.requestId,
      usuario_id: this.usuarioId,
      codigo: e.codigo,
      severidad,
      mensaje: e.mensaje ?? CATALOGO[e.codigo].nombre,
      contexto: e.contexto ?? {},
      stack_trace: e.stack ?? null,
      duracion_ms: e.duracionMs ?? null,
    };
    console.log(JSON.stringify({ nivel: severidad, ...fila }));

    const esTelemetria = e.codigo >= 900;
    if (!esTelemetria && ORDEN[severidad] < ORDEN[INFRA.SEVERIDAD_MINIMA_REGISTRO]) return;
    try {
      const { error } = await this.db.from("logs_sistema").insert(fila);
      if (error) console.error(JSON.stringify({ nivel: "error", registro_fallido: error.message }));
    } catch (err) {
      console.error(JSON.stringify({ nivel: "error", registro_fallido: String(err) }));
    }
  }

  registrarError(error: ErrorApp, duracionMs?: number): Promise<void> {
    return this.registrar({
      codigo: error.codigo,
      severidad: error.severidad,
      mensaje: error.detalleTecnico,
      contexto: error.contexto,
      stack: error.codigo === 599 ? error.stack : undefined,
      duracionMs,
    });
  }
}

/** Registrador para pruebas y para cuando la BD no está disponible. */
export class RegistradorConsola implements Registrador {
  usuarioId: string | null = null;
  readonly eventos: EventoRegistro[] = [];

  registrar(e: EventoRegistro): Promise<void> {
    this.eventos.push(e);
    console.log(JSON.stringify({ nivel: e.severidad ?? CATALOGO[e.codigo].severidad, codigo: e.codigo, mensaje: e.mensaje, contexto: e.contexto }));
    return Promise.resolve();
  }
  registrarError(error: ErrorApp): Promise<void> {
    return this.registrar({ codigo: error.codigo, mensaje: error.detalleTecnico, contexto: error.contexto });
  }
}

// ───────────── flujo_estudiante.ts ─────────────
// flujo_estudiante.ts — Modo estudiante (MC-OPERACIONAL.modos_operacion.estudiante).
//
// Estados del paso (sesion_leccion.requisitos_etapa.estado_paso):
//   pendiente_presentar  → "continuar" entrega el paso (presentación o solicitud)
//   esperando_evidencia  → "responder" evalúa la producción (umbral 80%)
//   esperando_correccion → "responder" verifica la corrección (umbral 100%)
//   curriculo_bloqueado / curriculo_completado → "continuar" reintenta MC-009
//
// Reglas de orden (consistencia sin transacciones):
//   1. La evidencia se escribe ANTES del avance: nunca se avanza sin evidencia;
//      si el avance falla, la evidencia queda (es append-only) y se reintenta.
//   2. sesion_leccion se actualiza al FINAL (punto de confirmación, con CAS).
//   3. El LLM se llama solo cuando hace falta (retomar una sesión no gasta cuota).
//   4. Las imágenes se envían al LLM UNA vez; después solo se usa su transcripción.


// ---------- Dependencias inyectadas (reales en producción, falsas en pruebas) ----------
export interface ServiciosAuxiliares {
  verificarLimiteGlobalLLM(): Promise<{ permitido: boolean; reintentarEnSeg: number }>;
  leerLivrable(unidadId: string): Promise<string | null>;
  guardarLivrable(unidadId: string, contenido: string): Promise<void>;
}

export interface ContextoFlujo {
  repo: Repositorio;
  registro: Registrador;
  auxiliares: ServiciosAuxiliares | null;
  obtenerLLM: () => ProveedorLLM;
  mc: McOperacional;
  grafos: Readonly<Record<string, Grafo>>;
  usuarioId: string;
  requestId: string;
  ahora: () => Date;
  aleatorio: () => number;
  fallarAbiertoSiRedisCae: boolean;
}

export interface PeticionEstudiante {
  accion: "continuar" | "responder";
  alumno_idioma_id: string;
  mensaje?: string;
  imagenes?: ImagenEntrada[];
}

interface Estado {
  ai: AlumnoIdioma;
  grafo: Grafo;
  lecciones: LeccionDeclarada[];
  sesion: Sesion | null;
}

const MENSAJE_CONTINUAR = "(El alumno pulsó «continuar».)";

// =====================================================================
// Entrada
// =====================================================================
export async function manejarEstudiante(ctx: ContextoFlujo, p: PeticionEstudiante): Promise<RespuestaFlujo> {
  const ai = await ctx.repo.obtenerAlumnoIdioma(p.alumno_idioma_id);
  // Mismo error si no existe o si es de otro usuario: no revelar qué IDs existen.
  if (!ai || ai.perfil_id !== ctx.usuarioId) {
    throw new ErrorApp(403, "alumno_idioma inexistente o ajeno", { alumno_idioma_id: p.alumno_idioma_id });
  }
  const grafo = ctx.grafos[ai.idioma_codigo];
  if (!grafo) throw new ErrorApp(308, `Sin grafo para el idioma ${ai.idioma_codigo}`);

  const s: Estado = {
    ai,
    grafo,
    lecciones: await ctx.repo.obtenerLecciones(ai.idioma_codigo),
    sesion: await ctx.repo.obtenerSesion(ai.id),
  };
  return p.accion === "continuar" ? await continuar(ctx, s) : await responder(ctx, s, p);
}

// =====================================================================
// Acción "continuar"
// =====================================================================
async function continuar(ctx: ContextoFlujo, s: Estado): Promise<RespuestaFlujo> {
  const plan = ctx.mc.leccion.plan_ejecucion.pasos;

  if (!s.sesion) {
    const { r, pilaOriginal } = await decidir(ctx, s, null);
    if (r.tipo !== "leccion") return respuestaSinSesion(r);
    await aplicarPila(ctx, s, r, pilaOriginal);
    await ctx.repo.iniciarUnidad(s.ai.id, r.unidadId);
    s.sesion = await ctx.repo.crearSesion({
      alumno_idioma_id: s.ai.id,
      unidad_id: r.unidadId,
      etapa_actual: plan[0].etapas[0],
      requisitos_etapa: { paso: plan[0].paso, estado_paso: "pendiente_presentar", justificacion_secuenciacion: r.justificacion },
    });
  }

  const req = s.sesion.requisitos_etapa;
  switch (req.estado_paso) {
    case "esperando_evidencia":
    case "esperando_correccion":
      // Retomar tras recargar la app: sin llamar al LLM.
      return {
        mensaje_agente: req.ultimo_mensaje_agente ?? req.enunciado ?? null,
        mensaje_sistema: "Retomamos donde te quedaste.",
        estado: estadoPublico(s.sesion),
      };

    case "curriculo_bloqueado":
    case "curriculo_completado": {
      // Quizá el autor ya redactó la lección que faltaba: se reintenta MC-009.
      const { r, pilaOriginal } = await decidir(ctx, s, dominioDe(s, s.sesion.unidad_id));
      if (r.tipo !== "leccion") {
        return { mensaje_agente: null, mensaje_sistema: textoSinLeccion(r), estado: estadoPublico(s.sesion) };
      }
      await aplicarPila(ctx, s, r, pilaOriginal);
      await ctx.repo.iniciarUnidad(s.ai.id, r.unidadId);
      s.sesion = await ctx.repo.actualizarSesion(s.sesion, {
        unidad_id: r.unidadId,
        etapa_actual: plan[0].etapas[0],
        fase_correccion: null,
        requisitos_etapa: { paso: plan[0].paso, estado_paso: "pendiente_presentar", justificacion_secuenciacion: r.justificacion },
      });
      return await entregarPaso(ctx, s);
    }

    case "pendiente_presentar":
      return await entregarPaso(ctx, s);
  }
}

async function entregarPaso(ctx: ContextoFlujo, s: Estado): Promise<RespuestaFlujo> {
  const plan = ctx.mc.leccion.plan_ejecucion.pasos;
  const sesion = s.sesion!;
  const paso = pasoPorNombre(plan, sesion.requisitos_etapa.paso);
  const acumulados = sesion.requisitos_etapa.errores_acumulados;
  if (paso.tipo === "correccion") return await entregarCorreccion(ctx, s, paso);
  const livrable = await cargarLivrable(ctx, sesion.unidad_id);

  if (paso.tipo === "presentacion") {
    const siguiente = siguientePaso(plan, paso);
    const incluirSolicitud = !paso.cierra_unidad && siguiente?.tipo === "produccion";
    const salida = await llamarLLM<SalidaSolicitud>(ctx, s, livrable, {
      tarea: { tipo: "presentar", paso, siguiente, incluirSolicitud },
      mensaje: MENSAJE_CONTINUAR,
      imagenes: [],
      esquema: SalidaSolicitudSchema,
      maxTokens: INFRA.MAX_TOKENS_PRESENTACION,
      temperatura: 0.5,
    });

    if (paso.cierra_unidad) return await completarUnidad(ctx, s, salida.mensaje_para_alumno);
    if (!siguiente) throw new ErrorApp(598, `El paso ${paso.paso} no tiene sucesor y no cierra la unidad`);

    if (incluirSolicitud && salida.solicitud) {
      const niveles = normalizarSolicitud(ctx, siguiente, salida.solicitud);
      s.sesion = await ctx.repo.actualizarSesion(sesion, {
        etapa_actual: siguiente.etapas[0],
        fase_correccion: faseDe(siguiente),
        requisitos_etapa: {
          paso: siguiente.paso,
          estado_paso: "esperando_evidencia",
          enunciado: salida.solicitud.enunciado,
          niveles,
          transcripciones_previas: [],
          errores_acumulados: acumulados,
          ultimo_mensaje_agente: salida.mensaje_para_alumno,
        },
      });
      return { mensaje_agente: salida.mensaje_para_alumno, mensaje_sistema: textoPedido(niveles), estado: estadoPublico(s.sesion) };
    }

    if (incluirSolicitud) {
      await ctx.registro.registrar({
        codigo: 203,
        severidad: "warning",
        mensaje: "La presentación no incluyó la solicitud; se pedirá en el siguiente «continuar».",
        contexto: { paso: paso.paso, unidad_id: sesion.unidad_id },
      });
    }
    s.sesion = await ctx.repo.actualizarSesion(sesion, {
      etapa_actual: siguiente.etapas[0],
      fase_correccion: null,
      requisitos_etapa: { paso: siguiente.paso, estado_paso: "pendiente_presentar", errores_acumulados: acumulados },
    });
    return { mensaje_agente: salida.mensaje_para_alumno, mensaje_sistema: null, estado: estadoPublico(s.sesion) };
  }

  // Paso de producción: solicitar (declarando antes las formas de evidencia, MC-001 §15).
  const salida = await llamarLLM<SalidaSolicitud>(ctx, s, livrable, {
    tarea: { tipo: "solicitar", paso },
    mensaje: MENSAJE_CONTINUAR,
    imagenes: [],
    esquema: SalidaSolicitudSchema,
    maxTokens: INFRA.MAX_TOKENS_PRESENTACION,
    temperatura: 0.5,
  });
  if (!salida.solicitud) throw new ErrorApp(203, "La tarea «solicitar» devolvió solicitud = null", { paso: paso.paso });
  const niveles = normalizarSolicitud(ctx, paso, salida.solicitud);
  s.sesion = await ctx.repo.actualizarSesion(sesion, {
    etapa_actual: paso.etapas[0],
    fase_correccion: faseDe(paso),
    requisitos_etapa: {
      paso: paso.paso,
      estado_paso: "esperando_evidencia",
      enunciado: salida.solicitud.enunciado,
      niveles,
      transcripciones_previas: [],
      errores_acumulados: acumulados,
      ultimo_mensaje_agente: salida.mensaje_para_alumno,
    },
  });
  return { mensaje_agente: salida.mensaje_para_alumno, mensaje_sistema: textoPedido(niveles), estado: estadoPublico(s.sesion) };
}

// =====================================================================
// Acción "responder"
// =====================================================================
async function responder(ctx: ContextoFlujo, s: Estado, p: PeticionEstudiante): Promise<RespuestaFlujo> {
  if (!s.sesion) throw new ErrorApp(310, "No hay sesión activa: primero «continuar»");
  const texto = (p.mensaje ?? "").trim();
  const imagenes = p.imagenes ?? [];
  if (!texto && imagenes.length === 0) throw new ErrorApp(306, "Respuesta vacía: sin texto ni imágenes");

  switch (s.sesion.requisitos_etapa.estado_paso) {
    case "esperando_evidencia":
      return await evaluarEntrega(ctx, s, texto, imagenes);
    case "esperando_correccion":
      return await verificarCorreccion(ctx, s, texto, imagenes);
    default:
      throw new ErrorApp(310, `El estado ${s.sesion.requisitos_etapa.estado_paso} no espera respuesta`);
  }
}

async function evaluarEntrega(ctx: ContextoFlujo, s: Estado, texto: string, imagenes: ImagenEntrada[]): Promise<RespuestaFlujo> {
  const plan = ctx.mc.leccion.plan_ejecucion.pasos;
  const sesion = s.sesion!;
  const req = sesion.requisitos_etapa;
  const paso = pasoPorNombre(plan, req.paso);
  if (paso.tipo !== "produccion" || !req.niveles?.length) {
    throw new ErrorApp(598, `Estado incoherente: esperando evidencia en ${paso.paso} sin niveles`);
  }

  const livrable = await cargarLivrable(ctx, sesion.unidad_id);
  const salida = await llamarLLM<SalidaEvaluacion>(ctx, s, livrable, {
    tarea: { tipo: "evaluar", paso, requisitos: req, estudiadas: await unidadesEstudiadas(ctx, s) },
    mensaje: texto || "(El alumno envió solo imágenes.)",
    imagenes,
    esquema: SalidaEvaluacionSchema,
    maxTokens: INFRA.MAX_TOKENS_EVALUACION,
    temperatura: 0.2,
  });

  const metricas = emparejarNiveles(req.niveles, salida.niveles);
  const factor = ctx.mc.modos_operacion.estudiante.criterio_completitud.factor_minimo;
  const decision = evaluarProduccion(
    metricas.map((m) => ({ nivel: m.nivel, total_pedido: m.total_pedido, total_entregado: m.total_entregado })),
    factor,
  );
  const intento: Intento = (req.transcripciones_previas?.length ?? 0) === 0 ? "inicial" : "complemento";
  const archivos = await subirImagenes(ctx, s, imagenes);
  const contenido = componerContenido(texto, imagenes.length, salida.transcripcion);
  // Corrección diferida (MC-001 §17): sin evidencia completa no hay corrección ni diagnóstico.
  const enAlcance = decision.cumple ? salida.errores.filter((e) => !e.fuera_de_scope) : [];
  const nivelesValidos = new Set(metricas.map((m) => m.nivel));

  const filas: FilaEvidenciaNueva[] = metricas.map((m, i) => {
    const propios = (lista: ErrorDetectado[]) =>
      lista.filter((e) => e.nivel === m.nivel || (i === 0 && !nivelesValidos.has(e.nivel)));
    const erroresFila = propios(enAlcance);
    return {
      alumno_idioma_id: s.ai.id,
      unidad_id: sesion.unidad_id,
      etapa_mc001: paso.etapas[0],
      nivel_ejercicio: m.nivel,
      tipo_contenido: imagenes.length ? "imagen" : "texto",
      contenido_alumno: contenido,
      url_storage: archivos[0] ?? null,
      correccion: erroresFila.length ? erroresFila.map((e) => `${e.fragmento} → ${e.correccion}`).join("\n") : null,
      diagnosticos: decision.cumple ? propios(salida.errores) : null,
      metricas: {
        paso: paso.paso,
        intento,
        categoria: paso.categoria,
        total_pedido: m.total_pedido,
        unidad_medida: m.unidad_medida,
        minimo_requerido: m.minimo_requerido,
        total_entregado: m.total_entregado,
        items_evaluados: m.items_evaluados,
        items_correctos: m.items_correctos,
        diagnostico_diferido: !decision.cumple,
        archivos,
      },
    };
  });
  await ctx.repo.insertarEvidencias(filas); // ← ANTES de cualquier avance

  if (!decision.cumple) {
    s.sesion = await ctx.repo.actualizarSesion(sesion, {
      requisitos_etapa: {
        ...req,
        transcripciones_previas: [...(req.transcripciones_previas ?? []), salida.transcripcion],
        ultimo_mensaje_agente: salida.mensaje_para_alumno,
      },
    });
    const faltas = decision.detalle
      .filter((d) => !d.cumple)
      .map((d) => `nivel ${d.nivel ?? "único"}: ${d.entregado} de ${d.pedido} (mínimo ${d.minimo})`)
      .join("; ");
    return {
      mensaje_agente: salida.mensaje_para_alumno,
      mensaje_sistema: `Aún falta producción — ${faltas}. Envía solo lo que falta.`,
      resultado: "requiere_completar",
      estado: estadoPublico(s.sesion),
    };
  }

  const aSenalado = (e: ErrorDetectado, indice: number): ErrorSenalado => ({
    indice,
    fragmento: e.fragmento,
    correccion: e.correccion,
    explicacion: e.explicacion,
    causa: e.causa,
    paso: paso.paso,
  });

  if (paso.correccion === "diferida") {
    // MC-001 §17: la corrección espera a que termine la colecta de las étapes 15 y 16.
    const previos = req.errores_acumulados ?? [];
    const acumulados = [...previos, ...enAlcance.map((e, i) => aSenalado(e, previos.length + i))];
    return await avanzar(
      ctx,
      s,
      paso,
      salida.mensaje_para_alumno,
      "Producción registrada. La corrección se hará en la étape 17, con toda la evidencia reunida.",
      acumulados,
    );
  }

  if (enAlcance.length > 0) {
    const senalados: ErrorSenalado[] = enAlcance.map((e, i) => aSenalado(e, i));
    s.sesion = await ctx.repo.actualizarSesion(sesion, {
      etapa_actual: ctx.mc.leccion.plan_ejecucion.etapa_correccion,
      fase_correccion: "correction_differee",
      requisitos_etapa: {
        ...req,
        estado_paso: "esperando_correccion",
        errores_senalados: senalados,
        ultimo_mensaje_agente: salida.mensaje_para_alumno,
      },
    });
    return {
      mensaje_agente: salida.mensaje_para_alumno,
      mensaje_sistema: `Hay ${senalados.length} corrección(es) pendiente(s). Para continuar se exige corregir el 100%.`,
      resultado: "requiere_correccion",
      estado: estadoPublico(s.sesion),
    };
  }

  return await avanzar(ctx, s, paso, salida.mensaje_para_alumno, "Paso completado.");
}

async function verificarCorreccion(ctx: ContextoFlujo, s: Estado, texto: string, imagenes: ImagenEntrada[]): Promise<RespuestaFlujo> {
  const plan = ctx.mc.leccion.plan_ejecucion.pasos;
  const sesion = s.sesion!;
  const req = sesion.requisitos_etapa;
  const paso = pasoPorNombre(plan, req.paso);
  const senalados = req.errores_senalados ?? [];
  if (senalados.length === 0) {
    await ctx.registro.registrar({ codigo: 598, severidad: "warning", mensaje: "esperando_correccion sin errores señalados; se avanza" });
    return await avanzar(ctx, s, paso, null, "Paso completado.");
  }

  const livrable = await cargarLivrable(ctx, sesion.unidad_id);
  const salida = await llamarLLM(ctx, s, livrable, {
    tarea: { tipo: "verificar_correccion", paso, errores: senalados },
    mensaje: texto || "(El alumno envió solo imágenes.)",
    imagenes,
    esquema: SalidaCorreccionSchema,
    maxTokens: INFRA.MAX_TOKENS_EVALUACION,
    temperatura: 0.2,
  });

  const r = evaluarCorreccion(senalados.map((e) => e.indice), salida.indices_corregidos);
  const archivos = await subirImagenes(ctx, s, imagenes);
  await ctx.repo.insertarEvidencias([{
    alumno_idioma_id: s.ai.id,
    unidad_id: sesion.unidad_id,
    etapa_mc001: ctx.mc.leccion.plan_ejecucion.etapa_correccion,
    nivel_ejercicio: null,
    tipo_contenido: imagenes.length ? "imagen" : "texto",
    contenido_alumno: componerContenido(texto, imagenes.length, salida.transcripcion),
    url_storage: archivos[0] ?? null,
    correccion: null,
    diagnosticos: null,
    metricas: {
      paso: paso.paso,
      intento: "correccion",
      errores_senalados: senalados.length,
      errores_corregidos: r.corregidos,
      archivos,
    },
  }]);

  if (r.completa) return await avanzar(ctx, s, paso, salida.mensaje_para_alumno, "Corrección completa (100%).");

  const pendientes = senalados.filter((e) => r.pendientes.includes(e.indice));
  s.sesion = await ctx.repo.actualizarSesion(sesion, {
    requisitos_etapa: { ...req, errores_senalados: pendientes, ultimo_mensaje_agente: salida.mensaje_para_alumno },
  });
  return {
    mensaje_agente: salida.mensaje_para_alumno,
    mensaje_sistema: `Corregiste ${r.corregidos} de ${senalados.length}. Faltan ${pendientes.length}.`,
    resultado: "correccion_incompleta",
    estado: estadoPublico(s.sesion),
  };
}

async function avanzar(
  ctx: ContextoFlujo,
  s: Estado,
  paso: PasoPlan,
  mensajeAgente: string | null,
  mensajeSistema: string,
  acumulados: ErrorSenalado[] | undefined = s.sesion!.requisitos_etapa.errores_acumulados,
): Promise<RespuestaFlujo> {
  const siguiente = siguientePaso(ctx.mc.leccion.plan_ejecucion.pasos, paso);
  if (!siguiente) throw new ErrorApp(598, `El paso ${paso.paso} no tiene sucesor`);
  s.sesion = await ctx.repo.actualizarSesion(s.sesion!, {
    etapa_actual: siguiente.etapas[0],
    fase_correccion: null,
    requisitos_etapa: {
      paso: siguiente.paso,
      estado_paso: "pendiente_presentar",
      ...(acumulados?.length ? { errores_acumulados: acumulados } : {}),
    },
  });
  return { mensaje_agente: mensajeAgente, mensaje_sistema: mensajeSistema, resultado: "avanza", estado: estadoPublico(s.sesion) };
}

// =====================================================================
// Étape 17 — corrección diferida de las étapes 15 y 16
// =====================================================================
async function entregarCorreccion(ctx: ContextoFlujo, s: Estado, paso: PasoPlan): Promise<RespuestaFlujo> {
  const sesion = s.sesion!;
  const errores = sesion.requisitos_etapa.errores_acumulados ?? [];
  const siguiente = siguientePaso(ctx.mc.leccion.plan_ejecucion.pasos, paso);
  if (!siguiente) throw new ErrorApp(598, `El paso de corrección ${paso.paso} no tiene sucesor`);

  if (errores.length === 0) {
    // Nada que corregir: se entrega directamente el paso siguiente en esta misma petición.
    s.sesion = await ctx.repo.actualizarSesion(sesion, {
      etapa_actual: siguiente.etapas[0],
      fase_correccion: null,
      requisitos_etapa: { paso: siguiente.paso, estado_paso: "pendiente_presentar" },
    });
    const r = await entregarPaso(ctx, s);
    return {
      ...r,
      mensaje_sistema: ["Étape 17: no hubo errores dentro del alcance que corregir.", r.mensaje_sistema].filter(Boolean).join(" "),
    };
  }

  const senalados = errores.map((e, i) => ({ ...e, indice: i }));
  const livrable = await cargarLivrable(ctx, sesion.unidad_id);
  const salida = await llamarLLM(ctx, s, livrable, {
    tarea: { tipo: "corregir", paso, errores: senalados },
    mensaje: MENSAJE_CONTINUAR,
    imagenes: [],
    esquema: SalidaMensajeSchema,
    maxTokens: INFRA.MAX_TOKENS_PRESENTACION,
    temperatura: 0.3,
  });
  s.sesion = await ctx.repo.actualizarSesion(sesion, {
    etapa_actual: paso.etapas[0],
    fase_correccion: "correction_differee",
    requisitos_etapa: {
      paso: paso.paso,
      estado_paso: "esperando_correccion",
      errores_senalados: senalados,
      ultimo_mensaje_agente: salida.mensaje_para_alumno,
    },
  });
  return {
    mensaje_agente: salida.mensaje_para_alumno,
    mensaje_sistema: `Corrección de las étapes 15 y 16: ${senalados.length} error(es). Reescribe cada uno; se exige el 100% para continuar.`,
    resultado: "requiere_correccion",
    estado: estadoPublico(s.sesion),
  };
}

// =====================================================================
// Cierre de unidad: acquis → puntaje → motor (sugerencia) → MC-009
// =====================================================================
async function completarUnidad(ctx: ContextoFlujo, s: Estado, mensajeAgente: string): Promise<RespuestaFlujo> {
  const sesion = s.sesion!;
  const unidadId = sesion.unidad_id;

  await ctx.repo.marcarAcquis(s.ai.id, unidadId);

  const pesos = ctx.mc.evidencia_y_estado.puntaje_leccion.pesos_iniciales_a_calibrar;
  const puntaje = calcularPuntaje(await ctx.repo.obtenerEvidenciasUnidad(s.ai.id, unidadId), pesos);
  if (puntaje !== null) await ctx.repo.guardarPuntaje(s.ai.id, unidadId, puntaje);

  // El motor solo SUGIERE; si falla, el cierre de la unidad no se bloquea.
  let sugerencia: SugerenciaReactivacion | null = null;
  try {
    const r = evaluarMotor({
      grafo: s.grafo,
      lecciones: s.lecciones,
      estados: await ctx.repo.obtenerEstados(s.ai.id),
      evidencias: await ctx.repo.obtenerEvidenciasRecientes(s.ai.id, INFRA.MAX_EVIDENCIAS_MOTOR),
      excluir: unidadId,
      ahora: ctx.ahora(),
      parametros: parametrosMotor(ctx.mc),
      aleatorio: ctx.aleatorio,
    });
    if (r.tipo !== "ninguna" && r.unidadId) {
      sugerencia = { unidad_id: r.unidadId, motivo: r.tipo, prioridad: r.prioridad ?? null };
    }
  } catch (e) {
    const err = normalizarError(e);
    await ctx.registro.registrar({ codigo: err.codigo, severidad: "warning", mensaje: `motor de reactivación: ${err.detalleTecnico}` });
  }

  const { r, pilaOriginal } = await decidir(ctx, s, dominioDe(s, unidadId));
  const plan = ctx.mc.leccion.plan_ejecucion.pasos;
  let requisitos: Requisitos;
  let cambios: Parameters<Repositorio["actualizarSesion"]>[1];

  if (r.tipo === "leccion") {
    await aplicarPila(ctx, s, r, pilaOriginal);
    await ctx.repo.iniciarUnidad(s.ai.id, r.unidadId);
    requisitos = { paso: plan[0].paso, estado_paso: "pendiente_presentar", justificacion_secuenciacion: r.justificacion };
    cambios = { unidad_id: r.unidadId, etapa_actual: plan[0].etapas[0], fase_correccion: null, requisitos_etapa: requisitos };
  } else if (r.tipo === "bloqueado") {
    requisitos = {
      paso: null,
      estado_paso: "curriculo_bloqueado",
      bloqueo: { razon: r.razon, unidad_id: r.unidadId, dominio_id: r.dominioId },
      justificacion_secuenciacion: r.justificacion,
    };
    cambios = { fase_correccion: null, requisitos_etapa: requisitos };
  } else {
    requisitos = { paso: null, estado_paso: "curriculo_completado", justificacion_secuenciacion: r.justificacion };
    cambios = { fase_correccion: null, requisitos_etapa: requisitos };
  }
  s.sesion = await ctx.repo.actualizarSesion(sesion, cambios); // ← punto de confirmación

  const siguiente = r.tipo === "leccion" ? ` Siguiente unidad: ${r.unidadId}.` : ` ${textoSinLeccion(r)}`;
  return {
    mensaje_agente: mensajeAgente,
    mensaje_sistema: `Unidad ${unidadId} completada.${siguiente}`,
    resultado: "unidad_completada",
    estado: estadoPublico(s.sesion),
    sugerencia_reactivacion: sugerencia,
  };
}

// =====================================================================
// MC-009 y pila
// =====================================================================
async function decidir(ctx: ContextoFlujo, s: Estado, ramaActiva: string | null) {
  const estados = await ctx.repo.obtenerEstados(s.ai.id);
  const ensenadas = new Set(estados.filter((e) => e.estado === "acquis" || e.estado === "consolide").map((e) => e.unidad_id));
  const pilaOriginal = await ctx.repo.obtenerPila(s.ai.id);
  const r = decidirSiguiente({
    grafo: s.grafo,
    lecciones: s.lecciones,
    ensenadas,
    pila: pilaOriginal,
    ramaActiva,
    politicaDesempate: ctx.mc.secuenciacion.politica_desempate_declarada.criterios_en_orden,
  });
  // Trazabilidad de MC-009 §23: toda decisión queda registrada con su porqué.
  await ctx.registro.registrar({
    codigo: 901,
    contexto: { alumno_idioma_id: s.ai.id, resultado: r.tipo, justificacion: r.justificacion },
  });
  if (r.tipo === "bloqueado") {
    await ctx.registro.registrar({
      codigo: 305,
      mensaje: `MC-009 bloqueado: ${r.razon}`,
      contexto: { idioma: s.ai.idioma_codigo, unidad_id: r.unidadId, dominio_id: r.dominioId },
    });
  }
  return { r, pilaOriginal };
}

async function aplicarPila(ctx: ContextoFlujo, s: Estado, r: Extract<ResultadoSecuenciacion, { tipo: "leccion" }>, original: string[]) {
  if (JSON.stringify(r.pila) === JSON.stringify(original)) return;
  const motivo = [...r.justificacion].reverse().find((j) => j.startsWith("Desvío") || j.includes("reanuda")) ?? "MC-009";
  await ctx.repo.reemplazarPila(s.ai.id, r.pila, motivo);
}

// =====================================================================
// LLM, livrables e imágenes
// =====================================================================
async function conRedis<T>(ctx: ContextoFlujo, operacion: (a: ServiciosAuxiliares) => Promise<T>, siFalla: T): Promise<T> {
  if (!ctx.auxiliares) return siFalla;
  try {
    return await operacion(ctx.auxiliares);
  } catch (e) {
    if (!ctx.fallarAbiertoSiRedisCae) throw new ErrorApp(501, `Redis: ${normalizarError(e).detalleTecnico}`);
    await ctx.registro.registrar({ codigo: 501, mensaje: `Redis falló (se continúa): ${normalizarError(e).detalleTecnico}` });
    return siFalla;
  }
}

async function cargarLivrable(ctx: ContextoFlujo, unidadId: string): Promise<string> {
  const enCache = await conRedis(ctx, (a) => a.leerLivrable(unidadId), null);
  if (enCache) return enCache;
  const contenido = await ctx.repo.obtenerContenidoLivrable(unidadId);
  if (!contenido) throw new ErrorApp(305, `El livrable ${unidadId} no tiene contenido redactado`, { unidad_id: unidadId });
  await conRedis(ctx, (a) => a.guardarLivrable(unidadId, contenido), undefined);
  return contenido;
}

interface OpcionesLLM<T> {
  tarea: Tarea;
  mensaje: string;
  imagenes: ImagenEntrada[];
  esquema: Parameters<typeof parsearSalida<T>>[0];
  maxTokens: number;
  temperatura: number;
}

async function llamarLLM<T>(ctx: ContextoFlujo, s: Estado, livrable: string, o: OpcionesLLM<T>): Promise<T> {
  const limite = await conRedis(ctx, (a) => a.verificarLimiteGlobalLLM(), { permitido: true, reintentarEnSeg: 0 });
  if (!limite.permitido) {
    throw new ErrorApp(430, "Tope diario global de llamadas al LLM alcanzado", { reintentar_en_seg: limite.reintentarEnSeg });
  }

  const unidad = s.lecciones.find((l) => l.unidad_id === s.sesion!.unidad_id);
  const peticion: PeticionLLM = {
    sistema: {
      estatico: bloqueEstatico(ctx.mc, INFRA.IDIOMA_INTERFAZ),
      contexto: bloqueContexto(
        { id: s.sesion!.unidad_id, titulo: unidad?.titulo ?? "", dominio: unidad?.dominio_id ?? "", idioma: s.ai.idioma_codigo },
        livrable,
      ),
      dinamico: bloqueDinamico(ctx.mc, o.tarea),
    },
    mensajeUsuario: o.mensaje,
    imagenes: o.imagenes,
    maxTokens: o.maxTokens,
    temperatura: o.temperatura,
  };

  const llm = ctx.obtenerLLM();
  const respuesta = await llm.generar(peticion);
  if (INFRA.REGISTRAR_USO_LLM) {
    await ctx.registro.registrar({
      codigo: 900,
      contexto: {
        tarea: o.tarea.tipo,
        proveedor: respuesta.proveedor,
        modelo: respuesta.modelo,
        uso: respuesta.uso,
        latencia_ms: respuesta.latenciaMs,
        imagenes: o.imagenes.length,
      },
    });
  }
  return parsearSalida(o.esquema, respuesta.texto, { tarea: o.tarea.tipo, proveedor: respuesta.proveedor, modelo: respuesta.modelo });
}

async function subirImagenes(ctx: ContextoFlujo, s: Estado, imagenes: ImagenEntrada[]): Promise<string[]> {
  const rutas: string[] = [];
  const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
  for (const [i, img] of imagenes.entries()) {
    const ruta = `${ctx.usuarioId}/${s.ai.id}/${s.sesion!.unidad_id}/${ctx.requestId}_${i}.${extension[img.mediaType]}`;
    try {
      await ctx.repo.subirArchivo(ruta, decodificarBase64(img.base64), img.mediaType);
      rutas.push(ruta);
    } catch (e) {
      // Fallo suave: la transcripción ya existe y es la evidencia principal.
      const err = normalizarError(e);
      await ctx.registro.registrar({ codigo: 502, mensaje: err.detalleTecnico, contexto: { ruta } });
    }
  }
  return rutas;
}

// =====================================================================
// Utilidades
// =====================================================================
function normalizarSolicitud(ctx: ContextoFlujo, paso: PasoPlan, solicitud: NonNullable<SalidaSolicitud["solicitud"]>): NivelRequerido[] {
  const factor = ctx.mc.modos_operacion.estudiante.criterio_completitud.factor_minimo;
  const esperados = paso.niveles ?? [null];
  const construir = (nivel: number | null, n: { total_pedido: number; unidad_medida: string }): NivelRequerido => ({
    nivel,
    total_pedido: n.total_pedido,
    unidad_medida: n.unidad_medida,
    minimo_requerido: minimoRequerido(n.total_pedido, factor),
  });
  if (esperados.length === 1) {
    if (solicitud.niveles.length !== 1) {
      throw new ErrorApp(203, `El paso ${paso.paso} pide 1 nivel y la solicitud trae ${solicitud.niveles.length}`);
    }
    return [construir(esperados[0], solicitud.niveles[0])];
  }
  return esperados.map((nivel) => {
    const n = solicitud.niveles.find((x) => x.nivel === nivel);
    if (!n) throw new ErrorApp(203, `La solicitud del paso ${paso.paso} no incluye el nivel ${nivel}`);
    return construir(nivel, n);
  });
}

function emparejarNiveles(requeridos: NivelRequerido[], reportados: SalidaEvaluacion["niveles"]) {
  const limpiar = (r: SalidaEvaluacion["niveles"][number]) => ({
    total_entregado: r.total_entregado,
    items_evaluados: r.items_evaluados,
    items_correctos: Math.min(r.items_correctos, r.items_evaluados),
  });
  if (requeridos.length === 1 && reportados.length === 1) {
    return [{ ...requeridos[0], ...limpiar(reportados[0]) }];
  }
  return requeridos.map((req) => {
    const r = reportados.find((x) => x.nivel === req.nivel);
    if (!r) throw new ErrorApp(203, `La evaluación no reporta el nivel ${req.nivel}`);
    return { ...req, ...limpiar(r) };
  });
}

async function unidadesEstudiadas(ctx: ContextoFlujo, s: Estado) {
  const titulos = new Map(s.lecciones.map((l) => [l.unidad_id, l.titulo]));
  return (await ctx.repo.obtenerEstados(s.ai.id))
    .filter((e) => (e.estado === "acquis" || e.estado === "consolide") && e.unidad_id !== s.sesion!.unidad_id)
    .sort((a, b) => b.actualizado_en.localeCompare(a.actualizado_en))
    .slice(0, 40)
    .map((e) => ({ id: e.unidad_id, titulo: titulos.get(e.unidad_id) ?? "" }));
}

function parametrosMotor(mc: McOperacional): ParametrosMotor {
  const m = mc.consolidacion_continua.motor_reactivacion;
  const f = m.formula_prioridad_reactivacion;
  return {
    ...f.pesos_iniciales_a_calibrar,
    ...f.parametros_normalizacion_iniciales_a_calibrar,
    p_azar: m.hasard.p_azar_inicial_a_calibrar,
  };
}

/** Mientras se recoge producción con corrección diferida, la étape 17 está en su fase 1. */
function faseDe(paso: PasoPlan): Sesion["fase_correccion"] {
  return paso.tipo === "produccion" && paso.correccion === "diferida" ? "collecte_evidence" : null;
}

function dominioDe(s: Estado, unidadId: string): string | null {
  return s.lecciones.find((l) => l.unidad_id === unidadId)?.dominio_id ?? null;
}

function componerContenido(texto: string, numImagenes: number, transcripcion: string): string {
  if (numImagenes === 0) return texto; // la evidencia escrita se guarda literal, no la versión del LLM
  return [texto, `[Transcripción de ${numImagenes} imagen(es)]`, transcripcion].filter(Boolean).join("\n");
}

function textoPedido(niveles: NivelRequerido[]): string {
  return "Se pide — " + niveles.map((n) => `nivel ${n.nivel ?? "único"}: ${n.total_pedido} ${n.unidad_medida}`).join("; ") + ".";
}

function textoSinLeccion(r: ResultadoSecuenciacion): string {
  if (r.tipo === "curriculo_completado") return "Completaste todo el currículo disponible.";
  if (r.tipo !== "bloqueado") return "";
  switch (r.razon) {
    case "leccion_sin_redactar":
      return `La siguiente lección (${r.unidadId}) todavía no está redactada.`;
    case "dominio_sin_lecciones_declaradas":
      return `El dominio ${r.dominioId} todavía no tiene lecciones declaradas.`;
    case "sin_rama_accesible":
      return "Todavía no hay ninguna rama del currículo accesible.";
  }
}

function respuestaSinSesion(r: ResultadoSecuenciacion): RespuestaFlujo {
  return {
    mensaje_agente: null,
    mensaje_sistema: textoSinLeccion(r),
    estado: {
      unidad_id: null,
      etapa_actual: null,
      paso: null,
      fase: r.tipo === "curriculo_completado" ? "curriculo_completado" : "curriculo_bloqueado",
      bloqueo: r.tipo === "bloqueado" ? { razon: r.razon, unidad_id: r.unidadId, dominio_id: r.dominioId } : undefined,
    },
  };
}

export function estadoPublico(sesion: Sesion): EstadoPublico {
  const req = sesion.requisitos_etapa;
  const sinUnidad = req.estado_paso === "curriculo_bloqueado" || req.estado_paso === "curriculo_completado";
  const fase: EstadoPublico["fase"] = req.estado_paso === "pendiente_presentar" ? "listo_para_continuar" : req.estado_paso;
  return {
    unidad_id: sinUnidad ? null : sesion.unidad_id,
    etapa_actual: sinUnidad ? null : sesion.etapa_actual,
    paso: req.paso,
    fase,
    niveles: req.estado_paso === "esperando_evidencia" ? req.niveles : undefined,
    errores_pendientes: req.estado_paso === "esperando_correccion" ? req.errores_senalados?.length : undefined,
    bloqueo: req.bloqueo,
  };
}

// ───────────── llm_claude.ts ─────────────
// llm_claude.ts — Adapter para la API de Anthropic (Messages API).
//
// Caché de prompt: los bloques "estatico" (reglas) y "contexto" (livrable)
// llevan cache_control; en turnos siguientes se cobran como lectura de caché.
// Si un bloque es más corto que el mínimo cacheable del modelo, simplemente no
// se cachea (no es un error).


const URL_ANTHROPIC = "https://api.anthropic.com/v1/messages";
const VERSION_API = "2023-06-01";

interface RespuestaAnthropic {
  model?: string;
  content?: Array<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export class ProveedorClaude implements ProveedorLLM {
  readonly nombre = "claude";

  constructor(
    private readonly apiKey: string,
    readonly modelo: string,
    private readonly timeoutMs: number,
  ) {}

  async generar(p: PeticionLLM): Promise<RespuestaLLM> {
    const sistema = [
      { texto: p.sistema.estatico, cachear: true },
      { texto: p.sistema.contexto, cachear: true },
      { texto: p.sistema.dinamico, cachear: false },
    ]
      .filter((b) => b.texto.trim() !== "") // la API rechaza bloques de texto vacíos
      .map((b) => ({
        type: "text",
        text: b.texto,
        ...(b.cachear ? { cache_control: { type: "ephemeral" } } : {}),
      }));

    const contenido = [
      ...p.imagenes.map((img) => ({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.base64 },
      })),
      { type: "text", text: p.mensajeUsuario },
    ];

    const inicio = performance.now();
    const res = await fetchConLimite(URL_ANTHROPIC, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": VERSION_API,
      },
      body: JSON.stringify({
        model: this.modelo,
        max_tokens: p.maxTokens,
        temperature: p.temperatura,
        system: sistema,
        messages: [{ role: "user", content: contenido }],
      }),
    }, this.timeoutMs, this.nombre);

    if (!res.ok) {
      throw new ErrorApp(codigoPorHttp(res.status), `claude HTTP ${res.status}: ${await detalleError(res)}`, {
        proveedor: this.nombre,
        modelo: this.modelo,
        http: res.status,
      });
    }

    const datos = (await res.json()) as RespuestaAnthropic;
    const texto = (datos.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n")
      .trim();
    if (!texto) throw new ErrorApp(203, "claude devolvió una respuesta sin texto", { proveedor: this.nombre });

    return {
      texto,
      proveedor: this.nombre,
      modelo: datos.model ?? this.modelo,
      uso: {
        entrada: datos.usage?.input_tokens,
        salida: datos.usage?.output_tokens,
        cacheLeida: datos.usage?.cache_read_input_tokens,
        cacheCreada: datos.usage?.cache_creation_input_tokens,
      },
      latenciaMs: Math.round(performance.now() - inicio),
    };
  }
}

// ───────────── llm_openrouter.ts ─────────────
// llm_openrouter.ts — Adapter para OpenRouter (API compatible con OpenAI).
//
// Con el modelo "openrouter/free", OpenRouter elige en cada llamada un modelo
// gratuito compatible con la petición (imágenes, salida JSON...). Por eso se
// registra el modelo que REALMENTE respondió: si un modelo gratuito devuelve
// JSON roto, el registro dice cuál fue.


const URL_OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

interface RespuestaOpenRouter {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { code?: number | string; message?: string };
}

export class ProveedorOpenRouter implements ProveedorLLM {
  readonly nombre = "openrouter";

  constructor(
    private readonly apiKey: string,
    readonly modelo: string,
    private readonly timeoutMs: number,
    private readonly usarModoJson: boolean,
    private readonly urlSitio?: string,
  ) {}

  async generar(p: PeticionLLM): Promise<RespuestaLLM> {
    const sistema = [p.sistema.estatico, p.sistema.contexto, p.sistema.dinamico]
      .filter((t) => t.trim() !== "")
      .join("\n\n");

    const contenidoUsuario = p.imagenes.length === 0 ? p.mensajeUsuario : [
      { type: "text", text: p.mensajeUsuario },
      ...p.imagenes.map((img) => ({
        type: "image_url",
        image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
      })),
    ];

    const cabeceras: Record<string, string> = {
      "content-type": "application/json",
      "authorization": `Bearer ${this.apiKey}`,
      "x-title": "Metodo Chatito",
    };
    if (this.urlSitio) cabeceras["http-referer"] = this.urlSitio;

    const inicio = performance.now();
    const res = await fetchConLimite(URL_OPENROUTER, {
      method: "POST",
      headers: cabeceras,
      body: JSON.stringify({
        model: this.modelo,
        max_tokens: p.maxTokens,
        temperature: p.temperatura,
        messages: [
          { role: "system", content: sistema },
          { role: "user", content: contenidoUsuario },
        ],
        ...(this.usarModoJson ? { response_format: { type: "json_object" } } : {}),
      }),
    }, this.timeoutMs, this.nombre);

    if (!res.ok) {
      throw new ErrorApp(codigoPorHttp(res.status), `openrouter HTTP ${res.status}: ${await detalleError(res)}`, {
        proveedor: this.nombre,
        modelo: this.modelo,
        http: res.status,
      });
    }

    const datos = (await res.json()) as RespuestaOpenRouter;
    // OpenRouter puede responder 200 con un error del proveedor subyacente.
    if (datos.error) {
      const codigoNum = Number(datos.error.code);
      throw new ErrorApp(
        Number.isFinite(codigoNum) ? codigoPorHttp(codigoNum) : 206,
        `openrouter error: ${datos.error.message ?? "sin mensaje"}`,
        { proveedor: this.nombre, modelo: datos.model ?? this.modelo },
      );
    }

    const texto = (datos.choices?.[0]?.message?.content ?? "").trim();
    if (!texto) {
      throw new ErrorApp(203, "openrouter devolvió una respuesta vacía", {
        proveedor: this.nombre,
        modelo: datos.model ?? this.modelo,
      });
    }

    return {
      texto,
      proveedor: this.nombre,
      modelo: datos.model ?? this.modelo,
      uso: { entrada: datos.usage?.prompt_tokens, salida: datos.usage?.completion_tokens },
      latenciaMs: Math.round(performance.now() - inicio),
    };
  }
}

// ───────────── llm_fabrica.ts ─────────────
// llm_fabrica.ts — El único lugar que decide qué proveedor se usa.
//   LLM_PROVIDER = "openrouter" | "claude"
//   LLM_MODEL    = (opcional) sobrescribe el modelo por defecto


export function crearProveedor(): ProveedorLLM {
  const proveedor = (secretOpcional("LLM_PROVIDER") ?? "").toLowerCase();
  const modelo = secretOpcional("LLM_MODEL");

  switch (proveedor) {
    case "claude":
      return new ProveedorClaude(
        claveObligatoria("ANTHROPIC_API_KEY"),
        modelo ?? INFRA.MODELO_CLAUDE_POR_DEFECTO,
        INFRA.TIMEOUT_LLM_MS,
      );
    case "openrouter":
      return new ProveedorOpenRouter(
        claveObligatoria("OPENROUTER_API_KEY"),
        modelo ?? INFRA.MODELO_OPENROUTER_POR_DEFECTO,
        INFRA.TIMEOUT_LLM_MS,
        (secretOpcional("OPENROUTER_MODO_JSON") ?? "true") !== "false",
        secretOpcional("SITIO_URL"),
      );
    default:
      throw new ErrorApp(205, `LLM_PROVIDER inválido o ausente: "${proveedor}" (usa "openrouter" o "claude")`);
  }
}

function claveObligatoria(nombre: string): string {
  try {
    return secretObligatorio(nombre);
  } catch {
    throw new ErrorApp(205, `Falta el secret ${nombre} para el proveedor elegido`);
  }
}

// ───────────── redis.ts ─────────────
// redis.ts — Upstash Redis: rate limit, candado y caché.
//
// Qué se cachea y qué NO:
//   ✔ contenido de livrables (estático, se lee en cada turno de la unidad)
//   ✘ progreso, sesión, estados, evidencia: cachearlos daría decisiones con
//     datos viejos (una étape equivocada) — siempre se leen de la BD.
//
// Secrets: UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN.
// Si faltan, desdeEntorno() devuelve null y el llamador decide (fallar abierto).


const PREFIJO = "mc";

/** Borra el candado solo si sigue siendo nuestro (evita liberar el de otra petición). */
const SCRIPT_LIBERAR = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export interface ResultadoLimite {
  permitido: boolean;
  reintentarEnSeg: number;
}

export class ServiciosRedis {
  private readonly limiteUsuario: Ratelimit;
  private readonly limiteGlobal: Ratelimit;

  private constructor(private readonly redis: Redis) {
    this.limiteUsuario = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(INFRA.LIMITE_USUARIO_POR_MINUTO, "60 s"),
      prefix: `${PREFIJO}:rl:usuario`,
      analytics: false,
    });
    this.limiteGlobal = new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(INFRA.LIMITE_GLOBAL_LLM_DIARIO, "1 d"),
      prefix: `${PREFIJO}:rl:global`,
      analytics: false,
    });
  }

  static desdeEntorno(): ServiciosRedis | null {
    const url = secretOpcional("UPSTASH_REDIS_REST_URL");
    const token = secretOpcional("UPSTASH_REDIS_REST_TOKEN");
    if (!url || !token) return null;
    return new ServiciosRedis(new Redis({ url, token }));
  }

  async verificarLimiteUsuario(usuarioId: string): Promise<ResultadoLimite> {
    const r = await this.limiteUsuario.limit(usuarioId);
    return { permitido: r.success, reintentarEnSeg: Math.max(0, Math.ceil((r.reset - Date.now()) / 1000)) };
  }

  /** Se consulta justo ANTES de cada llamada real al LLM (no en lecturas sin IA). */
  async verificarLimiteGlobalLLM(): Promise<ResultadoLimite> {
    const r = await this.limiteGlobal.limit("llm");
    return { permitido: r.success, reintentarEnSeg: Math.max(0, Math.ceil((r.reset - Date.now()) / 1000)) };
  }

  async adquirirCandado(usuarioId: string, requestId: string): Promise<boolean> {
    const r = await this.redis.set(`${PREFIJO}:candado:${usuarioId}`, requestId, {
      nx: true,
      ex: INFRA.CANDADO_TTL_SEGUNDOS,
    });
    return r === "OK";
  }

  async liberarCandado(usuarioId: string, requestId: string): Promise<void> {
    await this.redis.eval(SCRIPT_LIBERAR, [`${PREFIJO}:candado:${usuarioId}`], [requestId]);
  }

  async leerLivrable(unidadId: string): Promise<string | null> {
    return await this.redis.get<string>(`${PREFIJO}:livrable:${unidadId}`);
  }

  async guardarLivrable(unidadId: string, contenido: string): Promise<void> {
    await this.redis.set(`${PREFIJO}:livrable:${unidadId}`, contenido, { ex: INFRA.CACHE_LIVRABLE_TTL_SEGUNDOS });
  }

  async ping(): Promise<boolean> {
    return (await this.redis.ping()) === "PONG";
  }
}

// ───────────── index.ts ─────────────
// index.ts — Edge Function "agente-chatito" (Supabase, Deno).
//
// Orden de cada petición:
//   CORS → método → datos canónicos → JWT → cuerpo → rate limit → candado
//   → enrutamiento por modo → respuesta { ok, request_id, ... }
//
// Toda respuesta lleva request_id (también en la cabecera X-Request-Id): si
// un alumno reporta "error 203", el request_id localiza el registro exacto en
// la tabla logs_sistema.


function cabecerasCors(req: Request): Record<string, string> {
  const permitidos = (secretOpcional("ALLOWED_ORIGIN") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);
  const origen = req.headers.get("origin") ?? "";
  const permitido = permitidos.includes("*") ? "*" : permitidos.includes(origen) ? origen : permitidos[0];
  return {
    "Access-Control-Allow-Origin": permitido,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Expose-Headers": "X-Request-Id, Retry-After",
    "Vary": "Origin",
  };
}

function extraerBearer(req: Request): string {
  const cabecera = req.headers.get("authorization") ?? "";
  const [tipo, token] = cabecera.split(" ");
  if (tipo?.toLowerCase() !== "bearer" || !token) throw new ErrorApp(401, "Falta el encabezado Authorization: Bearer <jwt>");
  return token;
}

async function leerCuerpo(req: Request): Promise<string> {
  const declarado = Number(req.headers.get("content-length") ?? "0");
  if (declarado > INFRA.MAX_BYTES_PETICION) throw new ErrorApp(307, `Petición de ${declarado} bytes (máx. ${INFRA.MAX_BYTES_PETICION})`);
  const texto = await req.text();
  if (texto.length > INFRA.MAX_BYTES_PETICION) throw new ErrorApp(307, `Petición de ${texto.length} bytes (máx. ${INFRA.MAX_BYTES_PETICION})`);
  return texto;
}

/** Ejecuta una operación de Redis aplicando la política de fallo (abierto/cerrado). */
async function protegerRedis<T>(registro: Registrador, operacion: () => Promise<T>, siFalla: T): Promise<T> {
  try {
    return await operacion();
  } catch (e) {
    const detalle = normalizarError(e).detalleTecnico;
    if (!INFRA.FALLAR_ABIERTO_SI_REDIS_CAE) throw new ErrorApp(501, `Redis: ${detalle}`);
    await registro.registrar({ codigo: 501, mensaje: `Redis falló (se continúa sin protección): ${detalle}` });
    return siFalla;
  }
}

async function diagnostico(repo: Repositorio, redis: ServiciosRedis | null, usuarioId: string, probarLlm: boolean) {
  if ((await repo.obtenerRolPerfil(usuarioId)) !== "admin") throw new ErrorApp(403, "diagnostico requiere rol admin");
  const resultado: Record<string, unknown> = {
    mc_operacional_version: MC.version,
    grafos_cargados: Object.keys(GRAFOS),
    base_de_datos: await repo.ping().catch(() => false),
    redis: redis ? await redis.ping().catch(() => false) : "no_configurado",
  };
  try {
    const llm = crearProveedor();
    resultado.proveedor = { nombre: llm.nombre, modelo: llm.modelo };
    if (probarLlm) {
      if (redis) {
        const lim = await redis.verificarLimiteGlobalLLM().catch(() => ({ permitido: true, reintentarEnSeg: 0 }));
        if (!lim.permitido) throw new ErrorApp(430, "tope diario alcanzado");
      }
      const r = await llm.generar({
        sistema: { estatico: 'Responde exactamente con {"ok": true}', contexto: "", dinamico: "" },
        mensajeUsuario: "ping",
        imagenes: [],
        maxTokens: 20,
        temperatura: 0,
      });
      resultado.prueba_llm = { ok: true, modelo_real: r.modelo, latencia_ms: r.latenciaMs };
    }
  } catch (e) {
    const err = normalizarError(e);
    resultado.proveedor_error = { codigo: err.codigo, detalle: err.detalleTecnico };
  }
  return resultado;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const inicio = performance.now();
  const requestId = crypto.randomUUID();
  const cors = cabecerasCors(req);
  const responder = (status: number, cuerpo: unknown, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(cuerpo), {
      status,
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "X-Request-Id": requestId, ...extra },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let registro: Registrador = new RegistradorConsola();
  let redis: ServiciosRedis | null = null;
  let usuarioConCandado: string | null = null;

  try {
    if (req.method !== "POST") throw new ErrorApp(306, `Método no permitido: ${req.method}`);
    validarDatosCanonicos();

    const db = crearClienteAdmin();
    registro = new RegistradorSupabase(db, requestId);
    const repo = new RepositorioSupabase(db, INFRA.BUCKET_EVIDENCIAS);

    const usuario = await obtenerUsuarioDelToken(db, extraerBearer(req));
    registro.usuarioId = usuario.id;

    const cuerpo = validarCuerpo(await leerCuerpo(req));

    redis = ServiciosRedis.desdeEntorno();
    if (!redis) {
      await registro.registrar({ codigo: 501, mensaje: "Upstash no configurado: sin rate limit, candado ni caché" });
    } else {
      const limite = await protegerRedis(registro, () => redis!.verificarLimiteUsuario(usuario.id), {
        permitido: true,
        reintentarEnSeg: 0,
      });
      if (!limite.permitido) {
        throw new ErrorApp(429, "Límite por usuario superado", { reintentar_en_seg: limite.reintentarEnSeg });
      }
      const adquirido = await protegerRedis(registro, () => redis!.adquirirCandado(usuario.id, requestId), true);
      if (!adquirido) throw new ErrorApp(311, "Otra petición del mismo usuario está en curso");
      usuarioConCandado = usuario.id;
    }

    if (cuerpo.accion === "diagnostico") {
      const datos = await diagnostico(repo, redis, usuario.id, cuerpo.probar_llm ?? false);
      return responder(200, { ok: true, request_id: requestId, diagnostico: datos });
    }

    if (cuerpo.modo !== "estudiante") {
      throw new ErrorApp(503, `El modo ${cuerpo.modo} aún no está implementado en v1`);
    }

    const resultado = await manejarEstudiante(
      {
        repo,
        registro,
        auxiliares: redis,
        obtenerLLM: crearProveedor, // perezoso: retomar una sesión no necesita IA
        mc: MC,
        grafos: GRAFOS,
        usuarioId: usuario.id,
        requestId,
        ahora: () => new Date(),
        aleatorio: Math.random,
        fallarAbiertoSiRedisCae: INFRA.FALLAR_ABIERTO_SI_REDIS_CAE,
      },
      cuerpo.accion === "continuar"
        ? { accion: "continuar", alumno_idioma_id: cuerpo.alumno_idioma_id }
        : {
          accion: "responder",
          alumno_idioma_id: cuerpo.alumno_idioma_id,
          mensaje: cuerpo.mensaje,
          imagenes: validarImagenes(cuerpo.imagenes),
        },
    );
    return responder(200, { ok: true, request_id: requestId, ...resultado });
  } catch (e) {
    const err = normalizarError(e);
    await registro.registrarError(err, Math.round(performance.now() - inicio));
    const reintentar = err.contexto.reintentar_en_seg;
    return responder(
      err.http,
      {
        ok: false,
        request_id: requestId,
        error: { codigo: err.codigo, mensaje: err.mensajeUsuario, ...(reintentar !== undefined ? { reintentar_en_seg: reintentar } : {}) },
      },
      reintentar !== undefined ? { "Retry-After": String(reintentar) } : {},
    );
  } finally {
    if (redis && usuarioConCandado) {
      await redis.liberarCandado(usuarioConCandado, requestId).catch(() => {});
    }
  }
});
