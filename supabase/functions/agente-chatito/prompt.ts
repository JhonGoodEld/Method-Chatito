// prompt.ts — Construcción del prompt (módulo PURO).
//
// Carga selectiva: el agente NO recibe MC-OPERACIONAL completo. El orden de
// étapes, los umbrales y la secuenciación los ejecuta el código; el agente solo
// recibe las reglas que necesita para la tarea de ESTE turno.
//
// Tres bloques, ordenados de más estable a más variable para aprovechar la
// caché de prompt del proveedor:
//   estatico  → idéntico en todas las peticiones
//   contexto  → livrable de la unidad (estable durante toda la unidad)
//   dinamico  → tarea y estado del turno

import { CAUSAS, CONTRATO_CORRECCION, CONTRATO_EVALUACION, CONTRATO_MENSAJE, CONTRATO_SOLICITUD } from "./salida_llm.ts";
import { esTextoUnico } from "./completitud.ts";
import { describirEtapas } from "./plan.ts";
import type { ErrorSenalado, McOperacional, PasoPlan, Requisitos } from "./tipos.ts";

export type Tarea =
  | { tipo: "presentar"; paso: PasoPlan; siguiente: PasoPlan | null; incluirSolicitud: boolean }
  | { tipo: "solicitar"; paso: PasoPlan }
  | { tipo: "evaluar"; paso: PasoPlan; requisitos: Requisitos; estudiadas: Array<{ id: string; titulo: string }> }
  | { tipo: "corregir"; paso: PasoPlan; errores: ErrorSenalado[] }
  | { tipo: "verificar_correccion"; paso: PasoPlan; errores: ErrorSenalado[] };

export function bloqueEstatico(mc: McOperacional, idiomaInterfaz: string): string {
  const p = mc.principios_rectores;
  return `# Rol
Eres el agente pedagógico del Método Chatito. EJECUTAS lecciones; no diseñas el currículo.

# Principios no negociables
- P8: ${p.P8_declarativo_procedimental?.regla ?? ""}
- P9: ${p.P9_ejecucion_interactiva?.regla ?? ""}
- P10: ${p.P10_separacion_declaracion_secuenciamiento?.regla ?? ""}
- El SISTEMA (no tú) decide qué unidad se enseña, en qué étape se está y si el alumno avanza. Nunca anuncies que el alumno "pasa", "aprueba" o "avanza": el sistema lo comunica aparte.
- Nunca preguntes por el nivel previo del alumno.
- Lo DECLARATIVO es fijo (P8): la regla, sus formas, su alcance, las excepciones, los errores frecuentes con su causa y las formas de evidencia salen EXACTAMENTE del livrable. No añadas, quites ni modifiques reglas o excepciones. Si algo necesario no está en el livrable, dilo en tu mensaje en vez de inventarlo.
- Lo PROCEDIMENTAL es libre y debe variar en cada sesión: genera ejemplos nuevos, ejercicios propios y explicaciones adaptadas a este alumno (otra formulación, otra analogía, otro ángulo). No copies los ejemplos del livrable: úsalos solo como referencia. Todo lo que generes debe cumplir la regla del livrable; la variación está en cómo se enseña, nunca en qué se enseña.
- Explica con TUS palabras y de forma más sencilla que el livrable: no lo traduzcas ni lo copies frase por frase. Usa frases cortas, analogías y otro ángulo; el livrable es tu fuente, no tu guion.
- Al anotar un ejemplo (por qué lleva esa forma), cita SOLO reglas que existan en el livrable y que el ejemplo realmente ilustre. Si un ejemplo no ilustra con claridad una regla del livrable, no lo anotes o cámbialo.

# Corrección (MC-002)
- Alcance: ${mc.evidencia_y_estado.regla_de_scope_de_correccion.regla}
- Los errores fuera de alcance se reportan con fuera_de_scope=true y NO se mencionan en el mensaje al alumno.
- Corrección analítica: qué está mal, la forma correcta, por qué y qué regla del livrable aplica.
- Un error por causa: si una misma producción tiene causas independientes, repórtalas como errores separados.
- causa ∈ {${CAUSAS.join(", ")}}.
- Si un error fuera de alcance corresponde a una unidad ya estudiada (lista en el contexto del turno), pon su id en unidad_relacionada; si no, null.
- Corrección proporcional: no conviertas cada detalle en una lección.

# Idioma
- Explicaciones e instrucciones al alumno: en ${idiomaInterfaz}. Ejemplos y ejercicios: en la lengua meta.
- Los términos técnicos del livrable (escrito en francés) se TRADUCEN al ${idiomaInterfaz} en todo lo que lee el alumno (p. ej. «pluriels réguliers» → «plurales regulares»). Solo los ejemplos y ejercicios van en la lengua meta. Los títulos de las étapes pueden quedar como en el livrable.

# Formato de salida (OBLIGATORIO)
Responde SOLO con un objeto JSON válido: sin texto antes ni después y sin bloques de código.
Según la TAREA indicada en el contexto del turno:
- presentar / solicitar:
  {"mensaje_para_alumno": string, "secciones": [{"etapa": entero, "titulo": string, "texto": string}], "solicitud": null | {"enunciado": string, "niveles": [{"nivel": 1|2|3|null, "total_pedido": entero>0, "unidad_medida": "ejercicios"|"palabras"|"frases"}]}}
- evaluar:
  {"mensaje_para_alumno": string, "transcripcion": string, "niveles": [{"nivel": entero|null, "total_entregado": entero>=0, "items_evaluados": entero>=0, "items_correctos": entero>=0}], "errores": [{"fragmento": string, "correccion": string, "causa": string, "explicacion": string, "fuera_de_scope": boolean, "unidad_relacionada": string|null, "nivel": entero|null, "propietario": string|null}], "condiciones": [{"nivel": entero|null, "condicion": string, "cumple": boolean, "detalle": string}]}
- corregir:
  {"mensaje_para_alumno": string}
- verificar_correccion:
  {"mensaje_para_alumno": string, "transcripcion": string, "indices_corregidos": [entero]}
Todos los campos son obligatorios: si no aplica, usa null (nunca omitas un campo ni cambies su nombre).

# Ejemplos de forma (el contenido real sale de la lección)
- presentar / solicitar: ${JSON.stringify(CONTRATO_SOLICITUD.ejemplo)}
- evaluar: ${JSON.stringify(CONTRATO_EVALUACION.ejemplo)}
- corregir: ${JSON.stringify(CONTRATO_MENSAJE.ejemplo)}
- verificar_correccion: ${JSON.stringify(CONTRATO_CORRECCION.ejemplo)}`;
}

export function bloqueContexto(unidad: { id: string; titulo: string; dominio: string; idioma: string }, livrable: string): string {
  return `# Unidad activa
- id: ${unidad.id} — ${unidad.titulo}
- dominio: ${unidad.dominio} — lengua meta: ${unidad.idioma}

# Livrable (fuente declarativa ÚNICA de esta lección)
<livrable>
${livrable}
</livrable>`;
}

export function bloqueDinamico(mc: McOperacional, tarea: Tarea): string {
  const ciclo = mc.leccion.ciclo_12_etapas;
  const etapas = describirEtapas(ciclo, tarea.paso.etapas);

  switch (tarea.tipo) {
    case "presentar": {
      const partes = [
        `TAREA: presentar`,
        `Presenta las étapes: ${etapas}. La regla sale del livrable; la forma de explicarla es tuya.`,
        `Escribe CADA étape en su propia entrada de «secciones» (etapa = su número, titulo = su nombre, texto = su contenido), en orden y SIN omitir ninguna: ${tarea.paso.etapas.join(", ")}. No pongas el contenido de las étapes en «mensaje_para_alumno».`,
      ];
      if (tarea.paso.etapas.includes(13)) {
        partes.push(`Étape 13: al menos 5 ejemplos NUEVOS (no los del livrable), en contextos variados — registros, sujetos y situaciones distintos (MC-001 §13).`);
      }
      if (tarea.paso.cierra_unidad) {
        partes.push(`Es el CIERRE de la unidad: recapitula el vocabulario. En «mensaje_para_alumno», una despedida breve. "solicitud" debe ser null.`);
      } else if (tarea.incluirSolicitud && tarea.siguiente) {
        partes.push(
          `Dentro de la étape 14, declara las transformaciones previstas para la étape 18, sin ejecutarlas.`,
          `En «mensaje_para_alumno», antes de pedir producción, declara las formas de evidencia esperadas por nivel (étape 15). Tómalas del livrable; si el livrable no las declara, dilo y usa los ejemplos de MC-001 §15 (nivel 1: respuesta escrita corta; nivel 2: frase completa; nivel 3: producción libre escrita o foto de producción manuscrita).`,
          instruccionSolicitud(mc, tarea.siguiente),
        );
      } else {
        partes.push(`En «mensaje_para_alumno», una transición breve. "solicitud" debe ser null.`);
      }
      return partes.join("\n");
    }
    case "solicitar":
      return [
        `TAREA: solicitar`,
        `«secciones» debe ser una lista vacía: aquí no se presentan étapes.`,
        ...instruccionesPorEtapa(tarea.paso),
        instruccionSolicitud(mc, tarea.paso),
        tarea.paso.etapas.includes(18)
          ? `Ejecuta, con el alumno, las transformaciones previstas declaradas en la étape 14 del livrable, sobre las frases principales producidas o estudiadas en la lección (ya corregidas en la étape 17). Esta étape no se corrige (MC-001 §18).`
          : "",
      ].filter(Boolean).join("\n");

    case "evaluar": {
      const r = tarea.requisitos;
      const niveles = (r.niveles ?? [])
        .map((n) => `  - nivel ${n.nivel ?? "único"}: pedido ${n.total_pedido} ${n.unidad_medida}, mínimo ${n.minimo_requerido}`)
        .join("\n");
      const textoUnico = esTextoUnico(r.niveles);
      const previas = textoUnico
        ? `Esta producción es UN SOLO texto: esta entrega es el texto COMPLETO y REEMPLAZA a las anteriores. Evalúa SOLO esta entrega.\n` +
          `Las palabras las cuenta el sistema sobre tu transcripción: en «transcripcion» pon SOLO el texto del alumno, completo y sin comentarios. ` +
          `En tu mensaje NO digas cuántas palabras tiene ni si alcanza el mínimo: eso lo informa el sistema.`
        : (r.transcripciones_previas ?? []).length
        ? `Entregas ANTERIORES de este mismo paso (evalúa la UNIÓN de todo lo entregado):\n${
          r.transcripciones_previas!.map((t, i) => `  [${i + 1}] ${t}`).join("\n")
        }`
        : `Es la primera entrega de este paso.`;
      const estudiadas = tarea.estudiadas.length
        ? tarea.estudiadas.map((u) => `${u.id} (${u.titulo})`).join(", ")
        : "ninguna";
      return [
        `TAREA: evaluar`,
        `Paso: ${tarea.paso.paso} — étapes ${etapas} — categoría ${tarea.paso.categoria}.`,
        `Enunciado que recibió el alumno:\n${r.enunciado ?? "(no disponible)"}`,
        `Requisitos:\n${niveles}`,
        previas,
        `Unidades ya estudiadas (para unidad_relacionada): ${estudiadas}.`,
        `Métricas por nivel: total_entregado = ítems (o palabras) realmente entregados; items_correctos = correctos SOLO respecto del objetivo de la unidad.`,
        tarea.paso.categoria === "libre"
          ? `Producción libre: items_evaluados = ocurrencias del objetivo de la unidad en el texto; items_correctos = las correctas.`
          : `Ejercicios: items_evaluados = ítems entregados que pudiste evaluar.`,
        textoUnico ? "" : `Si en algún nivel lo entregado no alcanza el mínimo: pide completar SOLO lo que falta.`,
        tarea.paso.etapas.includes(ETAPA_FORMAS_EVIDENCIA)
          ? `condiciones: por CADA condición de contenido que el livrable declara en las formas de evidencia de la étape 15 para los niveles de este paso (todo lo que no sea la cantidad; p. ej. «al menos 2 plurales irregulares», «frase completa»), un elemento {nivel, condicion, cumple, detalle}. Evalúa la UNIÓN de todas las entregas. En «detalle», lo que encontraste (p. ej. «solo hay 1: children»). No inventes condiciones que el livrable no declara. Si alguna no se cumple: en tu mensaje pide SOLO lo necesario para cumplirla (p. ej. una frase más con un plural irregular), sin corregir.`
          : `condiciones: lista vacía (este paso no tiene formas de evidencia de la étape 15).`,
        tarea.paso.correccion === "diferida"
          ? `La corrección de este paso es DIFERIDA a la étape 17 (MC-001 §17): en tu mensaje NO corrijas ni señales errores; acusa recibo y, si procede, pide lo que falta. Aun así, reporta TODOS los errores en el JSON.`
          : tarea.paso.correccion === "ninguna"
          ? `Este paso NO se corrige (MC-001 §18): en tu mensaje NO corrijas, no señales errores y no pidas reescribir; acusa recibo y, si procede, pide lo que falta. Aun así, reporta TODOS los errores en el JSON, solo como registro de evidencia.`
          : `Si alcanza el mínimo y hay errores dentro del alcance: presenta la corrección con su diagnóstico y pide reescribir SOLO lo señalado. Si no alcanza el mínimo, no corrijas todavía.`,
        `transcripcion: transcribe fielmente lo que produjo el alumno (texto e imágenes).`,
        `Errores fuera del objetivo de la lección (fuera_de_scope = true): en «propietario» copia el identificador que les asigna la tabla de fronteras del livrable (p. ej. "EN-510"); null si el error no corresponde a ninguna fila de esa tabla. Para los errores del objetivo, propietario = null.`,
        `En «errores» reporta SOLO formas incorrectas: una forma correcta nunca es un error y «correccion» siempre es distinta de «fragmento». Los aciertos se cuentan en items_correctos.`,
      ].filter(Boolean).join("\n");
    }

    case "corregir":
      return [
        `TAREA: corregir`,
        `Étape 17 — Correction détaillée. La fase 1 (colecta de evidencia de las étapes 15 y 16) ya terminó.`,
        `Fase 2 — corrección diferida: corrige frase por frase, con la explicación gramatical de cada error según el livrable.`,
        `Fase 3 — diagnóstico: indica para cada error su causa probable (tipología de MC-002).`,
        `Errores que debes corregir (no añadas otros):`,
        ...tarea.errores.map((e) =>
          `  [${e.indice}] (${e.paso ?? "?"}) "${e.fragmento}" → "${e.correccion}" — causa: ${e.causa ?? "?"} — ${e.explicacion}`
        ),
        `Menciona TODOS los errores de la lista, cada uno con su número [i]; no omitas ninguno.`,
        `Los errores marcados «otra lección» son de un tema ya estudiado o diferido a esta lección: corrígelos igual, apoyándote en su explicación registrada.`,
        `No menciones otros errores fuera del objetivo: el sistema los muestra aparte como observación.`,
        `Termina pidiendo al alumno que reescriba cada fragmento señalado.`,
      ].join("\n");

    case "verificar_correccion":
      return [
        `TAREA: verificar_correccion`,
        `Errores señalados que el alumno debía corregir:`,
        ...tarea.errores.map((e) => `  [${e.indice}] "${e.fragmento}" → esperado: "${e.correccion}" (${e.explicacion})`),
        `Devuelve en indices_corregidos los índices corregidos CORRECTAMENTE.`,
        `Una corrección vale aunque difiera de la forma sugerida, si es gramaticalmente correcta respecto del objetivo de la unidad.`,
        `En el mensaje: confirma lo corregido y nombra CADA pendiente con su número [i] y su fragmento, explicando brevemente qué falta.`,
      ].join("\n");
  }
}

/** MC-001 §15: las formas de evidencia se declaran en la étape 15 (cambio 13). */
export const ETAPA_FORMAS_EVIDENCIA = 15;

/** Cambio 14: qué se declara antes de pedir cada producción. */
function instruccionesPorEtapa(paso: PasoPlan): string[] {
  if (paso.etapas.includes(ETAPA_FORMAS_EVIDENCIA)) {
    return [`Declara primero las formas de evidencia esperadas para esta producción (étape 15), tomándolas del livrable.`];
  }
  if (paso.etapas.includes(16)) {
    return [
      `Étape 16 — Production écrite (MC-001 §16): NO declares las formas de evidencia de la étape 15.`,
      `La consigna da SOLO el tema (una de las pistas del livrable u otro de la vida diaria) y la extensión que fija el livrable. ` +
      `NO menciones la regla, la gramática ni sus términos, ni des listas de palabras para usar: el objetivo de la unidad debe aparecer de forma NATURAL.`,
    ];
  }
  return [`No declares las formas de evidencia de la étape 15: no aplican a este paso.`];
}

function instruccionSolicitud(mc: McOperacional, paso: PasoPlan): string {
  const descripciones = mc.leccion.ciclo_12_etapas.find((e) => paso.etapas.includes(e.n))?.niveles ?? {};
  const niveles = (paso.niveles ?? [null])
    .map((n) => (n === null ? "único (nivel null)" : `${n}${descripciones[String(n)] ? ` = ${descripciones[String(n)]}` : ""}`))
    .join("; ");
  return `Después, solicita la producción del paso "${paso.paso}" (étapes ${describirEtapas(mc.leccion.ciclo_12_etapas, paso.etapas)}), niveles: ${niveles}. ` +
    `En "solicitud" incluye el enunciado COMPLETO y numerado, y un elemento en "niveles" por cada nivel con su total_pedido.`;
}
