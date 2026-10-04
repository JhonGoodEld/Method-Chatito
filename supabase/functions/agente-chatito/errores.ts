// errores.ts — Catálogo único de códigos de error del agente Método Chatito.
//
// Esquema por rangos (idea original de J. Good, extendida):
//   1xx  Base de datos
//   2xx  Proveedor de IA (agente / API key)
//   3xx  Reglas de negocio y validación de la petición
//   4xx  Acceso: autenticación, permisos, abuso (rate limit)
//   5xx  Infraestructura (Redis, Storage, configuración)
//   9xx  Telemetría (no son errores: registros de uso)
//
// Cada código tiene: estado HTTP, mensaje para el usuario final (nunca
// detalles técnicos ni secretos) y severidad por defecto para el registro.
// Este módulo es PURO (sin acceso a red ni a variables de entorno).

export type Severidad = "info" | "warning" | "error" | "critico";

interface DefinicionError {
  readonly nombre: string;
  readonly http: number;
  readonly mensaje: string;
  readonly severidad: Severidad;
}

export const CATALOGO = {
  // ---------- 1xx Base de datos ----------
  101: { nombre: "DB_LECTURA", http: 500, severidad: "critico", mensaje: "No pudimos leer tu progreso. Intenta de nuevo en un momento." },
  102: { nombre: "DB_RESTRICCION", http: 409, severidad: "error", mensaje: "La operación choca con una regla de la base de datos." },
  103: { nombre: "DB_NO_ENCONTRADO", http: 404, severidad: "warning", mensaje: "No encontramos el recurso solicitado." },
  104: { nombre: "DB_ESCRITURA", http: 500, severidad: "critico", mensaje: "No pudimos guardar tu progreso. Intenta de nuevo en un momento." },
  106: { nombre: "SUPABASE_NO_DISPONIBLE", http: 503, severidad: "critico", mensaje: "El servicio no está disponible en este momento. Intenta en unos minutos." },
  107: { nombre: "CUENTA_NO_ELIMINADA", http: 500, severidad: "critico", mensaje: "No pudimos completar la eliminación de tu cuenta. Intenta de nuevo." },
  105: { nombre: "DB_CONFLICTO_CONCURRENCIA", http: 409, severidad: "warning", mensaje: "Tu sesión cambió mientras procesábamos la petición. Recarga e intenta de nuevo." },

  // ---------- 2xx Proveedor de IA ----------
  201: { nombre: "LLM_AUTENTICACION", http: 502, severidad: "critico", mensaje: "El agente no está disponible en este momento (configuración)." },
  202: { nombre: "LLM_LIMITE_PROVEEDOR", http: 503, severidad: "warning", mensaje: "El agente está saturado. Intenta de nuevo en unos minutos." },
  203: { nombre: "LLM_RESPUESTA_MALFORMADA", http: 502, severidad: "error", mensaje: "El agente respondió en un formato inesperado. Intenta de nuevo." },
  204: { nombre: "LLM_TIEMPO_AGOTADO", http: 504, severidad: "error", mensaje: "El agente tardó demasiado en responder. Intenta de nuevo." },
  205: { nombre: "LLM_NO_CONFIGURADO", http: 500, severidad: "critico", mensaje: "El agente no está configurado todavía." },
  206: { nombre: "LLM_ERROR_PROVEEDOR", http: 502, severidad: "error", mensaje: "El proveedor del agente falló. Intenta de nuevo." },
  207: { nombre: "LLM_SIN_CREDITO", http: 502, severidad: "critico", mensaje: "El agente no está disponible en este momento (cuota agotada)." },

  // ---------- 3xx Negocio y validación ----------
  301: { nombre: "LIMITE_IDIOMAS", http: 409, severidad: "info", mensaje: "Ya tienes 3 idiomas en curso, que es el máximo." },
  303: { nombre: "SOLICITUD_PENDIENTE_EXISTENTE", http: 409, severidad: "info", mensaje: "Ya tienes una solicitud de idioma nuevo en espera." },
  304: { nombre: "IDIOMA_YA_EXISTE", http: 409, severidad: "info", mensaje: "Ese idioma ya existe en el catálogo: inscríbete directamente, tu solicitud no se consumió." },
  305: { nombre: "SIN_CONTENIDO_DECLARATIVO", http: 409, severidad: "warning", mensaje: "La siguiente lección todavía no está disponible. Vuelve pronto." },
  306: { nombre: "PETICION_INVALIDA", http: 400, severidad: "info", mensaje: "La petición no es válida." },
  307: { nombre: "EVIDENCIA_INVALIDA", http: 400, severidad: "info", mensaje: "La imagen enviada no es válida (formato o tamaño)." },
  308: { nombre: "IDIOMA_SIN_GRAFO", http: 500, severidad: "critico", mensaje: "Este idioma aún no tiene su arquitectura cargada." },
  309: { nombre: "GRAFO_INCONSISTENTE", http: 500, severidad: "critico", mensaje: "Hay un problema con la estructura del curso. Ya fue reportado." },
  310: { nombre: "ACCION_NO_ESPERADA", http: 409, severidad: "info", mensaje: "En este momento no se espera una respuesta; pulsa «continuar»." },
  312: { nombre: "CONFIRMACION_REQUERIDA", http: 400, severidad: "info", mensaje: "Para eliminar tu cuenta debes confirmarlo explícitamente." },
  311: { nombre: "PETICION_EN_CURSO", http: 409, severidad: "info", mensaje: "Ya estamos procesando tu petición anterior. Espera un momento." },

  // ---------- 4xx Acceso ----------
  401: { nombre: "NO_AUTENTICADO", http: 401, severidad: "info", mensaje: "Tu sesión no es válida. Vuelve a iniciar sesión." },
  403: { nombre: "SIN_PERMISO", http: 403, severidad: "warning", mensaje: "No tienes acceso a este recurso." },
  429: { nombre: "LIMITE_USUARIO", http: 429, severidad: "warning", mensaje: "Estás enviando mensajes muy rápido. Espera un momento." },
  430: { nombre: "LIMITE_GLOBAL_DIARIO", http: 429, severidad: "critico", mensaje: "El agente alcanzó su límite diario. Vuelve mañana." },

  // ---------- 5xx Infraestructura ----------
  501: { nombre: "REDIS_NO_DISPONIBLE", http: 503, severidad: "warning", mensaje: "Servicio temporalmente degradado." },
  502: { nombre: "STORAGE_FALLIDO", http: 500, severidad: "warning", mensaje: "No pudimos guardar tu imagen, pero tu respuesta sí quedó registrada." },
  503: { nombre: "MODO_NO_IMPLEMENTADO", http: 501, severidad: "info", mensaje: "Este modo todavía no está disponible." },
  504: { nombre: "STORAGE_BORRADO_FALLIDO", http: 500, severidad: "critico", mensaje: "No pudimos eliminar tus archivos. Tu cuenta sigue intacta; intenta de nuevo." },
  598: { nombre: "CONFIGURACION_INVALIDA", http: 500, severidad: "critico", mensaje: "El servicio está mal configurado. Ya fue reportado." },
  599: { nombre: "ERROR_INESPERADO", http: 500, severidad: "critico", mensaje: "Ocurrió un error inesperado. Ya fue reportado." },

  // ---------- 9xx Telemetría ----------
  900: { nombre: "LLM_USO", http: 200, severidad: "info", mensaje: "Uso del proveedor de IA." },
  902: { nombre: "CUENTA_ELIMINADA", http: 200, severidad: "info", mensaje: "Cuenta eliminada a petición del titular." },
  901: { nombre: "DECISION_SECUENCIACION", http: 200, severidad: "info", mensaje: "Decisión de MC-009 registrada." },
} as const satisfies Record<number, DefinicionError>;

export type CodigoError = keyof typeof CATALOGO;

/** Error de la aplicación: siempre lleva un código del catálogo. */
export class ErrorApp extends Error {
  readonly codigo: CodigoError;
  /** Detalle técnico: va al registro, NUNCA al usuario final. */
  readonly detalleTecnico: string;
  readonly contexto: Record<string, unknown>;

  constructor(
    codigo: CodigoError,
    detalleTecnico?: string,
    contexto: Record<string, unknown> = {},
    opciones?: { cause?: unknown },
  ) {
    const def = CATALOGO[codigo];
    super(`[${codigo} ${def.nombre}] ${detalleTecnico ?? def.mensaje}`, opciones);
    this.name = "ErrorApp";
    this.codigo = codigo;
    this.detalleTecnico = detalleTecnico ?? def.mensaje;
    this.contexto = contexto;
  }

  get http(): number {
    return CATALOGO[this.codigo].http;
  }
  get severidad(): Severidad {
    return CATALOGO[this.codigo].severidad;
  }
  get mensajeUsuario(): string {
    return CATALOGO[this.codigo].mensaje;
  }
  get nombreCodigo(): string {
    return CATALOGO[this.codigo].nombre;
  }
}

/** Convierte cualquier excepción en ErrorApp (lo desconocido → 599). */
export function normalizarError(e: unknown): ErrorApp {
  if (e instanceof ErrorApp) return e;
  const detalle = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return new ErrorApp(599, detalle, {}, { cause: e });
}
