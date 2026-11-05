import { assert, assertEquals, assertRejects } from "./afirmar.ts";
import { ProveedorClaude } from "../llm_claude.ts";
import { esquemaParaGemini, ProveedorGemini } from "../llm_gemini.ts";
import { codigoPorHttp, fetchConLimite, type PeticionLLM } from "../llm_tipos.ts";
import { elegirModeloRespaldo } from "../llm_fabrica.ts";
import { ErrorApp } from "../errores.ts";
import { type Contrato, CONTRATO_CORRECCION, CONTRATO_EVALUACION, CONTRATO_MENSAJE, CONTRATO_SOLICITUD } from "../salida_llm.ts";

const CONTRATOS: Contrato<unknown>[] = [CONTRATO_SOLICITUD, CONTRATO_EVALUACION, CONTRATO_CORRECCION, CONTRATO_MENSAJE];

/** Captura el cuerpo enviado sustituyendo fetch durante la llamada. */
async function capturar(fn: () => Promise<unknown>, respuesta: unknown): Promise<Record<string, unknown>> {
  const original = globalThis.fetch;
  let cuerpo: Record<string, unknown> = {};
  globalThis.fetch = (_url: string | URL | Request, init?: RequestInit) => {
    cuerpo = JSON.parse(String(init?.body));
    return Promise.resolve(new Response(JSON.stringify(respuesta), { status: 200 }));
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return cuerpo;
}

const peticion = (extra: Partial<PeticionLLM> = {}): PeticionLLM => ({
  sistema: { estatico: "reglas", contexto: "livrable", dinamico: "tarea" },
  mensajeUsuario: "hola",
  imagenes: [],
  maxTokens: 100,
  temperatura: 0,
  formato: { nombre: "solicitud", esquema: CONTRATO_SOLICITUD.json },
  ...extra,
});

Deno.test("mejora C: cada ejemplo del prompt cumple su propio contrato", () => {
  for (const c of CONTRATOS) assert(c.zod.safeParse(c.ejemplo).success, `el ejemplo de «${c.nombre}» no cumple su contrato`);
});

Deno.test("mejora A: los esquemas cumplen las reglas del modo estricto (todo obligatorio, sin campos extra)", () => {
  const revisar = (nodo: unknown, ruta: string) => {
    if (!nodo || typeof nodo !== "object") return;
    const n = nodo as Record<string, unknown>;
    if (n.type === "object") {
      assertEquals(n.additionalProperties, false, `${ruta}: additionalProperties debe ser false`);
      assertEquals([...(n.required as string[])].sort(), Object.keys(n.properties as object).sort(), `${ruta}: required incompleto`);
    }
    for (const [k, v] of Object.entries(n)) {
      if (Array.isArray(v)) v.forEach((x, i) => revisar(x, `${ruta}.${k}[${i}]`));
      else revisar(v, `${ruta}.${k}`);
    }
  };
  for (const c of CONTRATOS) revisar(c.json, c.nombre);
});

Deno.test("mejora A: los ejemplos tienen exactamente los campos que exige el esquema", () => {
  for (const c of CONTRATOS) {
    const req = (c.json as { required: string[] }).required.sort();
    assertEquals(Object.keys(c.ejemplo as object).sort(), req, c.nombre);
  }
});

Deno.test("Claude: historial alternado, sin esquema y con caché en los bloques estables", async () => {
  const c = new ProveedorClaude("k", "claude-sonnet-5-5", 5000);
  const cuerpo = await capturar(() =>
    c.generar(peticion({ historial: [{ rol: "assistant", texto: "{malo}" }, { rol: "user", texto: "corrígelo" }] })),
    { model: "claude-sonnet-5-5", content: [{ type: "text", text: "{}" }], usage: {} });
  assertEquals((cuerpo.messages as Array<{ role: string }>).map((m) => m.role), ["user", "assistant", "user"]);
  assertEquals(cuerpo.response_format, undefined);
  const sistema = cuerpo.system as Array<{ cache_control?: unknown }>;
  assertEquals(sistema.map((b) => !!b.cache_control), [true, true, false]);
});

// ---------- Gemini (formato verificado contra los tipos de @google/genai 2.32.0) ----------
const okGemini = (texto = "{}", extra: Record<string, unknown> = {}) => ({
  modelVersion: "gemini-3.8-flash",
  candidates: [{ content: { parts: [{ text: texto }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 },
  ...extra,
});

/** fetch falso: guarda URL, cabeceras y cuerpo; responde con el estado y cuerpo dados. */
async function llamarGemini(p: PeticionLLM, status: number, cuerpo: unknown) {
  const original = globalThis.fetch;
  let enviado: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
  globalThis.fetch = (url: string | URL | Request, init?: RequestInit) => {
    enviado = { url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
    return Promise.resolve(new Response(typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo), { status }));
  };
  try {
    let resultado: unknown = null;
    let error: ErrorApp | null = null;
    try {
      resultado = await new ProveedorGemini("clave-prueba", "gemini-3.8-flash", 5000, "LOW").generar(p);
    } catch (e) {
      error = e as ErrorApp;
    }
    return { enviado: enviado!, resultado: resultado as Awaited<ReturnType<ProveedorGemini["generar"]>> | null, error };
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("Gemini: URL, clave en cabecera y petición con esquema, razonamiento LOW y sin temperatura", async () => {
  const { enviado } = await llamarGemini(peticion({ maxTokens: 2500 }), 200, okGemini());
  assertEquals(enviado.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
  assertEquals(enviado.headers["x-goog-api-key"], "clave-prueba");
  assert(!enviado.url.includes("clave-prueba"), "la clave nunca va en la URL");
  const g = enviado.body.generationConfig as Record<string, unknown>;
  assertEquals([g.maxOutputTokens, g.responseMimeType, g.temperature], [2500, "application/json", undefined]);
  assertEquals(g.thinkingConfig, { thinkingLevel: "LOW" });
  assert(!!g.responseJsonSchema, "el esquema del contrato viaja en responseJsonSchema");
  assertEquals((enviado.body.systemInstruction as { parts: Array<{ text: string }> }).parts[0].text, "reglas\n\nlivrable\n\ntarea");
});

Deno.test("Gemini: fotos como inlineData y la reparación con el rol «model»", async () => {
  const { enviado } = await llamarGemini(peticion({
    imagenes: [{ mediaType: "image/jpeg", base64: "AAAA" }],
    historial: [{ rol: "assistant", texto: "{malo}" }, { rol: "user", texto: "corrígelo" }],
  }), 200, okGemini());
  const contents = enviado.body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  assertEquals(contents.map((c) => c.role), ["user", "model", "user"]);
  assertEquals(contents[0].parts[0], { inlineData: { mimeType: "image/jpeg", data: "AAAA" } });
  assertEquals(contents[0].parts[1], { text: "hola" });
});

Deno.test("Gemini: el esquema convertido no tiene tipos en lista (anyOf en su lugar) y conserva lo demás", () => {
  for (const c of [CONTRATO_SOLICITUD, CONTRATO_EVALUACION, CONTRATO_CORRECCION, CONTRATO_MENSAJE]) {
    const texto = JSON.stringify(esquemaParaGemini(c.json));
    assert(!/"type":\[/.test(texto), `${c.nombre}: quedó un tipo en lista`);
  }
  assertEquals(esquemaParaGemini({ type: ["integer", "null"] }), { anyOf: [{ type: "integer" }, { type: "null" }] });
  assertEquals(esquemaParaGemini({ type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string", enum: ["x"] } } }),
    { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string", enum: ["x"] } } });
});

Deno.test("Gemini: respuesta normal — ignora las partes de razonamiento y registra los tokens", async () => {
  const { resultado } = await llamarGemini(peticion(), 200, okGemini("", {
    candidates: [{ content: { parts: [{ text: "pensando…", thought: true }, { text: '{"a":' }, { text: "1}" }] }, finishReason: "STOP" }],
  }));
  assertEquals(resultado?.texto, '{"a":1}');
  assertEquals([resultado?.cortada, resultado?.modelo, resultado?.uso.razonamiento], [false, "gemini-3.8-flash", 3]);
});

Deno.test("Gemini: vacía por MAX_TOKENS → 203 «cortada» con diagnóstico (se repetirá con el doble de espacio)", async () => {
  const { error } = await llamarGemini(peticion({ maxTokens: 2500 }), 200, {
    candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }],
    usageMetadata: { promptTokenCount: 8000, candidatesTokenCount: 0, thoughtsTokenCount: 2500 },
  });
  assertEquals([error?.codigo, error?.contexto.tipo_fallo, error?.contexto.tokens_razonamiento], [203, "cortada", 2500]);
});

Deno.test("Gemini: petición bloqueada → 203 con el motivo", async () => {
  const { error } = await llamarGemini(peticion(), 200, { promptFeedback: { blockReason: "SAFETY" } });
  assertEquals([error?.codigo, error?.contexto.bloqueo], [203, "SAFETY"]);
});

Deno.test("Gemini: errores HTTP — 404/400 configuración (208), 403 clave (201), 429 saturado (202), 503 (206)", async () => {
  for (const [status, codigo] of [[404, 208], [400, 208], [403, 201], [429, 202], [503, 206]]) {
    const { error } = await llamarGemini(peticion(), status, '{"error":{"message":"x"}}');
    assertEquals(error?.codigo, codigo, `HTTP ${status}`);
  }
  assertEquals(codigoPorHttp(400), 208);
});

Deno.test("respuestas cortadas con texto: Gemini (MAX_TOKENS) y Claude (max_tokens)", async () => {
  const { resultado } = await llamarGemini(peticion(), 200, okGemini('{"a":', {
    candidates: [{ content: { parts: [{ text: '{"a":' }] }, finishReason: "MAX_TOKENS" }],
  }));
  assertEquals(resultado?.cortada, true);
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({ model: "c", stop_reason: "max_tokens", content: [{ type: "text", text: '{"a":' }], usage: {} }), { status: 200 }));
  try {
    assertEquals((await new ProveedorClaude("k", "c", 5000).generar(peticion())).cortada, true);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("cambio 11: elección del modelo de respaldo", () => {
  assertEquals(elegirModeloRespaldo("gemini", "gemini-3.8-flash", undefined), "gemini-3.5-flash-lite");
  assertEquals(elegirModeloRespaldo("gemini", "gemini-3.8-flash", "gemini-otro"), "gemini-otro");
  assertEquals(elegirModeloRespaldo("gemini", "gemini-3.8-flash", "NINGUNO"), null);
  assertEquals(elegirModeloRespaldo("gemini", "gemini-3.5-flash-lite", undefined), null, "igual al principal → sin respaldo");
  assertEquals(elegirModeloRespaldo("claude", "claude-sonnet-5-5", undefined), null, "Claude: sin respaldo por defecto");
  assertEquals(elegirModeloRespaldo("claude", "claude-sonnet-5-5", "claude-haiku-5-5"), "claude-haiku-5-5");
});

Deno.test("cambio 8: el 204 por tiempo agotado dice qué modelo y cuánto se esperó", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (_u, init) =>
    new Promise((_r, rechazar) => init?.signal?.addEventListener("abort", () => rechazar(new DOMException("x", "AbortError"))));
  try {
    const e = await assertRejects(() => fetchConLimite("https://x", {}, 10, "gemini", "gemini-3.8-flash"), ErrorApp);
    assertEquals([e.codigo, e.contexto.modelo, e.contexto.espera_ms], [204, "gemini-3.8-flash", 10]);
  } finally {
    globalThis.fetch = original;
  }
});
