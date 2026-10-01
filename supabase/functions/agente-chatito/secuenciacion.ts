// secuenciacion.ts — Motor de secuenciación MC-009 (módulo PURO, sin IA).
//
// Implementa MC-009 v1.0.0:
//   §8   nodo accesible = todos sus prerrequisitos ENSEÑADOS (no consolidados)
//   §9   potencial de expansión = nº de nodos alcanzables por dependencia
//   §10  selección de rama por mayor potencial
//   §11  progresión vertical dentro de la rama activa
//   §13  desvío por prerrequisito indispensable de otra rama
//   §14  pila de ramas interrumpidas (último en entrar, primero en salir)
//   §15  retorno a la rama pausada, sin reevaluar potencial
//   §16  los nodos transversales NO compiten por selección de rama
//   §23  cada decisión es justificable a posteriori (campo `justificacion`)
//
// Reglas operativas v1 (MC-OPERACIONAL.secuenciacion): dominio agotado,
// bloqueo por falta de contenido, política de desempate declarada.
//
// El LLM NUNCA participa en esta decisión (Principio 10).

import { ErrorApp } from "./errores.ts";
import type { CriterioDesempate, DominioGrafo, Grafo, LeccionDeclarada } from "./tipos.ts";

export interface EntradaSecuenciacion {
  grafo: Grafo;
  lecciones: LeccionDeclarada[];
  /** unidad_id de las lecciones enseñadas (estado acquis o consolide). */
  ensenadas: ReadonlySet<string>;
  /** Dominios pausados, de la base al tope. */
  pila: string[];
  /** Dominio de la última lección completada (null si es la primera decisión). */
  ramaActiva: string | null;
  politicaDesempate: CriterioDesempate[];
}

export type RazonBloqueo = "leccion_sin_redactar" | "dominio_sin_lecciones_declaradas" | "sin_rama_accesible";

export type ResultadoSecuenciacion =
  | {
    tipo: "leccion";
    unidadId: string;
    dominioId: string;
    pila: string[];
    justificacion: string[];
    desempateAplicado: boolean;
  }
  | {
    tipo: "bloqueado";
    razon: RazonBloqueo;
    unidadId?: string;
    dominioId?: string;
    pila: string[];
    justificacion: string[];
  }
  | { tipo: "curriculo_completado"; pila: string[]; justificacion: string[] };

type Bloqueo = { bloqueo: RazonBloqueo; unidadId?: string; dominioId?: string };

/** Dominios que dependen (directa o transitivamente) de `dominioId`. */
export function dependientesTransitivos(grafo: Grafo, dominioId: string): Set<string> {
  const inversas = new Map<string, string[]>();
  for (const d of grafo.dominios) {
    for (const p of d.prerequis) inversas.set(p, [...(inversas.get(p) ?? []), d.id]);
  }
  const vistos = new Set<string>();
  const cola = [...(inversas.get(dominioId) ?? [])];
  while (cola.length) {
    const actual = cola.shift()!;
    if (vistos.has(actual)) continue;
    vistos.add(actual);
    cola.push(...(inversas.get(actual) ?? []));
  }
  return vistos;
}

export function potencialExpansion(grafo: Grafo, dominioId: string): number {
  return dependientesTransitivos(grafo, dominioId).size;
}

class MotorSecuenciacion {
  private readonly dominios = new Map<string, DominioGrafo>();
  private readonly indiceDeclaracion = new Map<string, number>();
  private readonly lecciones = new Map<string, LeccionDeclarada>();
  private readonly porDominio = new Map<string, LeccionDeclarada[]>();
  readonly justificacion: string[] = [];
  desempateAplicado = false;

  constructor(private readonly e: EntradaSecuenciacion) {
    e.grafo.dominios.forEach((d, i) => {
      if (this.dominios.has(d.id)) throw new ErrorApp(309, `Dominio duplicado en el grafo: ${d.id}`);
      if (d.nature !== "transversal" && d.nature !== "sequentiel") {
        throw new ErrorApp(309, `Naturaleza inválida en ${d.id}: ${d.nature}`);
      }
      this.dominios.set(d.id, d);
      this.indiceDeclaracion.set(d.id, i);
    });
    for (const d of e.grafo.dominios) {
      for (const p of d.prerequis) {
        if (!this.dominios.has(p)) throw new ErrorApp(309, `${d.id} declara un prerrequisito inexistente: ${p}`);
      }
    }
    this.verificarAciclicoDominios();

    for (const l of e.lecciones) {
      if (this.lecciones.has(l.unidad_id)) throw new ErrorApp(309, `Lección duplicada: ${l.unidad_id}`);
      if (!this.dominios.has(l.dominio_id)) {
        throw new ErrorApp(309, `La lección ${l.unidad_id} apunta a un dominio inexistente: ${l.dominio_id}`);
      }
      this.lecciones.set(l.unidad_id, l);
      this.porDominio.set(l.dominio_id, [...(this.porDominio.get(l.dominio_id) ?? []), l]);
    }
    for (const [dominioId, lista] of this.porDominio) {
      lista.sort((a, b) => this.compararIntraDominio(dominioId, a, b));
    }
  }

  // ---------- Estructura ----------
  private verificarAciclicoDominios(): void {
    const estado = new Map<string, 1 | 2>(); // 1 = visitando, 2 = terminado
    const visitar = (id: string, camino: string[]) => {
      if (estado.get(id) === 2) return;
      if (estado.get(id) === 1) throw new ErrorApp(309, `Ciclo de prerrequisitos: ${[...camino, id].join(" → ")}`);
      estado.set(id, 1);
      for (const p of this.dominios.get(id)!.prerequis) visitar(p, [...camino, id]);
      estado.set(id, 2);
    };
    for (const id of this.dominios.keys()) visitar(id, []);
  }

  /** MC-009 §21: primer sous-domaine declarado, y dentro de él el primer contenido declarado. */
  private compararIntraDominio(dominioId: string, a: LeccionDeclarada, b: LeccionDeclarada): number {
    const sous = this.dominios.get(dominioId)!.sous_domaines ?? [];
    const ia = a.sous_domaine_id ? sous.indexOf(a.sous_domaine_id) : -1;
    const ib = b.sous_domaine_id ? sous.indexOf(b.sous_domaine_id) : -1;
    const pa = ia < 0 ? Number.MAX_SAFE_INTEGER : ia;
    const pb = ib < 0 ? Number.MAX_SAFE_INTEGER : ib;
    if (pa !== pb) return pa - pb;
    if (a.orden_declarado !== b.orden_declarado) return a.orden_declarado - b.orden_declarado;
    // Ambigüedad de datos: se desempata técnicamente y se deja constancia.
    this.justificacion.push(
      `AVISO: ${a.unidad_id} y ${b.unidad_id} comparten sous-domaine y orden_declarado; ` +
        `se usó el identificador como desempate técnico. Declarar orden_declarado distinto.`,
    );
    return a.unidad_id.localeCompare(b.unidad_id);
  }

  // ---------- Consultas ----------
  private esLeccion(id: string): boolean {
    return this.lecciones.has(id);
  }

  private agotado(dominioId: string): boolean {
    const lista = this.porDominio.get(dominioId) ?? [];
    return lista.length > 0 && lista.every((l) => this.e.ensenadas.has(l.unidad_id));
  }

  private satisfecho(prerequisito: string): boolean {
    const dominio = this.dominios.get(prerequisito);
    if (dominio) return dominio.nature === "transversal" || this.agotado(prerequisito);
    if (this.esLeccion(prerequisito)) return this.e.ensenadas.has(prerequisito);
    throw new ErrorApp(309, `Prerrequisito desconocido (ni dominio ni lección declarada): ${prerequisito}`);
  }

  private siguienteDelDominio(dominioId: string): LeccionDeclarada | null {
    return (this.porDominio.get(dominioId) ?? []).find((l) => !this.e.ensenadas.has(l.unidad_id)) ?? null;
  }

  private pendientesDe(l: LeccionDeclarada): string[] {
    const propios = this.dominios.get(l.dominio_id)!.prerequis;
    return [...new Set([...l.prerequis, ...propios])].filter((p) => !this.satisfecho(p));
  }

  private accesible(d: DominioGrafo): boolean {
    return d.prerequis.every((p) => this.satisfecho(p));
  }

  private potencial(dominioId: string): number {
    return potencialExpansion(this.e.grafo, dominioId);
  }

  // ---------- Resolución de una lección objetivo (desvíos §13–§14) ----------
  private resolver(l: LeccionDeclarada, pila: string[], visitados: Set<string>): LeccionDeclarada | Bloqueo {
    if (visitados.has(l.unidad_id)) {
      throw new ErrorApp(309, `Ciclo de prerrequisitos entre lecciones en ${l.unidad_id}`);
    }
    visitados.add(l.unidad_id);

    const pendientes = this.pendientesDe(l);
    if (pendientes.length === 0) {
      if (l.estado_redaccion !== "redactado") {
        this.justificacion.push(`${l.unidad_id} está declarada pero no redactada: bloqueo (no se salta de rama).`);
        return { bloqueo: "leccion_sin_redactar", unidadId: l.unidad_id, dominioId: l.dominio_id };
      }
      return l;
    }

    const falta = pendientes[0];
    let objetivo: LeccionDeclarada | null;
    if (this.esLeccion(falta)) {
      objetivo = this.lecciones.get(falta)!;
    } else {
      objetivo = this.siguienteDelDominio(falta);
      if (!objetivo) {
        this.justificacion.push(`El prerrequisito ${falta} no tiene lecciones declaradas: bloqueo.`);
        return { bloqueo: "dominio_sin_lecciones_declaradas", dominioId: falta };
      }
    }

    if (objetivo.dominio_id !== l.dominio_id && pila[pila.length - 1] !== l.dominio_id) {
      pila.push(l.dominio_id);
      this.justificacion.push(
        `Desvío (MC-009 §13): ${l.unidad_id} requiere ${falta}; se pausa la rama ${l.dominio_id}.`,
      );
    }
    return this.resolver(objetivo, pila, visitados);
  }

  // ---------- Decisión principal ----------
  decidir(): ResultadoSecuenciacion {
    const pila = this.e.pila.filter((id) => {
      const existe = this.dominios.has(id);
      if (!existe) this.justificacion.push(`AVISO: la pila contenía un dominio inexistente (${id}); se descarta.`);
      return existe;
    });

    // 1. Ramas pausadas (MC-009 §15): se reanuda por continuidad.
    while (pila.length) {
      const tope = pila[pila.length - 1];
      const sig = this.siguienteDelDominio(tope);
      if (!sig) {
        pila.pop();
        this.justificacion.push(`La rama pausada ${tope} ya no tiene lecciones pendientes; se desapila.`);
        continue;
      }
      if (this.pendientesDe(sig).length === 0) {
        pila.pop();
        this.justificacion.push(`Prerrequisito satisfecho: se reanuda la rama ${tope} en ${sig.unidad_id} (MC-009 §15).`);
        return this.terminar(this.resolver(sig, pila, new Set()), pila);
      }
      this.justificacion.push(`La rama pausada ${tope} aún espera prerrequisitos; el desvío continúa.`);
      return this.terminar(this.resolver(sig, pila, new Set()), pila);
    }

    // 2. Progresión vertical en la rama activa (MC-009 §11).
    if (this.e.ramaActiva) {
      const d = this.dominios.get(this.e.ramaActiva);
      if (d && d.nature === "sequentiel" && !this.agotado(d.id)) {
        const sig = this.siguienteDelDominio(d.id);
        if (!sig) {
          return this.terminar({ bloqueo: "dominio_sin_lecciones_declaradas", dominioId: d.id }, pila);
        }
        this.justificacion.push(`Progresión vertical en la rama activa ${d.id} (MC-009 §11).`);
        return this.terminar(this.resolver(sig, pila, new Set()), pila);
      }
      if (d) this.justificacion.push(`La rama ${d.id} está agotada; se selecciona una nueva rama.`);
    }

    // 3. Selección de una nueva rama (MC-009 §10) — solo nodos secuenciales (§16).
    const secuenciales = [...this.dominios.values()].filter((d) => d.nature === "sequentiel");
    const sinAgotar = secuenciales.filter((d) => !this.agotado(d.id));
    if (sinAgotar.length === 0) {
      this.justificacion.push("Todos los dominios secuenciales están agotados.");
      return { tipo: "curriculo_completado", pila, justificacion: this.justificacion };
    }
    const accesibles = sinAgotar.filter((d) => this.accesible(d));
    if (accesibles.length === 0) {
      this.justificacion.push(`Ningún dominio pendiente es accesible: ${sinAgotar.map((d) => d.id).join(", ")}.`);
      return this.terminar({ bloqueo: "sin_rama_accesible" }, pila);
    }

    const elegida = this.elegirRama(accesibles);
    const sig = this.siguienteDelDominio(elegida.id);
    if (!sig) {
      this.justificacion.push(`La rama ${elegida.id} no tiene lecciones declaradas.`);
      return this.terminar({ bloqueo: "dominio_sin_lecciones_declaradas", dominioId: elegida.id }, pila);
    }
    return this.terminar(this.resolver(sig, pila, new Set()), pila);
  }

  private elegirRama(accesibles: DominioGrafo[]): DominioGrafo {
    const conPotencial = accesibles.map((d) => ({ d, pot: this.potencial(d.id) }));
    const maximo = Math.max(...conPotencial.map((x) => x.pot));
    let grupo = conPotencial.filter((x) => x.pot === maximo).map((x) => x.d);
    const resumen = conPotencial.map((x) => `${x.d.id}=${x.pot}`).join(", ");

    if (grupo.length === 1) {
      this.justificacion.push(`Rama elegida ${grupo[0].id} por mayor potencial de expansión (${resumen}) (MC-009 §10).`);
      return grupo[0];
    }

    this.desempateAplicado = true;
    this.justificacion.push(`Empate de potencial (${resumen}): se aplica la política de desempate declarada.`);
    for (const criterio of this.e.politicaDesempate) {
      if (grupo.length === 1) break;
      if (criterio === "contenido_disponible") {
        const conContenido = grupo.filter((d) => this.siguienteDelDominio(d.id)?.estado_redaccion === "redactado");
        if (conContenido.length > 0 && conContenido.length < grupo.length) {
          this.justificacion.push(`Criterio «contenido_disponible»: quedan ${conContenido.map((d) => d.id).join(", ")}.`);
          grupo = conContenido;
        }
      } else if (criterio === "orden_declaracion_arquitectura") {
        grupo = [...grupo].sort((a, b) => this.indiceDeclaracion.get(a.id)! - this.indiceDeclaracion.get(b.id)!);
        this.justificacion.push(`Criterio «orden_declaracion_arquitectura»: se elige ${grupo[0].id}.`);
        grupo = [grupo[0]];
      }
    }
    if (grupo.length > 1) {
      grupo.sort((a, b) => this.indiceDeclaracion.get(a.id)! - this.indiceDeclaracion.get(b.id)!);
      this.justificacion.push(`AVISO: la política declarada no resolvió el empate; desempate técnico por orden de declaración.`);
    }
    return grupo[0];
  }

  private terminar(r: LeccionDeclarada | Bloqueo, pila: string[]): ResultadoSecuenciacion {
    if ("bloqueo" in r) {
      // En un bloqueo NO se persisten cambios parciales de la pila.
      return {
        tipo: "bloqueado",
        razon: r.bloqueo,
        unidadId: r.unidadId,
        dominioId: r.dominioId,
        pila: [...this.e.pila],
        justificacion: this.justificacion,
      };
    }
    this.justificacion.push(`Siguiente lección: ${r.unidad_id}.`);
    return {
      tipo: "leccion",
      unidadId: r.unidad_id,
      dominioId: r.dominio_id,
      pila,
      justificacion: this.justificacion,
      desempateAplicado: this.desempateAplicado,
    };
  }
}

export function decidirSiguiente(entrada: EntradaSecuenciacion): ResultadoSecuenciacion {
  return new MotorSecuenciacion(entrada).decidir();
}
