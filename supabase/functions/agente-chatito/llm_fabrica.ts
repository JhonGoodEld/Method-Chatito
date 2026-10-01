// llm_fabrica.ts — El único lugar que decide qué proveedor se usa.
//   LLM_PROVIDER = "openrouter" | "claude"
//   LLM_MODEL    = (opcional) sobrescribe el modelo por defecto

import { INFRA, secretObligatorio, secretOpcional } from "./config.ts";
import { ErrorApp } from "./errores.ts";
import { ProveedorClaude } from "./llm_claude.ts";
import { ProveedorOpenRouter } from "./llm_openrouter.ts";
import type { ProveedorLLM } from "./llm_tipos.ts";

export function crearProveedor(): ProveedorLLM {
  const proveedor = (secretOpcional("LLM_PROVIDER") ?? "").toLowerCase();
  const modelo = secretOpcional("LLM_MODEL");

  switch (proveedor) {
    case "claude":
      return new ProveedorClaude(
        claveObligatoria("ANTHROPIC_API_KEY"),
        modelo ?? INFRA.MODELO_CLAUDE_POR_DEFECTO,
        INFRA.TIMEOUT_LLM_MS,
      );
    case "openrouter":
      return new ProveedorOpenRouter(
        claveObligatoria("OPENROUTER_API_KEY"),
        modelo ?? INFRA.MODELO_OPENROUTER_POR_DEFECTO,
        INFRA.TIMEOUT_LLM_MS,
        (secretOpcional("OPENROUTER_MODO_JSON") ?? "true") !== "false",
        secretOpcional("SITIO_URL"),
      );
    default:
      throw new ErrorApp(205, `LLM_PROVIDER inválido o ausente: "${proveedor}" (usa "openrouter" o "claude")`);
  }
}

function claveObligatoria(nombre: string): string {
  try {
    return secretObligatorio(nombre);
  } catch {
    throw new ErrorApp(205, `Falta el secret ${nombre} para el proveedor elegido`);
  }
}
