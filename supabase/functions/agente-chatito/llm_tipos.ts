// llm_tipos.ts — Contrato común para cualquier proveedor de IA (patrón adapter).
//
// La lógica del Método Chatito SOLO conoce esta interfaz. Cambiar de proveedor
// = cambiar el secret LLM_PROVIDER; ninguna otra línea del flujo cambia.

import { type CodigoError, ErrorApp } from "./errores.ts";

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
  /** Esquema JSON que el proveedor debe imponer a la respuesta, si lo admite (mejora A). */
  formato?: { nombre: string; esquema: Record<string, unknown> };
  /** Turnos posteriores al primer mensaje del usuario (reparación de formato, mejora B). */
  historial?: Array<{ rol: "assistant" | "user"; texto: string }>;
}

export interface RespuestaLLM {
  texto: string;
  /** true si el modelo se detuvo por el límite de tokens (respuesta incompleta). */
  cortada: boolean;
  proveedor: string;
  /** Modelo que REALMENTE respondió (la versión exacta que informa el proveedor). */
  modelo: string;
  uso: { entrada?: number; salida?: number; razonamiento?: number; cacheLeida?: number; cacheCreada?: number };
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
  // 400 = el proveedor rechazó la forma de la petición; 404 = el modelo no existe.
  // Ambos son configuración (o un error nuestro), nunca un fallo pasajero.
  if (status === 400 || status === 404) return 208;
  if (status === 429) return 202;
  if (status === 408 || status === 504) return 204;
  return 206;
}

/** fetch con tiempo límite: el agotamiento se convierte en 204, la red caída en 206. */
export async function fetchConLimite(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  proveedor: string,
  modelo?: string,
): Promise<Response> {
  const control = new AbortController();
  const temporizador = setTimeout(() => control.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: control.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new ErrorApp(204, `${proveedor} (${modelo ?? "?"}): sin respuesta en ${timeoutMs} ms`, {
        proveedor,
        modelo,
        espera_ms: timeoutMs,
      });
    }
    throw new ErrorApp(206, `${proveedor}: fallo de red — ${e instanceof Error ? e.message : String(e)}`, { proveedor, modelo });
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
