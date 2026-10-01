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
