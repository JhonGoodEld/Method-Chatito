// herramientas/empaquetar.ts — Genera UN solo archivo TypeScript para pegar en
// el editor del dashboard de Supabase, a partir del código modular.
//
// Uso (desde la carpeta agente-chatito):
//   deno run --allow-read --allow-write herramientas/empaquetar.ts [salida.ts]
//
// Qué hace:
//   1. Recorre los imports locales desde index.ts (orden topológico: cada módulo
//      aparece después de los que usa).
//   2. Quita los imports locales; los JSON se insertan como constantes.
//   3. Fusiona y sube arriba los imports npm:.
//   4. Se niega a empaquetar si dos módulos declaran el mismo nombre.
// El resultado sigue siendo TypeScript: pásalo por `deno check` antes de pegarlo.
//
// Regla de oro: NUNCA edites el archivo empaquetado a mano. Edita los módulos
// y vuelve a empaquetar; así no existen dos versiones que puedan divergir.

const RAIZ = new URL("../", import.meta.url);
const SALIDA = Deno.args[0] ?? "agente-chatito-DASHBOARD.ts";
const IMPORT = /^import\s+([\s\S]*?)\s+from\s+"([^"]+)"(\s+with\s+\{[^}]*\})?;[ \t]*\n?/gm;

interface Modulo {
  ruta: string;
  cuerpo: string;
  dependencias: string[];
}

const modulos = new Map<string, Modulo>();
const npm = new Map<string, Map<string, boolean>>(); // especificador → nombre → ¿solo tipo?

function registrarNpm(especificador: string, clausula: string) {
  const nombres = npm.get(especificador) ?? new Map<string, boolean>();
  const dentro = clausula.match(/\{([\s\S]*)\}/);
  if (!dentro) throw new Error(`Import npm no soportado (solo imports con llaves): ${clausula} from ${especificador}`);
  const soloTipoGlobal = /^type\s/.test(clausula.trim());
  for (const crudo of dentro[1].split(",").map((s) => s.trim()).filter(Boolean)) {
    const soloTipo = soloTipoGlobal || crudo.startsWith("type ");
    const nombre = crudo.replace(/^type\s+/, "");
    nombres.set(nombre, (nombres.get(nombre) ?? true) && soloTipo);
  }
  npm.set(especificador, nombres);
}

function cargar(ruta: string) {
  if (modulos.has(ruta)) return;
  const texto = Deno.readTextFileSync(new URL(ruta, RAIZ));
  const dependencias: string[] = [];
  const cuerpo = texto.replace(IMPORT, (_todo, clausula: string, especificador: string) => {
    if (especificador.startsWith("npm:")) {
      registrarNpm(especificador, clausula);
      return "";
    }
    if (!especificador.startsWith("./")) throw new Error(`Import no soportado en ${ruta}: ${especificador}`);
    const destino = especificador.slice(2);
    if (destino.endsWith(".json")) {
      const nombre = clausula.trim();
      const json = Deno.readTextFileSync(new URL(destino, RAIZ));
      return `const ${nombre} = ${JSON.stringify(JSON.parse(json))};\n`;
    }
    dependencias.push(destino);
    return "";
  });
  modulos.set(ruta, { ruta, cuerpo, dependencias });
  dependencias.forEach(cargar);
}

cargar("index.ts");

// Orden topológico (postorden): dependencias primero.
const orden: string[] = [];
const visitados = new Set<string>();
const visitar = (ruta: string, camino: string[]) => {
  if (camino.includes(ruta)) throw new Error(`Import circular: ${[...camino, ruta].join(" → ")}`);
  if (visitados.has(ruta)) return;
  for (const d of modulos.get(ruta)!.dependencias) visitar(d, [...camino, ruta]);
  visitados.add(ruta);
  orden.push(ruta);
};
visitar("index.ts", []);

// Choques de nombres de primer nivel.
const declarados = new Map<string, string>();
for (const ruta of orden) {
  for (const m of modulos.get(ruta)!.cuerpo.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+(\w+)/gm)) {
    const previo = declarados.get(m[1]);
    if (previo) throw new Error(`Nombre repetido «${m[1]}» en ${previo} y ${ruta}: renómbralo en el código modular.`);
    declarados.set(m[1], ruta);
  }
}

const importsNpm = [...npm].map(([especificador, nombres]) => {
  const lista = [...nombres].map(([n, soloTipo]) => (soloTipo ? `type ${n}` : n)).join(", ");
  return `import { ${lista} } from "${especificador}";`;
});

const salida = [
  "// =====================================================================",
  "// agente-chatito — ARCHIVO GENERADO AUTOMÁTICAMENTE. NO EDITAR A MANO.",
  "// Fuente: módulos de la carpeta agente-chatito/ → herramientas/empaquetar.ts",
  `// Módulos (${orden.length}): ${orden.join(", ")}`,
  "// =====================================================================",
  ...importsNpm,
  "",
  ...orden.map((ruta) => `// ───────────── ${ruta} ─────────────\n${modulos.get(ruta)!.cuerpo.trim()}\n`),
].join("\n");

Deno.writeTextFileSync(SALIDA, salida);
console.log(`OK: ${SALIDA} — ${orden.length} módulos, ${salida.split("\n").length} líneas, ${importsNpm.length} imports npm`);
