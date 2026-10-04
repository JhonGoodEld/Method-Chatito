import { assertEquals, assertRejects } from "./afirmar.ts";
import { eliminarCuenta, FRASE_CONFIRMACION, type ServiciosCuenta } from "../cuenta.ts";
import { ErrorApp } from "../errores.ts";
import { validarCuerpo } from "../peticion.ts";

const U = "usuario-1";

/** Storage falso: un árbol de carpetas como el real (<usuario>/<alumno_idioma>/<unidad>/<archivo>). */
class CuentaFalsa implements ServiciosCuenta {
  archivos: Set<string>;
  eventos: string[] = [];
  fallarBorrado = false;
  fallarUsuario = false;
  usuarioEliminado = false;

  constructor(rutas: string[]) {
    this.archivos = new Set(rutas);
  }
  listar(carpeta: string) {
    const prefijo = `${carpeta}/`;
    const nombres = new Map<string, boolean>();
    for (const r of this.archivos) {
      if (!r.startsWith(prefijo)) continue;
      const [primero, ...resto] = r.slice(prefijo.length).split("/");
      nombres.set(primero, resto.length > 0);
    }
    return Promise.resolve([...nombres].map(([nombre, esCarpeta]) => ({ nombre, esCarpeta })));
  }
  borrarArchivos(rutas: string[]) {
    if (this.fallarBorrado) return Promise.reject(new Error("storage caído"));
    this.eventos.push(`borrar:${rutas.length}`);
    rutas.forEach((r) => this.archivos.delete(r));
    return Promise.resolve();
  }
  eliminarUsuario(id: string) {
    if (this.fallarUsuario) return Promise.reject(new Error("auth caído"));
    this.eventos.push(`usuario:${id}`);
    this.usuarioEliminado = true;
    return Promise.resolve();
  }
}

Deno.test("cuenta: sin la confirmación exacta no se borra nada (312)", async () => {
  const c = new CuentaFalsa([`${U}/a/EN-411/r_0.jpg`]);
  for (const conf of [undefined, "", "eliminar", "SI"]) {
    assertEquals((await assertRejects(() => eliminarCuenta(c, U, conf), ErrorApp)).codigo, 312);
  }
  assertEquals([c.archivos.size, c.usuarioEliminado], [1, false]);
});

Deno.test("cuenta: borra todas las fotos (recursivo) y DESPUÉS el usuario; no toca las de otros", async () => {
  const c = new CuentaFalsa([
    `${U}/ai-en/EN-411/r1_0.jpg`,
    `${U}/ai-en/EN-411/r2_0.png`,
    `${U}/ai-en/EN-412/r3_0.jpg`,
    `${U}/ai-fr/FR-411/r4_0.webp`,
    `otro-usuario/ai/EN-411/x_0.jpg`,
  ]);
  const r = await eliminarCuenta(c, U, FRASE_CONFIRMACION);
  assertEquals(r.archivos_eliminados, 4);
  assertEquals([...c.archivos], ["otro-usuario/ai/EN-411/x_0.jpg"]);
  assertEquals(c.eventos, ["borrar:4", `usuario:${U}`]);
});

Deno.test("cuenta: más de 100 fotos se borran en lotes de 100", async () => {
  const c = new CuentaFalsa(Array.from({ length: 250 }, (_, i) => `${U}/ai/EN-411/r${i}.jpg`));
  await eliminarCuenta(c, U, FRASE_CONFIRMACION);
  assertEquals(c.eventos, ["borrar:100", "borrar:100", "borrar:50", `usuario:${U}`]);
});

Deno.test("cuenta: un usuario sin fotos se elimina igual", async () => {
  const c = new CuentaFalsa([]);
  assertEquals((await eliminarCuenta(c, U, FRASE_CONFIRMACION)).archivos_eliminados, 0);
  assertEquals(c.usuarioEliminado, true);
});

Deno.test("cuenta: si Storage falla, el usuario NO se borra (504) y puede reintentar", async () => {
  const c = new CuentaFalsa([`${U}/ai/EN-411/r.jpg`]);
  c.fallarBorrado = true;
  assertEquals((await assertRejects(() => eliminarCuenta(c, U, FRASE_CONFIRMACION), ErrorApp)).codigo, 504);
  assertEquals(c.usuarioEliminado, false);
  c.fallarBorrado = false;
  assertEquals((await eliminarCuenta(c, U, FRASE_CONFIRMACION)).archivos_eliminados, 1);
  assertEquals(c.usuarioEliminado, true);
});

Deno.test("cuenta: si Auth falla tras borrar fotos → 107; el reintento completa el borrado", async () => {
  const c = new CuentaFalsa([`${U}/ai/EN-411/r.jpg`]);
  c.fallarUsuario = true;
  const e = await assertRejects(() => eliminarCuenta(c, U, FRASE_CONFIRMACION), ErrorApp);
  assertEquals([e.codigo, e.contexto.archivos_ya_eliminados], [107, 1]);
  c.fallarUsuario = false;
  await eliminarCuenta(c, U, FRASE_CONFIRMACION);
  assertEquals(c.usuarioEliminado, true);
});

Deno.test("contrato: eliminar_cuenta se acepta como acción válida", () => {
  const cuerpo = validarCuerpo('{"accion":"eliminar_cuenta","confirmacion":"ELIMINAR"}');
  assertEquals(cuerpo.accion, "eliminar_cuenta");
});
