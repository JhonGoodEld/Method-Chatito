// peticion.ts — Validación de lo que envía el frontend (módulo PURO).
//
// Contrato del cuerpo (POST, JSON):
//   { "modo": "estudiante", "accion": "continuar",  "alumno_idioma_id": "<uuid>" }
//   { "modo": "estudiante", "accion": "responder",  "alumno_idioma_id": "<uuid>",
//     "mensaje": "texto opcional", "imagenes": [{ "media_type": "image/jpeg", "base64": "..." }] }
//   { "accion": "diagnostico", "probar_llm": false }            (solo rol admin)

import { z } from "npm:zod@3.23.8";
import { INFRA } from "./config.ts";
import { ErrorApp } from "./errores.ts";
import type { ImagenEntrada } from "./llm_tipos.ts";

const Modo = z.enum(["estudiante", "docente_aprender", "docente_crear"]).default("estudiante");

const ImagenSchema = z.object({
  media_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
  base64: z.string().min(16),
});

export const CuerpoSchema = z.discriminatedUnion("accion", [
  z.object({ accion: z.literal("continuar"), modo: Modo, alumno_idioma_id: z.string().uuid() }),
  z.object({
    accion: z.literal("responder"),
    modo: Modo,
    alumno_idioma_id: z.string().uuid(),
    mensaje: z.string().max(INFRA.MAX_CARACTERES_MENSAJE).optional(),
    imagenes: z.array(ImagenSchema).max(INFRA.MAX_IMAGENES).optional(),
  }),
  z.object({ accion: z.literal("diagnostico"), modo: Modo, probar_llm: z.boolean().optional() }),
]);

export type Cuerpo = z.infer<typeof CuerpoSchema>;

export function validarCuerpo(texto: string): Cuerpo {
  let crudo: unknown;
  try {
    crudo = JSON.parse(texto);
  } catch {
    throw new ErrorApp(306, "el cuerpo no es JSON válido");
  }
  const r = CuerpoSchema.safeParse(crudo);
  if (!r.success) {
    const problemas = r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`);
    throw new ErrorApp(306, `cuerpo fuera de contrato: ${problemas.join(" | ")}`);
  }
  return r.data;
}

export function decodificarBase64(b64: string): Uint8Array {
  const limpio = b64.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
  let binario: string;
  try {
    binario = atob(limpio);
  } catch {
    throw new ErrorApp(307, "base64 inválido");
  }
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

/** Comprueba que el contenido real coincide con el tipo declarado. */
function bytesCoinciden(bytes: Uint8Array, tipo: ImagenEntrada["mediaType"]): boolean {
  const empieza = (...firma: number[]) => firma.every((b, i) => bytes[i] === b);
  switch (tipo) {
    case "image/jpeg":
      return empieza(0xff, 0xd8, 0xff);
    case "image/png":
      return empieza(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/webp":
      return empieza(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  }
}

export function validarImagenes(imagenes: Array<{ media_type: ImagenEntrada["mediaType"]; base64: string }> = []): ImagenEntrada[] {
  return imagenes.map((img, i) => {
    const bytes = decodificarBase64(img.base64);
    if (bytes.length > INFRA.MAX_BYTES_IMAGEN) {
      throw new ErrorApp(307, `imagen ${i}: ${bytes.length} bytes (máx. ${INFRA.MAX_BYTES_IMAGEN}); redúcela en el frontend`);
    }
    if (!bytesCoinciden(bytes, img.media_type)) {
      throw new ErrorApp(307, `imagen ${i}: el contenido no es un ${img.media_type} real`);
    }
    return { mediaType: img.media_type, base64: img.base64.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "") };
  });
}
