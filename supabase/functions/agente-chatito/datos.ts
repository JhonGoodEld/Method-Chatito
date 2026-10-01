// datos.ts — Acceso a datos (patrón repositorio).
//
// La lógica del método depende de la INTERFAZ Repositorio, no de Supabase:
// así las pruebas usan un repositorio en memoria y el flujo completo se
// verifica sin base de datos real.
//
// ⚠ SEGURIDAD: esta implementación usa la service role key, que IGNORA RLS.
// Por eso el flujo verifica a mano que alumno_idioma.perfil_id == usuario del
// JWT antes de leer o escribir nada (ver flujo_estudiante.ts). Nunca exponer
// esta key al frontend.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { secretObligatorio, secretOpcional } from "./config.ts";
import { ErrorApp } from "./errores.ts";
import type {
  FilaEstadoUnidad,
  FilaEvidencia,
  FilaEvidenciaNueva,
  LeccionDeclarada,
  Requisitos,
  Sesion,
} from "./tipos.ts";

export interface AlumnoIdioma {
  id: string;
  perfil_id: string;
  idioma_codigo: string;
}

export type CambiosSesion = Partial<Pick<Sesion, "unidad_id" | "etapa_actual" | "fase_correccion" | "requisitos_etapa">>;

export interface Repositorio {
  obtenerAlumnoIdioma(id: string): Promise<AlumnoIdioma | null>;
  obtenerRolPerfil(usuarioId: string): Promise<string | null>;
  obtenerSesion(alumnoIdiomaId: string): Promise<Sesion | null>;
  crearSesion(d: { alumno_idioma_id: string; unidad_id: string; etapa_actual: number; requisitos_etapa: Requisitos }): Promise<Sesion>;
  /** Compare-and-set sobre actualizado_en: si otra petición cambió la sesión → 105. */
  actualizarSesion(sesion: Sesion, cambios: CambiosSesion): Promise<Sesion>;
  obtenerEstados(alumnoIdiomaId: string): Promise<FilaEstadoUnidad[]>;
  /** non_acquis → en_cours. Nunca degrada una unidad ya acquis/consolide. */
  iniciarUnidad(alumnoIdiomaId: string, unidadId: string): Promise<void>;
  /** → acquis. Nunca degrada una unidad consolide. */
  marcarAcquis(alumnoIdiomaId: string, unidadId: string): Promise<void>;
  insertarEvidencias(filas: FilaEvidenciaNueva[]): Promise<void>;
  obtenerEvidenciasUnidad(alumnoIdiomaId: string, unidadId: string): Promise<FilaEvidencia[]>;
  obtenerEvidenciasRecientes(alumnoIdiomaId: string, limite: number): Promise<FilaEvidencia[]>;
  guardarPuntaje(alumnoIdiomaId: string, unidadId: string, puntaje: number): Promise<void>;
  obtenerPila(alumnoIdiomaId: string): Promise<string[]>;
  reemplazarPila(alumnoIdiomaId: string, pila: string[], motivo: string): Promise<void>;
  obtenerLecciones(idiomaCodigo: string): Promise<LeccionDeclarada[]>;
  obtenerContenidoLivrable(unidadId: string): Promise<string | null>;
  subirArchivo(ruta: string, bytes: Uint8Array, mediaType: string): Promise<void>;
  ping(): Promise<boolean>;
}

export function crearClienteAdmin(): SupabaseClient {
  // Supabase inyecta SUPABASE_SERVICE_ROLE_KEY. Como no deja crear secrets que
  // empiecen por SUPABASE_, CLAVE_SERVICIO es la alternativa manual (p. ej. si
  // el proyecto solo usa las claves nuevas sb_secret_...).
  const clave = secretOpcional("SUPABASE_SERVICE_ROLE_KEY") ?? secretOpcional("CLAVE_SERVICIO");
  if (!clave) throw new ErrorApp(598, "Falta SUPABASE_SERVICE_ROLE_KEY (o el secret alternativo CLAVE_SERVICIO)");
  return createClient(secretObligatorio("SUPABASE_URL"), clave, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Valida el JWT del usuario con Supabase Auth. */
export async function obtenerUsuarioDelToken(db: SupabaseClient, jwt: string): Promise<{ id: string }> {
  const { data, error } = await db.auth.getUser(jwt);
  // No confundir "Auth no respondió" con "tu sesión no vale": lo primero es
  // problema nuestro, y pedirle al alumno que vuelva a entrar no lo arreglaría.
  const status = (error as { status?: number } | null)?.status;
  if (error && (error.name === "AuthRetryableFetchError" || status === 0 || (status ?? 0) >= 500)) {
    throw new ErrorApp(106, `Supabase Auth no respondió: ${error.message}`, { status });
  }
  if (error || !data?.user) throw new ErrorApp(401, `JWT inválido: ${error?.message ?? "sin usuario"}`);
  return { id: data.user.id };
}

type ErrorPg = { message: string; code?: string } | null;

function fallo(error: ErrorPg, operacion: string, escritura: boolean): never {
  const e = error ?? { message: "desconocido" };
  if (e.code === "23505" || e.code === "23503" || e.code === "23514" || e.code === "P0001") {
    throw new ErrorApp(102, `${operacion}: ${e.message}`, { pg: e.code });
  }
  throw new ErrorApp(escritura ? 104 : 101, `${operacion}: ${e.message}`, { pg: e.code });
}

const SESION_COLUMNAS = "id, alumno_idioma_id, unidad_id, etapa_actual, fase_correccion, requisitos_etapa, actualizado_en";

export class RepositorioSupabase implements Repositorio {
  constructor(private readonly db: SupabaseClient, private readonly bucket: string) {}

  async obtenerAlumnoIdioma(id: string): Promise<AlumnoIdioma | null> {
    const { data, error } = await this.db
      .from("alumno_idioma")
      .select("id, perfil_id, idiomas!inner(codigo)")
      .eq("id", id)
      .maybeSingle();
    if (error) fallo(error, "leer alumno_idioma", false);
    if (!data) return null;
    const idiomas = (data as unknown as { idiomas: { codigo: string } | { codigo: string }[] }).idiomas;
    const codigo = Array.isArray(idiomas) ? idiomas[0]?.codigo : idiomas?.codigo;
    return { id: data.id, perfil_id: data.perfil_id, idioma_codigo: codigo };
  }

  async obtenerRolPerfil(usuarioId: string): Promise<string | null> {
    const { data, error } = await this.db.from("perfiles").select("rol").eq("id", usuarioId).maybeSingle();
    if (error) fallo(error, "leer perfil", false);
    return data?.rol ?? null;
  }

  async obtenerSesion(alumnoIdiomaId: string): Promise<Sesion | null> {
    const { data, error } = await this.db
      .from("sesion_leccion")
      .select(SESION_COLUMNAS)
      .eq("alumno_idioma_id", alumnoIdiomaId)
      .maybeSingle();
    if (error) fallo(error, "leer sesion_leccion", false);
    return (data as Sesion | null) ?? null;
  }

  async crearSesion(d: { alumno_idioma_id: string; unidad_id: string; etapa_actual: number; requisitos_etapa: Requisitos }): Promise<Sesion> {
    const { data, error } = await this.db
      .from("sesion_leccion")
      .insert({ ...d, fase_correccion: null, actualizado_en: new Date().toISOString() })
      .select(SESION_COLUMNAS)
      .single();
    if (error?.code === "23505") throw new ErrorApp(105, "sesion_leccion ya existe (creación concurrente)");
    if (error || !data) fallo(error, "crear sesion_leccion", true);
    return data as Sesion;
  }

  async actualizarSesion(sesion: Sesion, cambios: CambiosSesion): Promise<Sesion> {
    const { data, error } = await this.db
      .from("sesion_leccion")
      .update({ ...cambios, actualizado_en: new Date().toISOString() })
      .eq("id", sesion.id)
      .eq("actualizado_en", sesion.actualizado_en)
      .select(SESION_COLUMNAS);
    if (error) fallo(error, "actualizar sesion_leccion", true);
    if (!data || data.length === 0) {
      throw new ErrorApp(105, "sesion_leccion modificada por otra petición (CAS)", { sesion_id: sesion.id });
    }
    return data[0] as Sesion;
  }

  async obtenerEstados(alumnoIdiomaId: string): Promise<FilaEstadoUnidad[]> {
    const { data, error } = await this.db
      .from("unidad_estado")
      .select("unidad_id, estado, actualizado_en")
      .eq("alumno_idioma_id", alumnoIdiomaId);
    if (error) fallo(error, "leer unidad_estado", false);
    return (data ?? []) as FilaEstadoUnidad[];
  }

  private async estadoActual(alumnoIdiomaId: string, unidadId: string): Promise<string | null> {
    const { data, error } = await this.db
      .from("unidad_estado")
      .select("estado")
      .eq("alumno_idioma_id", alumnoIdiomaId)
      .eq("unidad_id", unidadId)
      .maybeSingle();
    if (error) fallo(error, "leer unidad_estado", false);
    return data?.estado ?? null;
  }

  async iniciarUnidad(alumnoIdiomaId: string, unidadId: string): Promise<void> {
    const actual = await this.estadoActual(alumnoIdiomaId, unidadId);
    if (actual && actual !== "non_acquis") return; // nunca regresivo (MC-002 §29)
    const { error } = await this.db.from("unidad_estado").upsert(
      { alumno_idioma_id: alumnoIdiomaId, unidad_id: unidadId, estado: "en_cours", actualizado_en: new Date().toISOString() },
      { onConflict: "alumno_idioma_id,unidad_id" },
    );
    if (error) fallo(error, "iniciar unidad", true);
  }

  async marcarAcquis(alumnoIdiomaId: string, unidadId: string): Promise<void> {
    const actual = await this.estadoActual(alumnoIdiomaId, unidadId);
    if (actual === "acquis" || actual === "consolide") return;
    const { error } = await this.db.from("unidad_estado").upsert(
      { alumno_idioma_id: alumnoIdiomaId, unidad_id: unidadId, estado: "acquis", actualizado_en: new Date().toISOString() },
      { onConflict: "alumno_idioma_id,unidad_id" },
    );
    if (error) fallo(error, "marcar acquis", true);
  }

  async insertarEvidencias(filas: FilaEvidenciaNueva[]): Promise<void> {
    if (filas.length === 0) return;
    const { error } = await this.db.from("evidencia").insert(filas);
    if (error) fallo(error, "insertar evidencia", true);
  }

  async obtenerEvidenciasUnidad(alumnoIdiomaId: string, unidadId: string): Promise<FilaEvidencia[]> {
    const { data, error } = await this.db
      .from("evidencia")
      .select("*")
      .eq("alumno_idioma_id", alumnoIdiomaId)
      .eq("unidad_id", unidadId)
      .order("creado_en", { ascending: true });
    if (error) fallo(error, "leer evidencia de la unidad", false);
    return (data ?? []) as FilaEvidencia[];
  }

  async obtenerEvidenciasRecientes(alumnoIdiomaId: string, limite: number): Promise<FilaEvidencia[]> {
    const { data, error } = await this.db
      .from("evidencia")
      .select("id, unidad_id, creado_en, diagnosticos, metricas, nivel_ejercicio, etapa_mc001")
      .eq("alumno_idioma_id", alumnoIdiomaId)
      .order("creado_en", { ascending: false })
      .limit(limite);
    if (error) fallo(error, "leer evidencia reciente", false);
    return (data ?? []) as unknown as FilaEvidencia[];
  }

  async guardarPuntaje(alumnoIdiomaId: string, unidadId: string, puntaje: number): Promise<void> {
    const { error } = await this.db.from("puntaje_leccion").upsert(
      { alumno_idioma_id: alumnoIdiomaId, unidad_id: unidadId, puntaje, calculado_en: new Date().toISOString() },
      { onConflict: "alumno_idioma_id,unidad_id" },
    );
    if (error) fallo(error, "guardar puntaje", true);
  }

  async obtenerPila(alumnoIdiomaId: string): Promise<string[]> {
    const { data, error } = await this.db
      .from("rama_interrumpida")
      .select("unidad_id, orden_pila")
      .eq("alumno_idioma_id", alumnoIdiomaId)
      .order("orden_pila", { ascending: true });
    if (error) fallo(error, "leer pila", false);
    return (data ?? []).map((f) => f.unidad_id as string);
  }

  async reemplazarPila(alumnoIdiomaId: string, pila: string[], motivo: string): Promise<void> {
    const { error: e1 } = await this.db.from("rama_interrumpida").delete().eq("alumno_idioma_id", alumnoIdiomaId);
    if (e1) fallo(e1, "vaciar pila", true);
    if (pila.length === 0) return;
    const { error: e2 } = await this.db.from("rama_interrumpida").insert(
      pila.map((dominio, i) => ({ alumno_idioma_id: alumnoIdiomaId, unidad_id: dominio, motivo, orden_pila: i })),
    );
    if (e2) fallo(e2, "escribir pila", true);
  }

  async obtenerLecciones(idiomaCodigo: string): Promise<LeccionDeclarada[]> {
    const { data, error } = await this.db
      .from("livrables")
      .select("unidad_id, dominio_id, sous_domaine_id, titulo, orden_declarado, prerequis, estado_redaccion")
      .eq("idioma_codigo", idiomaCodigo);
    if (error) fallo(error, "leer livrables", false);
    return (data ?? []).map((l) => ({ ...l, prerequis: l.prerequis ?? [] })) as LeccionDeclarada[];
  }

  async obtenerContenidoLivrable(unidadId: string): Promise<string | null> {
    const { data, error } = await this.db
      .from("livrables")
      .select("contenido")
      .eq("unidad_id", unidadId)
      .eq("estado_redaccion", "redactado")
      .maybeSingle();
    if (error) fallo(error, "leer contenido de livrable", false);
    return data?.contenido ?? null;
  }

  async subirArchivo(ruta: string, bytes: Uint8Array, mediaType: string): Promise<void> {
    const { error } = await this.db.storage.from(this.bucket).upload(ruta, bytes, { contentType: mediaType, upsert: false });
    if (error) throw new ErrorApp(502, `subir ${ruta}: ${error.message}`);
  }

  async ping(): Promise<boolean> {
    const { error } = await this.db.from("idiomas").select("id").limit(1);
    return !error;
  }
}
