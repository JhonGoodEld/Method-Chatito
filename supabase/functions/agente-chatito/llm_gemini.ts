// llm_gemini.ts — Adapter para la API de Gemini (Google AI Studio), llamada directa.
//
// ⚠ SOLO PARA PRUEBAS DEL DESARROLLADOR. Los términos de la API de Gemini
// exigen 18 años o más y prohíben usarla en apps dirigidas a menores o con
// probabilidad de ser usadas por menores; además, el plan gratuito usa los
// datos para mejorar los productos de Google. C-Method admite alumnos de 13 a
// 17 años y su Aviso de Privacidad nombra a Anthropic: en producción,
// LLM_PROVIDER = claude.
//
// Formato verificado contra los tipos del SDK oficial @google/genai 2.32.0:
//   POST https://generativelanguage.googleapis.com/v1beta/models/{modelo}:generateContent
//   cabecera x-goog-api-key; generationConfig.{maxOutputTokens, responseMimeType,
//   responseJsonSchema, thinkingConfig.thinkingLevel}; respuesta con
//   candidates[0].{content.parts[], finishReason} y usageMetadata.
//
// Decisiones (J. Good, 02/11/2026):
//   - un solo modelo para texto y fotos (gemini-3.8-flash lee imágenes);
//   - razonamiento al mínimo que admite el modelo: el límite de salida INCLUYE
//     los tokens de razonamiento, y razonar de más deja la respuesta vacía;
//   - sin temperatura: Google recomienda el valor por defecto en Gemini 3.

import { ErrorApp } from "./errores.ts";
import {
  codigoPorHttp,
  detalleError,
  fetchConLimite,
  type PeticionLLM,
  type ProveedorLLM,
  type RespuestaLLM,
} from "./llm_tipos.ts";

const URL_GEMINI = "https://generativelanguage.googleapis.com/v1beta/models";

export type NivelRazonamiento = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

interface RespuestaGemini {
  modelVersion?: string;
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  promptFeedback?: { blockReason?: string };
}

/**
 * Adapta nuestros esquemas al subconjunto de JSON Schema que Gemini documenta:
 * los tipos en lista (["integer","null"]) se convierten en anyOf, que sí figura
 * entre las palabras clave admitidas. El resto pasa sin cambios.
 */
export function esquemaParaGemini(nodo: unknown): unknown {
  if (Array.isArray(nodo)) return nodo.map(esquemaParaGemini);
  if (!nodo || typeof nodo !== "object") return nodo;
  const { type, ...resto } = nodo as Record<string, unknown>;
  const convertido = Object.fromEntries(Object.entries(resto).map(([k, v]) => [k, esquemaParaGemini(v)]));
  if (Array.isArray(type)) return { ...convertido, anyOf: type.map((t) => ({ type: t })) };
  return type === undefined ? convertido : { type, ...convertido };
}

export class ProveedorGemini implements ProveedorLLM {
  readonly nombre = "gemini";

  constructor(
    private readonly apiKey: string,
    readonly modelo: string,
    private readonly timeoutMs: number,
    private readonly nivelRazonamiento: NivelRazonamiento,
  ) {}

  async generar(p: PeticionLLM): Promise<RespuestaLLM> {
    const sistema = [p.sistema.estatico, p.sistema.contexto, p.sistema.dinamico]
      .filter((t) => t.trim() !== "")
      .join("\n\n");

    const contents = [
      {
        role: "user",
        parts: [
          ...p.imagenes.map((img) => ({ inlineData: { mimeType: img.mediaType, data: img.base64 } })),
          { text: p.mensajeUsuario },
        ],
      },
      // Reparación de formato: el turno del modelo se llama "model" en Gemini.
      ...(p.historial ?? []).map((h) => ({ role: h.rol === "assistant" ? "model" : "user", parts: [{ text: h.texto }] })),
    ];

    const inicio = performance.now();
    const res = await fetchConLimite(`${URL_GEMINI}/${encodeURIComponent(this.modelo)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sistema }] },
        contents,
        generationConfig: {
          maxOutputTokens: p.maxTokens,
          responseMimeType: "application/json",
          ...(p.formato ? { responseJsonSchema: esquemaParaGemini(p.formato.esquema) } : {}),
          thinkingConfig: { thinkingLevel: this.nivelRazonamiento },
        },
      }),
    }, this.timeoutMs, this.nombre, this.modelo);

    if (!res.ok) {
      throw new ErrorApp(codigoPorHttp(res.status), `gemini HTTP ${res.status}: ${await detalleError(res)}`, {
        proveedor: this.nombre,
        modelo: this.modelo,
        http: res.status,
        ...(res.status === 404 ? { revisar: `¿existe el modelo "${this.modelo}"? (LLM_MODEL o LLM_MODEL_RESPALDO)` } : {}),
      });
    }

    const datos = (await res.json()) as RespuestaGemini;
    const candidato = datos.candidates?.[0];
    const finishReason = candidato?.finishReason ?? null;
    // Las partes de razonamiento (thought: true) nunca forman parte de la respuesta.
    const texto = (candidato?.content?.parts ?? [])
      .filter((x) => !x.thought && typeof x.text === "string")
      .map((x) => x.text!)
      .join("")
      .trim();
    const cortada = finishReason === "MAX_TOKENS";
    const uso = {
      entrada: datos.usageMetadata?.promptTokenCount,
      salida: datos.usageMetadata?.candidatesTokenCount,
      razonamiento: datos.usageMetadata?.thoughtsTokenCount,
    };

    if (!texto) {
      const bloqueo = datos.promptFeedback?.blockReason ?? null;
      throw new ErrorApp(
        203,
        bloqueo
          ? `gemini bloqueó la petición (${bloqueo})`
          : cortada
          ? `gemini devolvió una respuesta vacía: el límite de ${p.maxTokens} tokens se agotó antes de escribir (probablemente en razonamiento)`
          : `gemini devolvió una respuesta vacía (${finishReason ?? "sin motivo"})`,
        {
          proveedor: this.nombre,
          modelo: datos.modelVersion ?? this.modelo,
          finish_reason: finishReason,
          bloqueo,
          tokens_entrada: uso.entrada ?? null,
          tokens_salida: uso.salida ?? null,
          tokens_razonamiento: uso.razonamiento ?? null,
          limite_tokens: p.maxTokens,
          ...(cortada ? { tipo_fallo: "cortada" } : {}),
        },
      );
    }

    return {
      texto,
      cortada,
      proveedor: this.nombre,
      modelo: datos.modelVersion ?? this.modelo,
      uso,
      latenciaMs: Math.round(performance.now() - inicio),
    };
  }
}
