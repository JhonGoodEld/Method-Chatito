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

import { CAUSAS } from "./salida_llm.ts";
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
- Todo el contenido sale EXCLUSIVAMENTE del livrable incluido en el contexto. No inventes reglas, excepciones ni ejemplos que contradigan el livrable. Si algo necesario no está en él, dilo en tu mensaje en vez de inventarlo.

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

# Formato de salida (OBLIGATORIO)
Responde SOLO con un objeto JSON válido: sin texto antes ni después y sin bloques de código.
Según la TAREA indicada en el contexto del turno:
- presentar / solicitar:
  {"mensaje_para_alumno": string, "solicitud": null | {"enunciado": string, "niveles": [{"nivel": 1|2|3|null, "total_pedido": entero>0, "unidad_medida": "ejercicios"|"palabras"|"frases"}]}}
- evaluar:
  {"mensaje_para_alumno": string, "transcripcion": string, "niveles": [{"nivel": entero|null, "total_entregado": entero>=0, "items_evaluados": entero>=0, "items_correctos": entero>=0}], "errores": [{"fragmento": string, "correccion": string, "causa": string, "explicacion": string, "fuera_de_scope": boolean, "unidad_relacionada": string|null, "nivel": entero|null}]}
- corregir:
  {"mensaje_para_alumno": string}
- verificar_correccion:
  {"mensaje_para_alumno": string, "transcripcion": string, "indices_corregidos": [entero]}`;
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
        `Presenta, en este orden y basándote solo en el livrable, las étapes: ${etapas}.`,
      ];
      if (tarea.paso.cierra_unidad) {
        partes.push(`Es el CIERRE de la unidad: recapitula el vocabulario. "solicitud" debe ser null.`);
      } else if (tarea.incluirSolicitud && tarea.siguiente) {
        partes.push(
          `Dentro de la étape 14, declara las transformaciones previstas para la étape 18, sin ejecutarlas.`,
          `Antes de pedir producción, declara las formas de evidencia esperadas por nivel (étape 15). Tómalas del livrable; si el livrable no las declara, dilo y usa los ejemplos de MC-001 §15 (nivel 1: respuesta escrita corta; nivel 2: frase completa; nivel 3: producción libre escrita o foto de producción manuscrita).`,
          instruccionSolicitud(mc, tarea.siguiente),
        );
      } else {
        partes.push(`"solicitud" debe ser null.`);
      }
      return partes.join("\n");
    }
    case "solicitar":
      return [
        `TAREA: solicitar`,
        `Declara primero las formas de evidencia esperadas para esta producción (étape 15), tomándolas del livrable.`,
        instruccionSolicitud(mc, tarea.paso),
        tarea.paso.etapas.includes(18)
          ? `Ejecuta, con el alumno, las transformaciones previstas declaradas en la étape 14 del livrable, sobre las frases principales producidas o estudiadas en la lección (ya corregidas en la étape 17).`
          : "",
      ].filter(Boolean).join("\n");

    case "evaluar": {
      const r = tarea.requisitos;
      const niveles = (r.niveles ?? [])
        .map((n) => `  - nivel ${n.nivel ?? "único"}: pedido ${n.total_pedido} ${n.unidad_medida}, mínimo ${n.minimo_requerido}`)
        .join("\n");
      const previas = (r.transcripciones_previas ?? []).length
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
        `Si en algún nivel lo entregado no alcanza el mínimo: pide completar SOLO lo que falta.`,
        tarea.paso.correccion === "diferida"
          ? `La corrección de este paso es DIFERIDA a la étape 17 (MC-001 §17): en tu mensaje NO corrijas ni señales errores; acusa recibo y, si procede, pide lo que falta. Aun así, reporta TODOS los errores en el JSON.`
          : `Si alcanza el mínimo y hay errores dentro del alcance: presenta la corrección con su diagnóstico y pide reescribir SOLO lo señalado. Si no alcanza el mínimo, no corrijas todavía.`,
        `transcripcion: transcribe fielmente lo que produjo el alumno (texto e imágenes).`,
      ].join("\n");
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
        `Termina pidiendo al alumno que reescriba cada fragmento señalado.`,
      ].join("\n");

    case "verificar_correccion":
      return [
        `TAREA: verificar_correccion`,
        `Errores señalados que el alumno debía corregir:`,
        ...tarea.errores.map((e) => `  [${e.indice}] "${e.fragmento}" → esperado: "${e.correccion}" (${e.explicacion})`),
        `Devuelve en indices_corregidos los índices corregidos CORRECTAMENTE.`,
        `Una corrección vale aunque difiera de la forma sugerida, si es gramaticalmente correcta respecto del objetivo de la unidad.`,
        `En el mensaje: confirma lo corregido y explica brevemente lo que siga pendiente.`,
      ].join("\n");
  }
}

function instruccionSolicitud(mc: McOperacional, paso: PasoPlan): string {
  const descripciones = mc.leccion.ciclo_12_etapas.find((e) => paso.etapas.includes(e.n))?.niveles ?? {};
  const niveles = (paso.niveles ?? [null])
    .map((n) => (n === null ? "único (nivel null)" : `${n}${descripciones[String(n)] ? ` = ${descripciones[String(n)]}` : ""}`))
    .join("; ");
  return `Después, solicita la producción del paso "${paso.paso}" (étapes ${describirEtapas(mc.leccion.ciclo_12_etapas, paso.etapas)}), niveles: ${niveles}. ` +
    `En "solicitud" incluye el enunciado COMPLETO y numerado, y un elemento en "niveles" por cada nivel con su total_pedido.`;
}
