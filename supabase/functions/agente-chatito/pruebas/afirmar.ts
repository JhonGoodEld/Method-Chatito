// afirmar.ts — Aserciones sin dependencias externas (usa node:assert, incluido en Deno).
import nodeAssert from "node:assert/strict";

export function assert(condicion: unknown, mensaje?: string): asserts condicion {
  nodeAssert.ok(condicion, mensaje);
}
export function assertEquals<T>(real: T, esperado: T, mensaje?: string): void {
  nodeAssert.deepStrictEqual(real, esperado, mensaje);
}
export function assertAlmostEquals(real: number, esperado: number, tolerancia = 1e-7, mensaje?: string): void {
  if (!(Math.abs(real - esperado) <= tolerancia)) throw new Error(mensaje ?? `${real} ≉ ${esperado} (±${tolerancia})`);
}
// deno-lint-ignore no-explicit-any
type Clase<E> = new (...args: any[]) => E;
function comprobar<E extends Error>(e: unknown, clase?: Clase<E>, incluye?: string): E {
  if (clase && !(e instanceof clase)) throw new Error(`Se esperaba ${clase.name}, se obtuvo: ${e}`);
  if (incluye && !String((e as Error).message).includes(incluye)) throw new Error(`El mensaje no incluye "${incluye}": ${e}`);
  return e as E;
}
export function assertThrows<E extends Error = Error>(fn: () => unknown, clase?: Clase<E>, incluye?: string): E {
  try {
    fn();
  } catch (e) {
    return comprobar(e, clase, incluye);
  }
  throw new Error("Se esperaba una excepción");
}
export async function assertRejects<E extends Error = Error>(fn: () => Promise<unknown>, clase?: Clase<E>, incluye?: string): Promise<E> {
  try {
    await fn();
  } catch (e) {
    return comprobar(e, clase, incluye);
  }
  throw new Error("Se esperaba un rechazo");
}
