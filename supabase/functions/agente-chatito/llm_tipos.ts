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
