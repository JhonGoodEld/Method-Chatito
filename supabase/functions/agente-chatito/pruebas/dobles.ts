// dobles.ts — Implementaciones falsas para probar el flujo sin red ni BD.
import type { AlumnoIdioma, CambiosSesion, Repositorio } from "../datos.ts";
import { ErrorApp } from "../errores.ts";
import type { PeticionLLM, ProveedorLLM, RespuestaLLM } from "../llm_tipos.ts";
import type { ServiciosAuxiliares } from "../flujo_estudiante.ts";
import type {
  FilaEstadoUnidad,
  FilaEvidencia,
  FilaEvidenciaNueva,
  LeccionDeclarada,
  Requisitos,
  Sesion,
} from "../tipos.ts";

let reloj = Date.parse("2026-09-01T10:00:00.000Z");
/** Reloj determinista: cada llamada avanza 1 segundo. */
export const marca = () => new Date((reloj += 1000)).toISOString();

export class RepositorioMemoria implements Repositorio {
  alumnos = new Map<string, AlumnoIdioma>();
  roles = new Map<string, string>();
  sesiones = new Map<string, Sesion>();
  estados = new Map<string, FilaEstadoUnidad & { alumno: string }>();
  evidencias: FilaEvidencia[] = [];
  puntajes = new Map<string, number>();
  pilas = new Map<string, string[]>();
  lecciones: Array<LeccionDeclarada & { idioma: string; contenido: string | null }> = [];
  archivos: string[] = [];
  fallarSubida = false;

  obtenerAlumnoIdioma(id: string) {
    return Promise.resolve(this.alumnos.get(id) ?? null);
  }
  obtenerRolPerfil(u: string) {
    return Promise.resolve(this.roles.get(u) ?? null);
  }
  obtenerSesion(a: string) {
    const s = this.sesiones.get(a);
    return Promise.resolve(s ? structuredClone(s) : null);
  }
  crearSesion(d: { alumno_idioma_id: string; unidad_id: string; etapa_actual: number; requisitos_etapa: Requisitos }) {
    if (this.sesiones.has(d.alumno_idioma_id)) throw new ErrorApp(105, "ya existe");
    const s: Sesion = { id: `s-${d.alumno_idioma_id}`, fase_correccion: null, actualizado_en: marca(), ...structuredClone(d) };
    this.sesiones.set(d.alumno_idioma_id, s);
    return Promise.resolve(structuredClone(s));
  }
  actualizarSesion(sesion: Sesion, cambios: CambiosSesion) {
    const actual = this.sesiones.get(sesion.alumno_idioma_id);
    if (!actual || actual.actualizado_en !== sesion.actualizado_en) throw new ErrorApp(105, "CAS");
    const nueva = { ...actual, ...structuredClone(cambios), actualizado_en: marca() };
    this.sesiones.set(sesion.alumno_idioma_id, nueva);
    return Promise.resolve(structuredClone(nueva));
  }
  obtenerEstados(a: string) {
    return Promise.resolve(
      [...this.estados.values()].filter((e) => e.alumno === a).map(({ alumno: _a, ...r }) => r),
    );
  }
  iniciarUnidad(a: string, u: string) {
    const k = `${a}|${u}`;
    const e = this.estados.get(k);
    if (!e || e.estado === "non_acquis") this.estados.set(k, { alumno: a, unidad_id: u, estado: "en_cours", actualizado_en: marca() });
    return Promise.resolve();
  }
  marcarAcquis(a: string, u: string) {
    const k = `${a}|${u}`;
    const e = this.estados.get(k);
    if (e?.estado !== "acquis" && e?.estado !== "consolide") {
      this.estados.set(k, { alumno: a, unidad_id: u, estado: "acquis", actualizado_en: marca() });
    }
    return Promise.resolve();
  }
  insertarEvidencias(filas: FilaEvidenciaNueva[]) {
    for (const f of filas) this.evidencias.push({ ...structuredClone(f), id: crypto.randomUUID(), creado_en: marca() });
    return Promise.resolve();
  }
  obtenerEvidenciasUnidad(a: string, u: string) {
    return Promise.resolve(this.evidencias.filter((e) => e.alumno_idioma_id === a && e.unidad_id === u));
  }
  obtenerEvidenciasRecientes(a: string, limite: number) {
    return Promise.resolve(this.evidencias.filter((e) => e.alumno_idioma_id === a).reverse().slice(0, limite));
  }
  guardarPuntaje(a: string, u: string, p: number) {
    this.puntajes.set(`${a}|${u}`, p);
    return Promise.resolve();
  }
  obtenerPila(a: string) {
    return Promise.resolve([...(this.pilas.get(a) ?? [])]);
  }
  reemplazarPila(a: string, pila: string[]) {
    this.pilas.set(a, [...pila]);
    return Promise.resolve();
  }
  obtenerLecciones(idioma: string) {
    return Promise.resolve(
      this.lecciones.filter((l) => l.idioma === idioma).map(({ idioma: _i, contenido: _c, ...l }) => l),
    );
  }
  obtenerContenidoLivrable(u: string) {
    const l = this.lecciones.find((x) => x.unidad_id === u && x.estado_redaccion === "redactado");
    return Promise.resolve(l?.contenido ?? null);
  }
  subirArchivo(ruta: string) {
    if (this.fallarSubida) throw new ErrorApp(502, "storage caído");
    this.archivos.push(ruta);
    return Promise.resolve();
  }
  ping() {
    return Promise.resolve(true);
  }
}

/** LLM con guion: devuelve las respuestas en orden y guarda cada petición recibida. */
export class LLMFalso implements ProveedorLLM {
  readonly nombre = "falso";
  readonly modelo = "guion-v1";
  peticiones: PeticionLLM[] = [];
  constructor(private readonly guion: Array<unknown>) {}

  generar(p: PeticionLLM): Promise<RespuestaLLM> {
    this.peticiones.push(p);
    const siguiente = this.guion.shift();
    if (siguiente === undefined) throw new Error("El guion del LLM falso se agotó");
    const texto = typeof siguiente === "string" ? siguiente : JSON.stringify(siguiente);
    return Promise.resolve({ texto, proveedor: this.nombre, modelo: this.modelo, uso: {}, latenciaMs: 1 });
  }
}

export class AuxiliaresFalsos implements ServiciosAuxiliares {
  cache = new Map<string, string>();
  limiteAgotado = false;
  romper = false;
  verificarLimiteGlobalLLM() {
    if (this.romper) return Promise.reject(new Error("redis caído"));
    return Promise.resolve({ permitido: !this.limiteAgotado, reintentarEnSeg: 60 });
  }
  leerLivrable(u: string) {
    if (this.romper) return Promise.reject(new Error("redis caído"));
    return Promise.resolve(this.cache.get(u) ?? null);
  }
  guardarLivrable(u: string, c: string) {
    if (this.romper) return Promise.reject(new Error("redis caído"));
    this.cache.set(u, c);
    return Promise.resolve();
  }
}

export function leccion(
  unidad_id: string,
  dominio_id: string,
  sous_domaine_id: string | null,
  orden_declarado: number,
  extra: Partial<LeccionDeclarada> = {},
): LeccionDeclarada {
  return {
    unidad_id,
    dominio_id,
    sous_domaine_id,
    titulo: `Título ${unidad_id}`,
    orden_declarado,
    prerequis: [],
    estado_redaccion: "redactado",
    ...extra,
  };
}
