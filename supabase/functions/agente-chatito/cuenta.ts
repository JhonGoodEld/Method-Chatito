// cuenta.ts — Eliminación de la cuenta (derecho de cancelación ARCO; requisito
// de App Store y Google Play). Módulo AISLADO: no toca el flujo del estudiante.
//
// Qué se borra y cómo:
//   1. Fotos de evidencia en Storage (carpeta <usuario>/): Storage NO se borra
//      en cascada, así que se recorre y se elimina aquí.
//   2. El usuario de Supabase Auth. La base de datos borra en cascada todo lo
//      demás: perfil, idiomas, evidencia, progreso, puntajes, sesiones, pila y
//      solicitudes. logs_sistema queda anonimizado (usuario_id → null).
//
// Orden deliberado: primero las fotos, después el usuario. Si falla el paso 1,
// la cuenta sigue intacta y el usuario puede reintentar sin perder nada. Si
// fallara el paso 2, las fotos ya no están pero un reintento termina el borrado.
//
// Las claves de Upstash (límites, candado) solo contienen el id y caducan solas.
// Lo ya enviado a proveedores de IA no puede recuperarse desde aquí: se
// declara en el aviso de privacidad.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ErrorApp } from "./errores.ts";

/** Texto que el usuario debe enviar, literal, para confirmar. */
export const FRASE_CONFIRMACION = "ELIMINAR";

export interface ServiciosCuenta {
  /** Entradas directas de una carpeta: archivos (esCarpeta=false) y subcarpetas. */
  listar(carpeta: string): Promise<Array<{ nombre: string; esCarpeta: boolean }>>;
  borrarArchivos(rutas: string[]): Promise<void>;
  eliminarUsuario(usuarioId: string): Promise<void>;
}

export interface ResultadoEliminacion {
  archivos_eliminados: number;
}

/** Recorre recursivamente la carpeta y devuelve todas las rutas de archivo. */
export async function listarRecursivo(servicios: ServiciosCuenta, carpeta: string, profundidad = 0): Promise<string[]> {
  if (profundidad > 10) throw new ErrorApp(504, `Estructura de carpetas demasiado profunda en ${carpeta}`);
  const rutas: string[] = [];
  for (const entrada of await servicios.listar(carpeta)) {
    const ruta = `${carpeta}/${entrada.nombre}`;
    if (entrada.esCarpeta) rutas.push(...(await listarRecursivo(servicios, ruta, profundidad + 1)));
    else rutas.push(ruta);
  }
  return rutas;
}

export async function eliminarCuenta(
  servicios: ServiciosCuenta,
  usuarioId: string,
  confirmacion: string | undefined,
): Promise<ResultadoEliminacion> {
  if (confirmacion !== FRASE_CONFIRMACION) {
    throw new ErrorApp(312, `Confirmación ausente o incorrecta (se esperaba "${FRASE_CONFIRMACION}")`);
  }

  // 1. Fotos de evidencia.
  let rutas: string[];
  try {
    rutas = await listarRecursivo(servicios, usuarioId);
    for (let i = 0; i < rutas.length; i += 100) {
      await servicios.borrarArchivos(rutas.slice(i, i + 100));
    }
  } catch (e) {
    if (e instanceof ErrorApp) throw e;
    throw new ErrorApp(504, `Storage: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. Usuario (la base de datos borra el resto en cascada).
  try {
    await servicios.eliminarUsuario(usuarioId);
  } catch (e) {
    throw new ErrorApp(107, `Auth: ${e instanceof Error ? e.message : String(e)}`, { archivos_ya_eliminados: rutas.length });
  }

  return { archivos_eliminados: rutas.length };
}

/** Implementación real sobre Supabase (service role). */
export class CuentaSupabase implements ServiciosCuenta {
  constructor(private readonly db: SupabaseClient, private readonly bucket: string) {}

  async listar(carpeta: string): Promise<Array<{ nombre: string; esCarpeta: boolean }>> {
    const entradas: Array<{ nombre: string; esCarpeta: boolean }> = [];
    const limite = 1000;
    for (let offset = 0;; offset += limite) {
      const { data, error } = await this.db.storage.from(this.bucket).list(carpeta, { limit: limite, offset });
      if (error) throw new Error(`listar ${carpeta}: ${error.message}`);
      // En Storage, las carpetas aparecen con id null.
      for (const o of data ?? []) entradas.push({ nombre: o.name, esCarpeta: o.id === null });
      if (!data || data.length < limite) break;
    }
    return entradas;
  }

  async borrarArchivos(rutas: string[]): Promise<void> {
    if (rutas.length === 0) return;
    const { error } = await this.db.storage.from(this.bucket).remove(rutas);
    if (error) throw new Error(`borrar archivos: ${error.message}`);
  }

  async eliminarUsuario(usuarioId: string): Promise<void> {
    const { error } = await this.db.auth.admin.deleteUser(usuarioId);
    if (error) throw new Error(error.message);
  }
}
