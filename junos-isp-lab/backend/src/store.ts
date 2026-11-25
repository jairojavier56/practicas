import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { env } from "./config.js";
import type { Topology } from "./types.js";

export const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;

const EndpointZ = z.object({ node: z.string().regex(SAFE_NAME), iface: z.string().regex(/^[\w\-/.:]+$/) });
export const TopologyZ = z.object({
  name: z.string().regex(SAFE_NAME, "nombre: minúsculas, números y guiones"),
  description: z.string().optional(),
  nodes: z.array(z.object({
    id: z.string().regex(SAFE_NAME, "id de nodo: minúsculas, números y guiones"),
    kind: z.string(),
    label: z.string().optional(),
    asn: z.number().int().optional(),
    group: z.string().optional(),
    position: z.object({ x: z.number(), y: z.number() }),
  })),
  links: z.array(z.object({ id: z.string(), a: EndpointZ, b: EndpointZ })),
  checks: z.array(z.any()).optional(),
  guide: z.array(z.string()).optional(),
  lesson: z.any().optional(),
});

const topoDir = () => path.join(env.dataDir, "topologies");
const cfgDir = (lab: string) => path.join(env.dataDir, lab, "configs");

export function listTopologies(): string[] {
  mkdirSync(topoDir(), { recursive: true });
  return readdirSync(topoDir()).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
}

export function loadTopology(name: string): Topology {
  if (!SAFE_NAME.test(name)) throw new Error("nombre inválido");
  return TopologyZ.parse(JSON.parse(readFileSync(path.join(topoDir(), `${name}.json`), "utf8"))) as Topology;
}

export function saveTopology(t: unknown): Topology {
  const topo = TopologyZ.parse(t) as Topology;
  const ids = new Set(topo.nodes.map((n) => n.id));
  if (ids.size !== topo.nodes.length) throw new Error("ids de nodo duplicados");
  const used = new Set<string>();
  for (const l of topo.links) {
    for (const e of [l.a, l.b]) {
      if (!ids.has(e.node)) throw new Error(`enlace ${l.id}: nodo ${e.node} no existe`);
      const k = `${e.node}:${e.iface}`;
      if (used.has(k)) throw new Error(`interfaz ${k} usada en dos enlaces`);
      used.add(k);
    }
  }
  mkdirSync(topoDir(), { recursive: true });
  writeFileSync(path.join(topoDir(), `${topo.name}.json`), JSON.stringify(topo, null, 2));
  return topo;
}

// ---- configs por nodo: <node>.set (Junos), <node>.ios (Cisco), <node>.frr.conf (FRR) ----
export const CONFIG_EXT: Record<string, string> = { junos: "set", ios: "ios", frr: "frr.conf", linux: "sh" };

export function readNodeConfig(lab: string, node: string, os = "junos"): string | null {
  const f = path.join(cfgDir(lab), `${node}.${CONFIG_EXT[os] ?? "set"}`);
  return existsSync(f) ? readFileSync(f, "utf8") : null;
}

export function writeNodeConfig(lab: string, node: string, text: string, os = "junos") {
  if (!SAFE_NAME.test(lab) || !SAFE_NAME.test(node)) throw new Error("nombre inválido");
  mkdirSync(cfgDir(lab), { recursive: true });
  writeFileSync(path.join(cfgDir(lab), `${node}.${CONFIG_EXT[os] ?? "set"}`), text);
}

// ---- plantillas de laboratorios guiados (labs/<dir>/lab.json + configs/*.set) ----
export function listTemplates() {
  if (!existsSync(env.labsDir)) return [];
  return readdirSync(env.labsDir)
    .filter((d) => existsSync(path.join(env.labsDir, d, "lab.json")))
    .map((d) => {
      const t = JSON.parse(readFileSync(path.join(env.labsDir, d, "lab.json"), "utf8"));
      return { id: d, name: t.name as string, description: t.description as string | undefined };
    });
}

/** Instancia una plantilla: copia topología y configs a data/. */
export function instantiateTemplate(id: string): Topology {
  if (!/^[\w-]+$/.test(id)) throw new Error("plantilla inválida");
  const dir = path.join(env.labsDir, id);
  const topo = saveTopology(JSON.parse(readFileSync(path.join(dir, "lab.json"), "utf8")));
  const src = path.join(dir, "configs");
  if (existsSync(src)) {
    mkdirSync(cfgDir(topo.name), { recursive: true });
    for (const f of readdirSync(src)) copyFileSync(path.join(src, f), path.join(cfgDir(topo.name), f));
  }
  return topo;
}
