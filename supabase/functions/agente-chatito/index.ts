// index.ts — Edge Function "agente-chatito" (Supabase, Deno).
//
// Orden de cada petición:
//   CORS → método → datos canónicos → JWT → cuerpo → rate limit → candado
//   → enrutamiento por modo → respuesta { ok, request_id, ... }
//
// Toda respuesta lleva request_id (también en la cabecera X-Request-Id): si
// un alumno reporta "error 203", el request_id localiza el registro exacto en
// la tabla logs_sistema.

import { GRAFOS, INFRA, MC, secretOpcional, validarDatosCanonicos } from "./config.ts";
import { crearClienteAdmin, obtenerUsuarioDelToken, type Repositorio, RepositorioSupabase } from "./datos.ts";
import { ErrorApp, normalizarError } from "./errores.ts";
import { manejarEstudiante } from "./flujo_estudiante.ts";
import { crearProveedor } from "./llm_fabrica.ts";
import { validarCuerpo, validarImagenes } from "./peticion.ts";
import { type Registrador, RegistradorConsola, RegistradorSupabase } from "./registro.ts";
import { ServiciosRedis } from "./redis.ts";

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
