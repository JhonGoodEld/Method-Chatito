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
import {
  contarPalabras,
  esErrorReal,
  esTextoUnico,
  evaluarCorreccion,
  evaluarProduccion,
  listaPendientes,
  minimoRequerido,
  notaObservaciones,
} from "./completitud.ts";
import type { Repositorio } from "./datos.ts";
import { ErrorApp, normalizarError } from "./errores.ts";
import type { ImagenEntrada, PeticionLLM, ProveedorLLM } from "./llm_tipos.ts";
import { decodificarBase64 } from "./peticion.ts";
import { pasoPorNombre, siguientePaso } from "./plan.ts";
import { clasificarFueraDeAlcance, normalizarPropietario, perteneceA } from "./alcance.ts";
import { bloqueContexto, bloqueDinamico, bloqueEstatico, ETAPA_FORMAS_EVIDENCIA, type Tarea } from "./prompt.ts";
import { calcularPuntaje } from "./puntaje.ts";
import { evaluarMotor, type ParametrosMotor } from "./reactivacion.ts";
import type { Registrador } from "./registro.ts";
import {
  camposSospechosos,
  type Contrato,
  CONTRATO_CORRECCION,
  CONTRATO_EVALUACION,
  CONTRATO_MENSAJE,
  CONTRATO_SOLICITUD,
  parsearSalida,
  type SalidaEvaluacion,
  type SalidaSolicitud,
  type Seccion,
} from "./salida_llm.ts";
import { decidirSiguiente, type ResultadoSecuenciacion } from "./secuenciacion.ts";
import type {
  ErrorDetectado,
  ErrorDiferidoNuevo,
  ErrorSenalado,
  EstadoPublico,
  FilaEvidenciaNueva,
  Grafo,
  Intento,
  LeccionDeclarada,
  McOperacional,
  NivelRequerido,
  Observacion,
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
  /** Modelo para el segundo intento tras saturación o tiempo agotado; null = el mismo (cambio 11). */
  obtenerLLMRespaldo?: () => ProveedorLLM | null;
  mc: McOperacional;
  grafos: Readonly<Record<string, Grafo>>;
  usuarioId: string;
  requestId: string;
  ahora: () => Date;
  aleatorio: () => number;
  fallarAbiertoSiRedisCae: boolean;
  /** Pausa antes de reintentar un fallo pasajero (inyectable para las pruebas). */
  pausa?: (ms: number) => Promise<void>;
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
  // Aviso de Privacidad v1.0: sin consentimiento registrado no se trata ningún dato de aprendizaje.
  if (!(await ctx.repo.consentimientoRegistrado(ctx.usuarioId))) {
    throw new ErrorApp(313, "Consentimiento pendiente (migración 004: registrar_consentimiento)");
  }
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
    case "esperando_correccion": {
      // Retomar tras recargar la app: sin llamar al LLM.
      if (req.estado_paso === "esperando_correccion") {
        const saneada = await sanearCorreccion(ctx, s, pasoPorNombre(plan, req.paso));
        if (saneada) return saneada;
      }
      const actual = s.sesion.requisitos_etapa;
      return {
        mensaje_agente: actual.ultimo_mensaje_agente ?? actual.enunciado ?? null,
        mensaje_sistema: ["Retomamos donde te quedaste.", actual.ultimo_mensaje_sistema].filter(Boolean).join(" "),
        estado: estadoPublico(s.sesion),
      };
    }

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
  const acumulados = arrastre(sesion.requisitos_etapa);
  if (paso.tipo === "correccion") return await entregarCorreccion(ctx, s, paso);
  const livrable = await cargarLivrable(ctx, sesion.unidad_id);

  if (paso.tipo === "presentacion") {
    const siguiente = siguientePaso(plan, paso);
    const incluirSolicitud = !paso.cierra_unidad && siguiente?.tipo === "produccion";
    const salida = await llamarLLM<SalidaSolicitud>(ctx, s, livrable, {
      tarea: { tipo: "presentar", paso, siguiente, incluirSolicitud },
      mensaje: MENSAJE_CONTINUAR,
      imagenes: [],
      contrato: CONTRATO_SOLICITUD,
      maxTokens: INFRA.MAX_TOKENS_PRESENTACION,
      temperatura: 0.5,
      validar: (x) => faltanEtapes(x.secciones, paso.etapas),
    });
    const secciones = ordenarSecciones(salida.secciones, paso.etapas);
    const mensaje = componerPresentacion(secciones, salida.mensaje_para_alumno);

    if (paso.cierra_unidad) return { ...(await completarUnidad(ctx, s, mensaje)), secciones };
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
          ...acumulados,
          ultimo_mensaje_agente: mensaje,
        },
      });
      return { mensaje_agente: mensaje, secciones, mensaje_sistema: textoPedido(niveles), estado: estadoPublico(s.sesion) };
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
      requisitos_etapa: { paso: siguiente.paso, estado_paso: "pendiente_presentar", ...acumulados },
    });
    return { mensaje_agente: mensaje, secciones, mensaje_sistema: null, estado: estadoPublico(s.sesion) };
  }

  // Paso de producción: solicitar (declarando antes las formas de evidencia, MC-001 §15).
  const salida = await llamarLLM<SalidaSolicitud>(ctx, s, livrable, {
    tarea: { tipo: "solicitar", paso },
    mensaje: MENSAJE_CONTINUAR,
    imagenes: [],
    contrato: CONTRATO_SOLICITUD,
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
      ...acumulados,
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
    contrato: CONTRATO_EVALUACION,
    maxTokens: INFRA.MAX_TOKENS_EVALUACION,
    temperatura: 0.2,
  });

  // Cambio 18: una «corrección» idéntica al fragmento no es un error (la IA a veces lista aciertos).
  const errores = salida.errores.filter(esErrorReal);
  if (errores.length < salida.errores.length) {
    await ctx.registro.registrar({
      codigo: 203,
      severidad: "warning",
      mensaje: `Se descartaron ${salida.errores.length - errores.length} «errores» con corrección idéntica al fragmento`,
      contexto: { paso: paso.paso, fragmentos: salida.errores.filter((e) => !esErrorReal(e)).map((e) => e.fragmento) },
    });
  }

  // Cambio 15: en un texto único, las palabras las cuenta el código sobre la transcripción de ESTA entrega.
  const textoUnico = esTextoUnico(req.niveles);
  const metricas = emparejarNiveles(req.niveles, salida.niveles).map((m) =>
    textoUnico ? { ...m, total_entregado: contarPalabras(salida.transcripcion) } : m
  );
  const factor = ctx.mc.modos_operacion.estudiante.criterio_completitud.factor_minimo;
  const decision = evaluarProduccion(
    metricas.map((m) => ({ nivel: m.nivel, total_pedido: m.total_pedido, total_entregado: m.total_entregado })),
    factor,
  );
  // Cambio 13: la cantidad no basta; también deben cumplirse las condiciones de contenido de la étape 15.
  const condicionesFallidas = paso.etapas.includes(ETAPA_FORMAS_EVIDENCIA) ? salida.condiciones.filter((c) => !c.cumple) : [];
  const completa = decision.cumple && condicionesFallidas.length === 0;
  const intento: Intento = (req.transcripciones_previas?.length ?? 0) === 0 ? "inicial" : "complemento";
  const archivos = await subirImagenes(ctx, s, imagenes);
  const contenido = componerContenido(texto, imagenes.length, salida.transcripcion);
  // Corrección diferida (MC-001 §17): sin evidencia completa no hay corrección ni diagnóstico.
  const enAlcance = completa ? errores.filter((e) => !e.fuera_de_scope) : [];
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
      diagnosticos: completa ? propios(errores) : null,
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
        diagnostico_diferido: !completa,
        conteo: textoUnico ? "codigo" : "ia",
        condiciones: salida.condiciones.filter((c) => c.nivel === m.nivel || (i === 0 && !nivelesValidos.has(c.nivel))),
        archivos,
      },
    };
  });
  await ctx.repo.insertarEvidencias(filas); // ← ANTES de cualquier avance

  if (!completa) {
    const faltas = [
      ...decision.detalle
        .filter((d) => !d.cumple)
        .map((d) => `nivel ${d.nivel ?? "único"}: ${d.entregado} de ${d.pedido} (mínimo ${d.minimo})`),
      ...condicionesFallidas.map((c) => `nivel ${c.nivel ?? "único"}: falta «${c.condicion}»${c.detalle ? ` (${c.detalle})` : ""}`),
    ].join("; ");
    const aviso = textoUnico
      ? `Tu texto tiene ${metricas[0].total_entregado} palabras; el mínimo es ${metricas[0].minimo_requerido}. Reenvía el texto COMPLETO, ampliado.`
      : `Aún falta producción — ${faltas}. Envía solo lo que falta.`;
    s.sesion = await ctx.repo.actualizarSesion(sesion, {
      requisitos_etapa: {
        ...req,
        transcripciones_previas: [...(req.transcripciones_previas ?? []), salida.transcripcion],
        ultimo_mensaje_agente: salida.mensaje_para_alumno,
        ultimo_mensaje_sistema: aviso,
      },
    });
    return {
      mensaje_agente: salida.mensaje_para_alumno,
      mensaje_sistema: aviso,
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
    // Cambio 19: lo que está fuera del alcance viaja aparte; se mostrará en la étape 17 sin evaluarse.
    const observaciones = [
      ...(req.observaciones_acumuladas ?? []),
      ...errores.filter((e) => e.fuera_de_scope).map((e) => ({
        fragmento: e.fragmento,
        correccion: e.correccion,
        paso: paso.paso,
        propietario: normalizarPropietario(e.propietario), // MC-001 §7.5
        explicacion: e.explicacion,
        causa: e.causa,
      })),
    ];
    return await avanzar(
      ctx,
      s,
      paso,
      salida.mensaje_para_alumno,
      "Producción registrada. La corrección se hará en la étape 17, con toda la evidencia reunida.",
      acumulados,
      observaciones,
    );
  }

  if (paso.correccion === "ninguna") {
    // MC-001 §18: los errores ya quedaron en la evidencia (diagnosticos); no se corrigen.
    return await avanzar(ctx, s, paso, salida.mensaje_para_alumno, "Paso completado.");
  }

  if (enAlcance.length > 0) {
    const senalados: ErrorSenalado[] = enAlcance.map((e, i) => aSenalado(e, i));
    const aviso = `Para continuar se exige corregir el 100 %. ${listaPendientes(senalados)}`;
    s.sesion = await ctx.repo.actualizarSesion(sesion, {
      etapa_actual: ctx.mc.leccion.plan_ejecucion.etapa_correccion,
      fase_correccion: "correction_differee",
      requisitos_etapa: {
        ...req,
        estado_paso: "esperando_correccion",
        errores_senalados: senalados,
        ultimo_mensaje_agente: salida.mensaje_para_alumno,
        ultimo_mensaje_sistema: aviso,
      },
    });
    return {
      mensaje_agente: salida.mensaje_para_alumno,
      mensaje_sistema: aviso,
      resultado: "requiere_correccion",
      estado: estadoPublico(s.sesion),
    };
  }

  return await avanzar(ctx, s, paso, salida.mensaje_para_alumno, "Paso completado.");
}

async function verificarCorreccion(ctx: ContextoFlujo, s: Estado, texto: string, imagenes: ImagenEntrada[]): Promise<RespuestaFlujo> {
  const plan = ctx.mc.leccion.plan_ejecucion.pasos;
  const paso = pasoPorNombre(plan, s.sesion!.requisitos_etapa.paso);
  const saneada = await sanearCorreccion(ctx, s, paso); // cambio 18: sesiones guardadas antes del filtro
  if (saneada) return saneada;
  const sesion = s.sesion!;
  const req = sesion.requisitos_etapa;
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
    contrato: CONTRATO_CORRECCION,
    maxTokens: INFRA.MAX_TOKENS_EVALUACION,
    temperatura: 0.2,
  });

  const r = evaluarCorreccion(senalados.map((e) => e.indice), salida.indices_corregidos);
  // MC-001 §7.5: un error diferido corregido ya no está pendiente.
  await saldarDiferidos(ctx, senalados.filter((e) => !r.pendientes.includes(e.indice)));
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
  const aviso = `Corregiste ${r.corregidos} de ${senalados.length}. ${listaPendientes(pendientes)}`;
  s.sesion = await ctx.repo.actualizarSesion(sesion, {
    requisitos_etapa: {
      ...req,
      errores_senalados: pendientes,
      ultimo_mensaje_agente: salida.mensaje_para_alumno,
      ultimo_mensaje_sistema: aviso,
    },
  });
  return {
    mensaje_agente: salida.mensaje_para_alumno,
    mensaje_sistema: aviso,
    resultado: "correccion_incompleta",
    estado: estadoPublico(s.sesion),
  };
}

/**
 * Cambio 18: quita de lo señalado las «correcciones» idénticas al fragmento
 * (sesiones guardadas antes del filtro de la evaluación). Si no queda nada
 * real, la corrección está completa y se avanza; si cambia algo, se guarda la
 * lista depurada. Devuelve la respuesta solo cuando avanza.
 */
async function sanearCorreccion(ctx: ContextoFlujo, s: Estado, paso: PasoPlan): Promise<RespuestaFlujo | null> {
  const req = s.sesion!.requisitos_etapa;
  const lista = req.errores_senalados ?? [];
  const reales = lista.filter(esErrorReal);
  if (reales.length === lista.length) return null;
  await ctx.registro.registrar({
    codigo: 203,
    severidad: "warning",
    mensaje: `Se descartaron ${lista.length - reales.length} pendientes con corrección idéntica al fragmento`,
    contexto: { paso: paso.paso, fragmentos: lista.filter((e) => !esErrorReal(e)).map((e) => e.fragmento) },
  });
  await saldarDiferidos(ctx, lista.filter((e) => !esErrorReal(e)));
  if (reales.length === 0) {
    return await avanzar(ctx, s, paso, null, "Corrección completa: lo que quedaba pendiente no eran errores.");
  }
  s.sesion = await ctx.repo.actualizarSesion(s.sesion!, {
    requisitos_etapa: { ...req, errores_senalados: reales, ultimo_mensaje_sistema: listaPendientes(reales) },
  });
  return null;
}

/** Lo que viaja entre pasos hasta la étape 17: errores a corregir y observaciones (cambio 19). */
function arrastre(req: Pick<Requisitos, "errores_acumulados" | "observaciones_acumuladas">) {
  return {
    ...(req.errores_acumulados?.length ? { errores_acumulados: req.errores_acumulados } : {}),
    ...(req.observaciones_acumuladas?.length ? { observaciones_acumuladas: req.observaciones_acumuladas } : {}),
  };
}

async function avanzar(
  ctx: ContextoFlujo,
  s: Estado,
  paso: PasoPlan,
  mensajeAgente: string | null,
  mensajeSistema: string,
  acumulados: ErrorSenalado[] | undefined = s.sesion!.requisitos_etapa.errores_acumulados,
  observaciones: Observacion[] | undefined = s.sesion!.requisitos_etapa.observaciones_acumuladas,
): Promise<RespuestaFlujo> {
  const siguiente = siguientePaso(ctx.mc.leccion.plan_ejecucion.pasos, paso);
  if (!siguiente) throw new ErrorApp(598, `El paso ${paso.paso} no tiene sucesor`);
  s.sesion = await ctx.repo.actualizarSesion(s.sesion!, {
    etapa_actual: siguiente.etapas[0],
    fase_correccion: null,
    requisitos_etapa: {
      paso: siguiente.paso,
      estado_paso: "pendiente_presentar",
      ...arrastre({ errores_acumulados: acumulados, observaciones_acumuladas: observaciones }),
    },
  });
  return { mensaje_agente: mensajeAgente, mensaje_sistema: mensajeSistema, resultado: "avanza", estado: estadoPublico(s.sesion) };
}

// =====================================================================
// Étape 17 — corrección diferida de las étapes 15 y 16
// =====================================================================
/**
 * MC-001 v1.0.4 §7.5 — al entrar a la étape 17, cada observación fuera del alcance se clasifica:
 *   corregir_ahora → se suma a lo que hay que corregir aquí
 *   diferir        → se guarda en errores_diferidos y se muestra «(se corregirá en X)»
 *   observar       → solo se muestra
 * Además se cargan los diferidos de OTRAS lecciones cuyo propietario es esta.
 * La tabla falla en suave: sin la migración 005, todo queda como observación.
 */
async function prepararFueraDeAlcance(ctx: ContextoFlujo, s: Estado): Promise<{ aCorregir: ErrorSenalado[]; nota: string }> {
  const sesion = s.sesion!;
  const vistas = new Set<string>();
  const observaciones = (sesion.requisitos_etapa.observaciones_acumuladas ?? []).filter(esErrorReal).filter((o) => {
    const clave = `${o.fragmento}→${o.correccion}`;
    return vistas.has(clave) ? false : (vistas.add(clave), true);
  });
  const estados = observaciones.some((o) => o.propietario) ? await ctx.repo.obtenerEstados(s.ai.id) : [];
  const datos = { grafo: s.grafo, lecciones: s.lecciones, estados };

  const aCorregir: ErrorSenalado[] = [];
  const visibles: Array<{ fragmento: string; correccion: string; destino?: string }> = [];
  const nuevos: ErrorDiferidoNuevo[] = [];
  for (const o of observaciones) {
    const propietario = o.propietario ?? null;
    const tratamiento = clasificarFueraDeAlcance(propietario, datos);
    const base = { indice: 0, fragmento: o.fragmento, correccion: o.correccion, explicacion: o.explicacion ?? "", causa: o.causa };
    if (tratamiento === "corregir_ahora") {
      aCorregir.push({ ...base, paso: "otra lección", tema: propietario! });
    } else if (tratamiento === "diferir") {
      nuevos.push({
        alumno_idioma_id: s.ai.id,
        propietario: propietario!,
        unidad_origen: sesion.unidad_id,
        fragmento: o.fragmento,
        correccion: o.correccion,
        explicacion: o.explicacion ?? "",
        causa: o.causa ?? null,
      });
      visibles.push({ fragmento: o.fragmento, correccion: o.correccion, destino: propietario! });
    } else {
      visibles.push({ fragmento: o.fragmento, correccion: o.correccion });
    }
  }

  const leccion = s.lecciones.find((l) => l.unidad_id === sesion.unidad_id);
  try {
    await ctx.repo.guardarErroresDiferidos(nuevos);
    const pendientes = leccion ? await ctx.repo.obtenerErroresDiferidos(s.ai.id) : [];
    for (const d of pendientes) {
      if (d.unidad_origen === sesion.unidad_id || !perteneceA(leccion!, d.propietario) || !esErrorReal(d)) continue;
      aCorregir.push({
        indice: 0,
        fragmento: d.fragmento,
        correccion: d.correccion,
        explicacion: d.explicacion,
        causa: d.causa ?? undefined,
        paso: `otra lección (${d.unidad_origen})`,
        tema: d.propietario,
        diferido_id: d.id,
      });
    }
  } catch (e) {
    const err = normalizarError(e);
    await ctx.registro.registrar({
      codigo: err.codigo,
      severidad: "warning",
      mensaje: `Corrección diferida no disponible (¿migración 005?): ${err.detalleTecnico}`,
    });
  }
  return { aCorregir, nota: notaObservaciones(visibles) };
}

/** Borra de errores_diferidos los que el alumno ya corrigió (fallo suave). */
async function saldarDiferidos(ctx: ContextoFlujo, errores: ErrorSenalado[]): Promise<void> {
  const ids = errores.map((e) => e.diferido_id).filter((id): id is string => !!id);
  if (ids.length === 0) return;
  try {
    await ctx.repo.borrarErroresDiferidos(ids);
  } catch (e) {
    const err = normalizarError(e);
    await ctx.registro.registrar({ codigo: err.codigo, severidad: "warning", mensaje: `No se borraron errores diferidos: ${err.detalleTecnico}` });
  }
}

async function entregarCorreccion(ctx: ContextoFlujo, s: Estado, paso: PasoPlan): Promise<RespuestaFlujo> {
  const sesion = s.sesion!;
  const acumulados = sesion.requisitos_etapa.errores_acumulados ?? [];
  const delObjetivo = acumulados.filter(esErrorReal); // cambio 18: acumulados antes del filtro
  // MC-001 §7.5: se suman los fuera del alcance que se corrigen aquí (ya estudiados o diferidos a esta lección).
  const fuera = await prepararFueraDeAlcance(ctx, s);
  const errores = [...delObjetivo, ...fuera.aCorregir];
  const nota = fuera.nota;
  if (delObjetivo.length < acumulados.length) {
    await ctx.registro.registrar({
      codigo: 203,
      severidad: "warning",
      mensaje: `Se descartaron ${acumulados.length - delObjetivo.length} errores acumulados con corrección idéntica al fragmento`,
    });
  }
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
      mensaje_sistema: ["Étape 17: no hubo errores que corregir.", nota, r.mensaje_sistema].filter(Boolean).join(" "),
    };
  }

  const senalados = errores.map((e, i) => ({ ...e, indice: i }));
  const livrable = await cargarLivrable(ctx, sesion.unidad_id);
  const salida = await llamarLLM(ctx, s, livrable, {
    tarea: { tipo: "corregir", paso, errores: senalados },
    mensaje: MENSAJE_CONTINUAR,
    imagenes: [],
    contrato: CONTRATO_MENSAJE,
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
      ultimo_mensaje_sistema: `Corrección de las étapes 15 y 16 (se exige el 100 %). ${listaPendientes(senalados)}`,
    },
  });
  return {
    mensaje_agente: salida.mensaje_para_alumno,
    mensaje_sistema: [`Corrección de las étapes 15 y 16 (se exige el 100 %). ${listaPendientes(senalados)}`, nota].filter(Boolean).join(" "),
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
  contrato: Contrato<T>;
  maxTokens: number;
  temperatura: number;
  /** Comprobación adicional del contenido; devuelve el problema o null. Se repara como un fallo de contrato. */
  validar?: (salida: T) => string | null;
}

/**
 * Llama al LLM y valida su respuesta contra el contrato.
 * Si falla (203), se hace UN segundo intento, según el tipo de fallo (cambio 3):
 *   cortada  → se repite desde cero con el doble de espacio (hasta MAX_TOKENS_TOPE)
 *   ilegible → no era JSON (p. ej. un modelo clasificador): se repite desde cero
 *   contrato → JSON con campos mal: se le devuelve al modelo con los errores exactos
 * Las imágenes no se reenvían al reparar un contrato: el modelo ya las analizó.
 * Si el segundo intento también falla, se lanza el 203 y la sesión no se toca.
 */
async function llamarLLM<T>(ctx: ContextoFlujo, s: Estado, livrable: string, o: OpcionesLLM<T>): Promise<T> {
  const unidad = s.lecciones.find((l) => l.unidad_id === s.sesion!.unidad_id);
  const base: PeticionLLM = {
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
    formato: { nombre: o.contrato.nombre, esquema: o.contrato.json },
  };
  let ultimoTexto = "";

  const intentar = async (peticion: PeticionLLM, intento: number, llm?: ProveedorLLM): Promise<T> => {
    const r = await generarYRegistrar(ctx, peticion, o, intento, llm);
    ultimoTexto = r.texto;
    const info = { tarea: o.tarea.tipo, proveedor: r.proveedor, modelo: r.modelo, intento };
    if (r.cortada) {
      throw new ErrorApp(203, `Respuesta cortada por el límite de ${peticion.maxTokens} tokens`, { ...info, tipo_fallo: "cortada" });
    }
    const salida = parsearSalida(o.contrato.zod, r.texto, info);
    const problema = o.validar?.(salida);
    if (problema) {
      throw new ErrorApp(203, `JSON fuera de contrato: ${problema}`, { ...info, tipo_fallo: "contrato", fragmento: r.texto.slice(0, 300) });
    }
    const sospechosos = camposSospechosos(r.texto);
    if (sospechosos.length) {
      await ctx.registro.registrar({
        codigo: 203,
        severidad: "warning",
        mensaje: `Posible corte del proveedor: texto de exactamente 4096 caracteres en ${sospechosos.join(", ")}`,
        contexto: info,
      });
    }
    return salida;
  };

  let fallo: ErrorApp;
  try {
    return await intentar(base, 1);
  } catch (e) {
    if (!(e instanceof ErrorApp) || !REINTENTABLES.has(e.codigo)) throw e;
    fallo = e;
  }

  // Fallos pasajeros del proveedor (saturación, tiempo agotado, error del
  // proveedor): una pausa y se repite la MISMA petición, una sola vez, con el
  // modelo de respaldo si lo hay (cambio 11). Si el proveedor avisó saturación,
  // la pausa es más larga (cambio 12).
  if (fallo.codigo !== 203) {
    const saturado = fallo.codigo === 202 || fallo.contexto.http === 503;
    const respaldo = await obtenerRespaldo(ctx);
    const pausaMs = saturado ? INFRA.PAUSA_SATURACION_MS : INFRA.PAUSA_REINTENTO_MS;
    await ctx.registro.registrar({
      codigo: fallo.codigo,
      severidad: "warning",
      mensaje: `Segundo intento tras fallo pasajero: ${fallo.detalleTecnico}`,
      contexto: { ...fallo.contexto, saturado, pausa_ms: pausaMs, modelo_segundo_intento: respaldo?.modelo ?? "el mismo" },
    });
    await (ctx.pausa ?? esperar)(pausaMs);
    return await intentar(base, 2, respaldo ?? undefined);
  }

  const tipo = fallo.contexto.tipo_fallo;
  await ctx.registro.registrar({
    codigo: 203,
    severidad: "warning",
    mensaje: `Segundo intento (${tipo ?? "respuesta vacía"}): ${fallo.detalleTecnico}`,
    contexto: fallo.contexto,
  });

  let segunda: PeticionLLM;
  if (tipo === "cortada") {
    segunda = { ...base, maxTokens: Math.min(base.maxTokens * 2, INFRA.MAX_TOKENS_TOPE) };
  } else if (tipo === "contrato" && ultimoTexto.trim() !== "") {
    segunda = {
      ...base,
      imagenes: [],
      mensajeUsuario: o.imagenes.length
        ? `${o.mensaje}\n(Las imágenes ya las analizaste en tu respuesta anterior.)`
        : o.mensaje,
      historial: [
        { rol: "assistant", texto: ultimoTexto },
        {
          rol: "user",
          texto: `Tu respuesta anterior no cumple el formato obligatorio: ${fallo.detalleTecnico}. ` +
            `Devuelve SOLO el objeto JSON completo y corregido, con exactamente los campos del formato de la TAREA, sin texto adicional.`,
        },
      ],
    };
  } else {
    segunda = { ...base }; // no era JSON o llegó vacía: se repite desde cero
  }
  return await intentar(segunda, 2);
}

/**
 * Códigos con derecho a UN segundo intento: 203 (formato) y los fallos pasajeros
 * del proveedor 202 (saturado), 204 (tiempo agotado) y 206 (error del proveedor).
 * Nunca se reintentan 201 (clave), 205 (configuración), 207 (sin crédito) ni 430.
 */
const REINTENTABLES = new Set<number>([202, 203, 204, 206]);

const esperar = (ms: number) => new Promise<void>((resuelve) => setTimeout(resuelve, ms));

/** El respaldo nunca debe impedir el segundo intento: si no se puede crear, se usa el principal. */
async function obtenerRespaldo(ctx: ContextoFlujo): Promise<ProveedorLLM | null> {
  try {
    return ctx.obtenerLLMRespaldo?.() ?? null;
  } catch (e) {
    const err = normalizarError(e);
    await ctx.registro.registrar({ codigo: err.codigo, severidad: "warning", mensaje: `Sin modelo de respaldo: ${err.detalleTecnico}` });
    return null;
  }
}

/** Una llamada real: respeta el tope diario global y registra el uso (código 900). */
async function generarYRegistrar<T>(
  ctx: ContextoFlujo,
  peticion: PeticionLLM,
  o: OpcionesLLM<T>,
  intento: number,
  elegido?: ProveedorLLM,
) {
  const llm = elegido ?? ctx.obtenerLLM();
  const limite = await conRedis(ctx, (a) => a.verificarLimiteGlobalLLM(), { permitido: true, reintentarEnSeg: 0 });
  if (!limite.permitido) {
    throw new ErrorApp(430, "Tope diario global de llamadas al LLM alcanzado", { reintentar_en_seg: limite.reintentarEnSeg });
  }
  const respuesta = await llm.generar(peticion);
  if (INFRA.REGISTRAR_USO_LLM) {
    await ctx.registro.registrar({
      codigo: 900,
      contexto: {
        tarea: o.tarea.tipo,
        intento,
        proveedor: respuesta.proveedor,
        modelo: respuesta.modelo,
        uso: respuesta.uso,
        latencia_ms: respuesta.latenciaMs,
        imagenes: peticion.imagenes.length,
      },
    });
  }
  return respuesta;
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

/** Cambio 5: comprueba que llegaron exactamente las étapes del paso, sin faltantes ni duplicadas. */
function faltanEtapes(secciones: Seccion[], esperadas: number[]): string | null {
  const recibidas = secciones.map((x) => x.etapa);
  const faltan = esperadas.filter((n) => !recibidas.includes(n));
  const sobran = recibidas.filter((n) => !esperadas.includes(n));
  const repetidas = recibidas.filter((n, i) => recibidas.indexOf(n) !== i);
  const problemas = [
    faltan.length ? `faltan las étapes ${faltan.join(", ")} en «secciones»` : "",
    sobran.length ? `sobran las étapes ${sobran.join(", ")}` : "",
    repetidas.length ? `étapes repetidas: ${repetidas.join(", ")}` : "",
  ].filter(Boolean);
  return problemas.length ? problemas.join("; ") : null;
}

function ordenarSecciones(secciones: Seccion[], esperadas: number[]): Seccion[] {
  return esperadas.map((n) => secciones.find((x) => x.etapa === n)!).filter(Boolean);
}

/** Texto completo de la presentación (para guardar y para clientes que no usan las secciones). */
function componerPresentacion(secciones: Seccion[], cierre: string): string {
  return [...secciones.map((x) => `## Étape ${x.etapa} — ${x.titulo}\n\n${x.texto}`), cierre].filter((x) => x.trim()).join("\n\n");
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
    enunciado: req.estado_paso === "esperando_evidencia" ? req.enunciado : undefined,
    errores_pendientes: req.estado_paso === "esperando_correccion" ? req.errores_senalados?.length : undefined,
    bloqueo: req.bloqueo,
  };
}

