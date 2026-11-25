import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

/**
 * Catálogo de "kinds" (tipos de equipo). Vive en config/images.yaml, fuera del
 * código y fuera de git. Aquí solo se valida su forma.
 */
const CommandSpec = z.object({
  // Plantilla de comando. Placeholders: {container} {node} {lab} {cmd}
  command: z.array(z.string()).min(1),
  // Variables de entorno para el proceso hijo. "$VAR" toma el valor del entorno del backend.
  env: z.record(z.string()).default({}),
});

const KindSpec = z.object({
  label: z.string(),
  os: z.enum(["junos", "ios", "frr", "linux"]).default("junos"),
  clabKind: z.string(),
  image: z.string(),
  resources: z.object({ ramMB: z.number(), vcpu: z.number() }),
  interfaces: z.object({
    count: z.number().int().positive(),
    // Nombre que ve el usuario / Junos. {n} = índice desde 0. Admite {n+K}.
    junosPattern: z.string().optional(),
    // Alternativa al patrón: lista explícita (p. ej. IOL: Ethernet0/1, 0/2, 0/3, 1/0...)
    names: z.array(z.string()).optional(),
    // Nombre del endpoint en el fichero de containerlab.
    clabPattern: z.string(),
  }),
  startupConfig: z
    .object({
      // Extensión del fichero generado: "cfg" (curly) | "set" | "partial.cfg"...
      fileSuffix: z.string().default("cfg"),
    })
    .optional(),
  console: CommandSpec,
  exec: CommandSpec,
  // ¿El backend puede tirar/levantar enlaces con `ip link` dentro del contenedor?
  linkControl: z.boolean().default(true),
  bootTimeSec: z.number().default(60),
  // Campos extra que se copian tal cual al nodo containerlab (binds, env, cpu, memory...).
  // Placeholders: {configDir} {node} {lab}
  clabExtra: z.record(z.any()).optional(),
  icon: z.enum(["router", "switch", "server", "cloud"]).default("router"),
});

export type KindSpec = z.infer<typeof KindSpec>;
export type CommandSpec = z.infer<typeof CommandSpec>;

const Catalog = z.object({ kinds: z.record(KindSpec) });

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const resolveRoot = (p: string) => (path.isAbsolute(p) ? p : path.resolve(ROOT, p));

export const env = {
  port: Number(process.env.PORT ?? 8080),
  driver: (process.env.DRIVER ?? "mock") as "mock" | "containerlab",
  imagesConfig: resolveRoot(process.env.IMAGES_CONFIG ?? "./config/images.yaml"),
  dataDir: resolveRoot(process.env.DATA_DIR ?? "./data"),
  labsDir: resolveRoot(process.env.LABS_DIR ?? "./labs"),
  clabBin: process.env.CLAB_BIN ?? "containerlab",
  clabSudo: (process.env.CLAB_SUDO ?? "true") === "true",
  ramBudgetMB: Number(process.env.HOST_RAM_BUDGET_MB ?? 28000),
  vcpuBudget: Number(process.env.HOST_VCPU_BUDGET ?? 16),
  frontendDist: resolveRoot("./frontend/dist"),
};

export function loadCatalog(): Record<string, KindSpec> {
  let file = env.imagesConfig;
  if (!existsSync(file)) {
    const example = resolveRoot("./config/images.example.yaml");
    console.warn(`[config] ${file} no existe; usando ${example} (cópialo y pon tus imágenes)`);
    file = example;
  }
  const parsed = Catalog.parse(YAML.parse(readFileSync(file, "utf8")));
  return parsed.kinds;
}

/** "ge-0/0/{n}" + 2 → "ge-0/0/2";  "eth{n+1}" + 2 → "eth3" */
export function renderIface(pattern: string, n: number): string {
  return pattern.replace(/\{n(?:\+(\d+))?\}/g, (_m, k) => String(n + (k ? Number(k) : 0)));
}

export function ifaceList(kind: KindSpec): string[] {
  const { names, junosPattern, count } = kind.interfaces;
  if (names?.length) return names.slice(0, count);
  return Array.from({ length: count }, (_, n) => renderIface(junosPattern ?? "eth{n+1}", n));
}

/** Traduce el nombre Junos (ge-0/0/2) al endpoint de containerlab (eth3). */
export function toClabIface(kind: KindSpec, junosIface: string): string {
  const idx = ifaceList(kind).indexOf(junosIface);
  if (idx < 0) throw new Error(`Interfaz ${junosIface} no existe en kind ${kind.label}`);
  return renderIface(kind.interfaces.clabPattern, idx);
}

/** Sustituye placeholders y resuelve "$VAR" en env sin exponer secretos en el código. */
export function renderCommand(spec: CommandSpec, vars: Record<string, string>) {
  // 1º ${VAR} desde el entorno del backend (.env), 2º {placeholders} del nodo
  const argv = spec.command.map((a) =>
    a.replace(/\$\{(\w+)\}/g, (_m, k) => process.env[k] ?? "").replace(/\{(\w+)\}/g, (_m, k) => vars[k] ?? `{${k}}`));
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.env)) {
    childEnv[k] = v.startsWith("$") ? (process.env[v.slice(1)] ?? "") : v;
  }
  return { file: argv[0], args: argv.slice(1), env: { ...process.env, ...childEnv } as Record<string, string> };
}
