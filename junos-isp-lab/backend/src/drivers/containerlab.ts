import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import * as pty from "node-pty";
import type { ConsoleSession, NetworkDriver } from "./driver.js";
import type { LinkState, Topology } from "../types.js";
import { env, renderCommand, toClabIface, type KindSpec } from "../config.js";

const execFileP = promisify(execFile);

const FRR_DAEMONS = `bgpd=yes
ospfd=yes
ospf6d=no
ripd=no
ripngd=no
isisd=yes
pimd=no
ldpd=yes
nhrpd=no
eigrpd=no
babeld=no
sharpd=no
pbrd=no
bfdd=yes
fabricd=no
vrrpd=no
vtysh_enable=yes
zebra_options="  -A 127.0.0.1 -s 90000000"
bgpd_options="   -A 127.0.0.1"
ospfd_options="  -A 127.0.0.1"
isisd_options="  -A 127.0.0.1"
ldpd_options="   -A 127.0.0.1"
bfdd_options="   -A 127.0.0.1"
`;

export const containerName = (lab: string, node: string) => `clab-${lab}-${node}`;
export const labDir = (lab: string) => path.join(env.dataDir, lab);
export const configDir = (lab: string) => path.join(labDir(lab), "configs");

/** Sustituye {configDir} {node} {lab} en strings anidados (para clabExtra). */
function renderDeep(v: unknown, vars: Record<string, string>): unknown {
  if (typeof v === "string") return v.replace(/\{(\w+)\}/g, (_m, k) => vars[k] ?? `{${k}}`);
  if (Array.isArray(v)) return v.map((x) => renderDeep(x, vars));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderDeep(x, vars)]));
  return v;
}

/** Canvas (Topology) → fichero YAML de containerlab. */
export function toClabYaml(topo: Topology, catalog: Record<string, KindSpec>): string {
  const nodes: Record<string, unknown> = {};
  for (const n of topo.nodes) {
    const k = catalog[n.kind];
    if (!k) throw new Error(`Kind desconocido: ${n.kind} (añádelo a images.yaml)`);
    const vars = { configDir: configDir(topo.name), node: n.id, lab: topo.name };
    const def: Record<string, unknown> = { kind: k.clabKind, image: k.image };
    if (k.startupConfig) {
      const f = path.join(configDir(topo.name), `${n.id}.${k.startupConfig.fileSuffix}`);
      if (existsSync(f)) def["startup-config"] = f;
    }
    Object.assign(def, renderDeep(k.clabExtra ?? {}, vars));
    nodes[n.id] = def;
  }
  const kindOf = (id: string) => {
    const node = topo.nodes.find((x) => x.id === id);
    if (!node) throw new Error(`Enlace hacia nodo inexistente: ${id}`);
    return catalog[node.kind];
  };
  const links = topo.links.map((l) => ({
    endpoints: [
      `${l.a.node}:${toClabIface(kindOf(l.a.node), l.a.iface)}`,
      `${l.b.node}:${toClabIface(kindOf(l.b.node), l.b.iface)}`,
    ],
  }));
  return YAML.stringify({ name: topo.name, topology: { nodes, links } });
}

function run(cmd: string, args: string[], log: (l: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: process.env });
    const pipe = (b: Buffer) => b.toString().split(/\r?\n/).filter(Boolean).forEach(log);
    p.stdout.on("data", pipe);
    p.stderr.on("data", pipe);
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} salió con código ${code}`))));
  });
}

export class ContainerlabDriver implements NetworkDriver {
  readonly name = "containerlab";
  constructor(private catalog: Record<string, KindSpec>) {}

  private clab(args: string[]) {
    return env.clabSudo ? { cmd: "sudo", args: ["-n", env.clabBin, ...args] } : { cmd: env.clabBin, args };
  }

  private topoFile(topo: Topology) {
    return path.join(labDir(topo.name), `${topo.name}.clab.yml`);
  }

  private kind(topo: Topology, nodeId: string) {
    const n = topo.nodes.find((x) => x.id === nodeId);
    if (!n) throw new Error(`Nodo ${nodeId} no existe`);
    return { node: n, kind: this.catalog[n.kind] };
  }

  async deploy(topo: Topology, log: (l: string) => void) {
    mkdirSync(configDir(topo.name), { recursive: true });
    // FRR monta su frr.conf y daemons desde configs/: si el nodo es nuevo, creamos unos por defecto
    for (const n of topo.nodes) {
      if (this.catalog[n.kind]?.os !== "frr") continue;
      const conf = path.join(configDir(topo.name), `${n.id}.frr.conf`);
      if (!existsSync(conf)) writeFileSync(conf, `frr defaults traditional\nhostname ${n.id}\nservice integrated-vtysh-config\n!\n`);
      const daemons = path.join(configDir(topo.name), "daemons");
      if (!existsSync(daemons)) writeFileSync(daemons, FRR_DAEMONS);
    }
    const file = this.topoFile(topo);
    writeFileSync(file, toClabYaml(topo, this.catalog));
    log(`Topología containerlab generada en ${file}`);
    const { cmd, args } = this.clab(["deploy", "-t", file, "--reconfigure"]);
    await run(cmd, args, log);
    const slowest = Math.max(...topo.nodes.map((n) => this.catalog[n.kind].bootTimeSec));
    log(`Contenedores arriba. Los nodos VM (vJunos/vMX) pueden tardar ~${slowest}s más en arrancar Junos.`);
  }

  async destroy(topo: Topology, log: (l: string) => void) {
    const { cmd, args } = this.clab(["destroy", "-t", this.topoFile(topo), "--cleanup"]);
    await run(cmd, args, log);
  }

  openConsole(topo: Topology, nodeId: string, cols: number, rows: number): ConsoleSession {
    const { kind } = this.kind(topo, nodeId);
    const c = renderCommand(kind.console, { container: containerName(topo.name, nodeId), node: nodeId, lab: topo.name });
    const p = pty.spawn(c.file, c.args, { name: "xterm-256color", cols, rows, env: c.env });
    return {
      write: (d) => p.write(d),
      resize: (cc, rr) => p.resize(cc, rr),
      onData: (cb) => void p.onData(cb),
      onExit: (cb) => void p.onExit((e) => cb(e.exitCode)),
      close: () => p.kill(),
    };
  }

  async exec(topo: Topology, nodeId: string, cmd: string) {
    const { kind } = this.kind(topo, nodeId);
    const c = renderCommand(kind.exec, { container: containerName(topo.name, nodeId), node: nodeId, lab: topo.name, cmd });
    const { stdout } = await execFileP(c.file, c.args, { env: c.env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }

  /** Estado de enlaces leyendo operstate de las veth dentro de cada contenedor. */
  async linkStates(topo: Topology): Promise<LinkState[]> {
    const perNode = new Map<string, Map<string, string>>();
    await Promise.all(
      topo.nodes.map(async (n) => {
        try {
          const { stdout } = await execFileP(
            "docker",
            ["exec", containerName(topo.name, n.id), "sh", "-c",
              'for i in /sys/class/net/*; do echo "$(basename $i) $(cat $i/operstate)"; done'],
            { timeout: 5000 },
          );
          perNode.set(n.id, new Map(stdout.trim().split("\n").map((l) => l.split(" ") as [string, string])));
        } catch {
          /* nodo aún arrancando o sin shell */
        }
      }),
    );
    return topo.links.map((l) => {
      const st = (e: typeof l.a) => perNode.get(e.node)?.get(toClabIface(this.kind(topo, e.node).kind, e.iface));
      const a = st(l.a), b = st(l.b);
      if (!a || !b) return { id: l.id, state: "unknown" as const };
      return { id: l.id, state: a === "up" && b === "up" ? "up" : "down" };
    });
  }

  /** Simula corte de fibra: baja/sube la veth en el extremo A. */
  async setLink(topo: Topology, linkId: string, up: boolean) {
    const l = topo.links.find((x) => x.id === linkId);
    if (!l) throw new Error(`Enlace ${linkId} no existe`);
    const { kind } = this.kind(topo, l.a.node);
    if (!kind.linkControl) throw new Error(`El kind ${kind.label} no permite control de enlaces`);
    await execFileP("docker", ["exec", containerName(topo.name, l.a.node), "ip", "link", "set",
      toClabIface(kind, l.a.iface), up ? "up" : "down"]);
  }
}
