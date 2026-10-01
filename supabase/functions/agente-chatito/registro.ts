// registro.ts — Registro de eventos en la tabla logs_sistema.
//
// Reglas:
//  1. Registrar NUNCA rompe la petición: si la inserción falla, se escribe en la
//     consola (visible en Supabase → Edge Functions → Logs) y se sigue.
//  2. A la tabla solo van eventos con severidad >= INFRA.SEVERIDAD_MINIMA_REGISTRO,
//     más la telemetría explícita (9xx). Todo va también a la consola.
//  3. Privacidad: el contexto lleva identificadores y datos técnicos, no el
//     contenido del alumno (única excepción: fragmento truncado de 300
//     caracteres en errores 203, para depurar respuestas malformadas).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { CATALOGO, type CodigoError, type ErrorApp, type Severidad } from "./errores.ts";
import { INFRA } from "./config.ts";

const ORDEN: Record<Severidad, number> = { info: 0, warning: 1, error: 2, critico: 3 };

export interface EventoRegistro {
  codigo: CodigoError;
  severidad?: Severidad;
  mensaje?: string;
  contexto?: Record<string, unknown>;
  stack?: string;
  duracionMs?: number;
}

export interface Registrador {
  usuarioId: string | null;
  registrar(evento: EventoRegistro): Promise<void>;
  registrarError(error: ErrorApp, duracionMs?: number): Promise<void>;
}

export class RegistradorSupabase implements Registrador {
  usuarioId: string | null = null;

  constructor(
    private readonly db: SupabaseClient,
    private readonly requestId: string,
  ) {}

  async registrar(e: EventoRegistro): Promise<void> {
    const severidad = e.severidad ?? CATALOGO[e.codigo].severidad;
    const fila = {
      request_id: this.requestId,
      usuario_id: this.usuarioId,
      codigo: e.codigo,
      severidad,
      mensaje: e.mensaje ?? CATALOGO[e.codigo].nombre,
      contexto: e.contexto ?? {},
      stack_trace: e.stack ?? null,
      duracion_ms: e.duracionMs ?? null,
    };
    console.log(JSON.stringify({ nivel: severidad, ...fila }));

    const esTelemetria = e.codigo >= 900;
    if (!esTelemetria && ORDEN[severidad] < ORDEN[INFRA.SEVERIDAD_MINIMA_REGISTRO]) return;
    try {
      const { error } = await this.db.from("logs_sistema").insert(fila);
      if (error) console.error(JSON.stringify({ nivel: "error", registro_fallido: error.message }));
    } catch (err) {
      console.error(JSON.stringify({ nivel: "error", registro_fallido: String(err) }));
    }
  }

  registrarError(error: ErrorApp, duracionMs?: number): Promise<void> {
    return this.registrar({
      codigo: error.codigo,
      severidad: error.severidad,
      mensaje: error.detalleTecnico,
      contexto: error.contexto,
      stack: error.codigo === 599 ? error.stack : undefined,
      duracionMs,
    });
  }
}

/** Registrador para pruebas y para cuando la BD no está disponible. */
export class RegistradorConsola implements Registrador {
  usuarioId: string | null = null;
  readonly eventos: EventoRegistro[] = [];

  registrar(e: EventoRegistro): Promise<void> {
    this.eventos.push(e);
    console.log(JSON.stringify({ nivel: e.severidad ?? CATALOGO[e.codigo].severidad, codigo: e.codigo, mensaje: e.mensaje, contexto: e.contexto }));
    return Promise.resolve();
  }
  registrarError(error: ErrorApp): Promise<void> {
    return this.registrar({ codigo: error.codigo, mensaje: error.detalleTecnico, contexto: error.contexto });
  }
}
