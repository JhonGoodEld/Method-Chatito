// redis.ts — Upstash Redis: rate limit, candado y caché.
//
// Qué se cachea y qué NO:
//   ✔ contenido de livrables (estático, se lee en cada turno de la unidad)
//   ✘ progreso, sesión, estados, evidencia: cachearlos daría decisiones con
//     datos viejos (una étape equivocada) — siempre se leen de la BD.
//
// Secrets: UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN.
// Si faltan, desdeEntorno() devuelve null y el llamador decide (fallar abierto).

import { Redis } from "npm:@upstash/redis@1";
import { Ratelimit } from "npm:@upstash/ratelimit@2";
import { INFRA, secretOpcional } from "./config.ts";

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
