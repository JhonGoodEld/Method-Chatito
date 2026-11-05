// llm_fabrica.ts — El único lugar que decide qué proveedor y qué modelos se usan.
//   LLM_PROVIDER       = "gemini" (pruebas del desarrollador) | "claude" (producción)
//   LLM_MODEL          = (opcional) sobrescribe el modelo principal del proveedor
//   LLM_MODEL_RESPALDO = (opcional) modelo del segundo intento tras saturación o
//                        tiempo agotado; "ninguno" lo desactiva (cambio 11)
//
// Cambiar de proveedor = cambiar LLM_PROVIDER y su clave; ninguna otra línea.

import { INFRA, secretObligatorio, secretOpcional } from "./config.ts";
import { ErrorApp } from "./errores.ts";
import { ProveedorClaude } from "./llm_claude.ts";
import { ProveedorGemini } from "./llm_gemini.ts";
import type { ProveedorLLM } from "./llm_tipos.ts";

/** Proveedor con el modelo principal. */
export function crearProveedor(): ProveedorLLM {
  const proveedor = leerProveedor();
  return construir(proveedor, secretOpcional("LLM_MODEL") ?? modeloPorDefecto(proveedor));
}

/**
 * Proveedor con el modelo de respaldo, o null si no hay (o es igual al principal).
 * Mismo proveedor y misma clave: solo cambia el modelo.
 */
export function crearProveedorRespaldo(): ProveedorLLM | null {
  const proveedor = leerProveedor();
  const principal = secretOpcional("LLM_MODEL") ?? modeloPorDefecto(proveedor);
  const modelo = elegirModeloRespaldo(proveedor, principal, secretOpcional("LLM_MODEL_RESPALDO"));
  return modelo ? construir(proveedor, modelo) : null;
}

/** Regla pura (probada sin secrets): qué modelo de respaldo corresponde. */
export function elegirModeloRespaldo(proveedor: string, principal: string, pedido: string | undefined): string | null {
  if (pedido?.trim().toLowerCase() === "ninguno") return null;
  // Claude no trae respaldo por defecto: en producción se decidirá cuál conviene.
  const modelo = pedido?.trim() || (proveedor === "gemini" ? INFRA.MODELO_GEMINI_RESPALDO : null);
  return modelo && modelo !== principal ? modelo : null;
}

function leerProveedor(): string {
  return (secretOpcional("LLM_PROVIDER") ?? "").toLowerCase();
}

function modeloPorDefecto(proveedor: string): string {
  if (proveedor === "gemini") return INFRA.MODELO_GEMINI_POR_DEFECTO;
  if (proveedor === "claude") return INFRA.MODELO_CLAUDE_POR_DEFECTO;
  throw new ErrorApp(205, `LLM_PROVIDER inválido o ausente: "${proveedor}" (usa "gemini" o "claude")`);
}

function construir(proveedor: string, modelo: string): ProveedorLLM {
  switch (proveedor) {
    case "gemini":
      return new ProveedorGemini(
        claveObligatoria("GEMINI_API_KEY"),
        modelo,
        INFRA.TIMEOUT_LLM_MS,
        INFRA.NIVEL_RAZONAMIENTO_GEMINI,
      );
    case "claude":
      return new ProveedorClaude(claveObligatoria("ANTHROPIC_API_KEY"), modelo, INFRA.TIMEOUT_LLM_MS);
    default:
      throw new ErrorApp(205, `LLM_PROVIDER inválido o ausente: "${proveedor}" (usa "gemini" o "claude")`);
  }
}

function claveObligatoria(nombre: string): string {
  try {
    return secretObligatorio(nombre);
  } catch {
    throw new ErrorApp(205, `Falta el secret ${nombre} para el proveedor elegido`);
  }
}
