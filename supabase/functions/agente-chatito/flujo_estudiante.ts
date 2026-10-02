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

import { INFRA } from "./config.ts";
import { evaluarCorreccion, evaluarProduccion, minimoRequerido } from "./completitud.ts";
import type { Repositorio } from "./datos.ts";
import { ErrorApp, normalizarError } from "./errores.ts";
import type { ImagenEntrada, PeticionLLM, ProveedorLLM } from "./llm_tipos.ts";
import { decodificarBase64 } from "./peticion.ts";
import { pasoPorNombre, siguientePaso } from "./plan.ts";
import { bloqueContexto, bloqueDinamico, bloqueEstatico, type Tarea } from "./prompt.ts";
import { calcularPuntaje } from "./puntaje.ts";
import { evaluarMotor, type ParametrosMotor } from "./reactivacion.ts";
import type { Registrador } from "./registro.ts";
import {
  parsearSalida,
  type SalidaEvaluacion,
  SalidaCorreccionSchema,
  SalidaEvaluacionSchema,
  SalidaMensajeSchema,
  type SalidaSolicitud,
  SalidaSolicitudSchema,
} from "./salida_llm.ts";
import { decidirSiguiente, type ResultadoSecuenciacion } from "./secuenciacion.ts";
import type {
  ErrorDetectado,
  ErrorSenalado,
  EstadoPublico,
  FilaEvidenciaNueva,
  Grafo,
  Intento,
  LeccionDeclarada,
  McOperacional,
  NivelRequerido,
  PasoPlan,
  Requisitos,
  RespuestaFlujo,
  Sesion,
  SugerenciaReactivacion,
} from "./tipos.ts";
import type { AlumnoIdioma } from "./datos.ts";

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

  if (paso.correccion === "ninguna") {
    // MC-001 §18: los errores ya quedaron en la evidencia (diagnosticos); no se corrigen.
    return await avanzar(ctx, s, paso, salida.mensaje_para_alumno, "Paso completado.");
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

