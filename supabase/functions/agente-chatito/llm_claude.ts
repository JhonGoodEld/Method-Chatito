// llm_claude.ts — Adapter para la API de Anthropic (Messages API).
//
// Caché de prompt: los bloques "estatico" (reglas) y "contexto" (livrable)
// llevan cache_control; en turnos siguientes se cobran como lectura de caché.
// Si un bloque es más corto que el mínimo cacheable del modelo, simplemente no
// se cachea (no es un error).

import { ErrorApp } from "./errores.ts";
import {
  codigoPorHttp,
  detalleError,
  fetchConLimite,
  type PeticionLLM,
  type ProveedorLLM,
  type RespuestaLLM,
} from "./llm_tipos.ts";

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
