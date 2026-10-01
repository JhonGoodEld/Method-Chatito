// llm_openrouter.ts — Adapter para OpenRouter (API compatible con OpenAI).
//
// Con el modelo "openrouter/free", OpenRouter elige en cada llamada un modelo
// gratuito compatible con la petición (imágenes, salida JSON...). Por eso se
// registra el modelo que REALMENTE respondió: si un modelo gratuito devuelve
// JSON roto, el registro dice cuál fue.

import { ErrorApp } from "./errores.ts";
import {
  codigoPorHttp,
  detalleError,
  fetchConLimite,
  type PeticionLLM,
  type ProveedorLLM,
  type RespuestaLLM,
} from "./llm_tipos.ts";

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
