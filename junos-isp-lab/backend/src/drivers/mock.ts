import type { ConsoleSession, NetworkDriver } from "./driver.js";
import type { LinkState, Topology } from "../types.js";
import { simulate, type SimState } from "./mock-engine.js";

const wrap = (v: unknown) => [{ data: String(v) }];

/** Estado en memoria de un lab simulado. */
class MockLab {
  running = new Map<string, string[]>(); // config "committed" por nodo
  down = new Set<string>();
  constructor(public topo: Topology) {}
  state(): SimState {
    return simulate(this.topo, this.running, this.down);
  }
}

export class MockDriver implements NetworkDriver {
  readonly name = "mock";
  private labs = new Map<string, MockLab>();

  private lab(topo: Topology) {
    let l = this.labs.get(topo.name);
    if (!l) throw new Error(`Lab ${topo.name} no está desplegado`);
    l.topo = topo; // el canvas puede haber cambiado posiciones/enlaces
    return l;
  }

  async deploy(topo: Topology, log: (l: string) => void) {
    const prev = this.labs.get(topo.name);
    const l = new MockLab(topo);
    if (prev) l.running = prev.running;
    this.labs.set(topo.name, l);
    for (const n of topo.nodes) {
      log(`[mock] arrancando ${n.id} (${n.kind})...`);
      await new Promise((r) => setTimeout(r, 150));
    }
    log("[mock] laboratorio simulado listo. Recuerda: el CLI es una simulación, no Junos real.");
  }

  async destroy(topo: Topology, log: (l: string) => void) {
    this.labs.delete(topo.name);
    log("[mock] laboratorio destruido");
  }

  openConsole(topo: Topology, nodeId: string): ConsoleSession {
    const lab = this.lab(topo);
    return new FakeJunosCli(lab, nodeId);
  }

  async exec(topo: Topology, nodeId: string, cmd: string) {
    return runOperational(this.lab(topo), nodeId, cmd);
  }

  async linkStates(topo: Topology): Promise<LinkState[]> {
    const l = this.labs.get(topo.name);
    return topo.links.map((x) => ({ id: x.id, state: !l ? "unknown" : l.down.has(x.id) ? "down" : "up" }));
  }

  async setLink(topo: Topology, linkId: string, up: boolean) {
    const l = this.lab(topo);
    up ? l.down.delete(linkId) : l.down.add(linkId);
  }
}

// ---------------------------------------------------------------- CLI simulado

function runOperational(lab: MockLab, node: string, full: string): string {
  const [cmdRaw, ...pipes] = full.split("|").map((s) => s.trim());
  const json = pipes.some((p) => /^display json/.test(p));
  const cmd = cmdRaw.replace(/\s+/g, " ");
  const st = lab.state();
  const sess = st.bgp.filter((s) => s.node === node);
  const routes = st.routes.get(node) ?? [];
  const cfgLines = lab.running.get(node) ?? [];

  if (/^show (bgp summary|bgp sum)/.test(cmd)) {
    if (json)
      return JSON.stringify({ "bgp-information": [{ "bgp-peer": sess.map((s) => ({
        "peer-address": wrap(s.peer), "peer-as": wrap(s.peerAs ?? "?"), "peer-state": wrap(s.state), "elapsed-time": wrap("1:23"),
        "bgp-rib": [{ name: wrap("inet.0"), "active-prefix-count": wrap(s.active), "received-prefix-count": wrap(s.received), "accepted-prefix-count": wrap(s.received) }],
      })) }] }, null, 1);
    const est = sess.filter((s) => s.state === "Established").length;
    return [
      `Threading mode: BGP I/O\nGroups: 1 Peers: ${sess.length} Down peers: ${sess.length - est}`,
      "Peer                     AS      InPkt     OutPkt    OutQ   Flaps Last Up/Dwn State|#Active/Received/Accepted/Damped...",
      ...sess.map((s) => `${s.peer.padEnd(20)} ${String(s.peerAs ?? "").padStart(8)}        42         40       0       0        1:23 ${s.state === "Established" ? `Establ\n  inet.0: ${s.active}/${s.received}/${s.received}/0` : s.state}`),
    ].join("\n");
  }
  if (/^show ospf neighbor/.test(cmd)) {
    const a = st.ospf.filter((x) => x.node === node);
    if (json) return JSON.stringify({ "ospf-neighbor-information": [{ "ospf-neighbor": a.map((x) => ({ "neighbor-address": wrap(x.peerAddr), "interface-name": wrap(x.iface), "ospf-neighbor-state": wrap("Full"), "neighbor-id": wrap(x.peerRid) })) }] });
    return ["Address          Interface              State           ID               Pri  Dead", ...a.map((x) => `${x.peerAddr.padEnd(16)} ${x.iface.padEnd(22)} Full            ${x.peerRid.padEnd(16)} 128    35`)].join("\n");
  }
  if (/^show isis adjacency/.test(cmd)) {
    const a = st.isis.filter((x) => x.node === node);
    if (json) return JSON.stringify({ "isis-adjacency-information": [{ "isis-adjacency": a.map((x) => ({ "interface-name": wrap(x.iface), "system-name": wrap(x.peerNode), level: wrap("2"), "adjacency-state": wrap("Up") })) }] });
    return ["Interface             System         L State         Hold (secs) SNPA", ...a.map((x) => `${x.iface.padEnd(21)} ${x.peerNode.padEnd(14)} 2 Up                     24`)].join("\n");
  }
  if (/^show route/.test(cmd)) {
    const m = cmd.match(/^show route (?:(?:table \S+ )?)(\d+\.\d+\.\d+\.\d+(?:\/\d+)?)/);
    const proto = cmd.match(/protocol (\S+)/)?.[1]?.toLowerCase();
    let rs = routes.filter((r) => !m || r.prefix === m[1] || r.prefix === `${m[1]}/32`);
    if (proto) rs = rs.filter((r) => r.protocol.toLowerCase() === proto);
    if (/receive-protocol bgp/.test(cmd)) {
      const peer = cmd.match(/receive-protocol bgp (\S+)/)?.[1];
      rs = routes.filter((r) => r.protocol === "BGP" && r.peer === peer);
    }
    const sorted = [...rs].sort((a, b) => a.prefix.localeCompare(b.prefix, undefined, { numeric: true }));
    if (json) {
      const byPfx = new Map<string, typeof sorted>();
      sorted.forEach((r) => byPfx.set(r.prefix, [...(byPfx.get(r.prefix) ?? []), r]));
      return JSON.stringify({ "route-information": [{ "route-table": [{ "table-name": wrap("inet.0"), rt: [...byPfx].map(([p, list]) => ({
        "rt-destination": wrap(p),
        "rt-entry": list.map((r) => ({
          "active-tag": wrap(r.active ? "*" : " "), "protocol-name": wrap(r.protocol), preference: wrap(r.pref),
          ...(r.asPath ? { "as-path": wrap(`${r.asPath.join(" ")} I`.trim()) } : {}),
          ...(r.localPref !== undefined || r.protocol === "BGP" ? { "local-preference": wrap(r.localPref ?? 100) } : {}),
          nh: [{ ...(r.nextHop ? { to: wrap(r.nextHop) } : {}), ...(r.via ? { via: wrap(r.via) } : {}) }],
        })),
      })) }] }] }, null, 1);
    }
    const active = sorted.filter((r) => r.active).length;
    const out = [`\ninet.0: ${new Set(sorted.map((r) => r.prefix)).size} destinations, ${sorted.length} routes (${active} active, 0 holddown, 0 hidden)`, "+ = Active Route, - = Last Active, * = Both\n"];
    let last = "";
    for (const r of sorted) {
      const head = r.prefix === last ? "".padEnd(19) : r.prefix.padEnd(19);
      last = r.prefix;
      out.push(`${head}${r.active ? "*" : " "}[${r.protocol}/${r.pref}] 00:01:23${r.localPref !== undefined || r.protocol === "BGP" ? `, localpref ${r.localPref ?? 100}` : ""}`);
      if (r.asPath) out.push(`                      AS path: ${[...r.asPath, "I"].join(" ")}`);
      if (r.nextHop) out.push(`                    >  to ${r.nextHop} via ${r.via ?? "?"}`);
      else if (r.via) out.push(`                    >  via ${r.via}`);
      else out.push(r.protocol === "Static" ? "                       Discard" : "");
    }
    return out.join("\n");
  }
  if (/^show interfaces terse/.test(cmd)) {
    const c = st.cfg.get(node)!;
    const ifs = new Set<string>(["lo0"]);
    lab.topo.links.forEach((l) => [l.a, l.b].forEach((e) => e.node === node && ifs.add(e.iface)));
    const linkUp = (i: string) => i === "lo0" || lab.topo.links.some((l) => !lab.down.has(l.id) && [l.a, l.b].some((e) => e.node === node && e.iface === i));
    if (json) return JSON.stringify({ "interface-information": [{ "physical-interface": [...ifs].map((i) => ({
      name: wrap(i), "admin-status": wrap("up"), "oper-status": wrap(linkUp(i) ? "up" : "down"),
      "logical-interface": c.ifaces.has(`${i}.0`) ? [{ name: wrap(`${i}.0`), "admin-status": wrap("up"), "oper-status": wrap(linkUp(i) ? "up" : "down"),
        "address-family": [{ "address-family-name": wrap("inet"), "interface-address": [{ "ifa-local": wrap(c.ifaces.get(`${i}.0`)!.text) }] }] }] : [],
    })) }] });
    const rows = ["Interface               Admin Link Proto    Local                 Remote"];
    for (const i of ifs) {
      const s = linkUp(i) ? "up" : "down";
      rows.push(`${i.padEnd(24)}up    ${s}`);
      const a = c.ifaces.get(`${i}.0`);
      if (a) rows.push(`${`${i}.0`.padEnd(24)}up    ${s.padEnd(5)}inet     ${a.text}`);
    }
    return rows.join("\n");
  }
  if (/^show configuration/.test(cmd)) return cfgLines.join("\n") || "## (configuración vacía)";
  if (/^ping \S+/.test(cmd)) {
    const target = cmd.split(" ")[1];
    const ok = routes.some((r) => r.active && r.protocol !== "Static" && cidrHas(r.prefix, target));
    return ok
      ? `PING ${target}: 56 data bytes\n64 bytes from ${target}: icmp_seq=0 ttl=63 time=1.2 ms\n64 bytes from ${target}: icmp_seq=1 ttl=63 time=1.1 ms\n\n--- ${target} ping statistics ---\n2 packets transmitted, 2 packets received, 0% packet loss`
      : `PING ${target}: 56 data bytes\nping: sendto: No route to host\n\n--- ${target} ping statistics ---\n2 packets transmitted, 0 packets received, 100% packet loss`;
  }
  if (/^set cli /.test(cmd) || cmd === "") return "";
  return `                ^\nunknown command. (simulador: show bgp summary | show ospf neighbor | show isis adjacency | show route [prefix] | show interfaces terse | show configuration | ping | configure)`;
}

function cidrHas(prefix: string, ip: string) {
  const n = (s: string) => s.split(".").reduce((a, o) => a * 256 + Number(o), 0);
  const [net, len] = prefix.split("/");
  const m = Number(len) === 0 ? 0 : (0xffffffff << (32 - Number(len))) >>> 0;
  return ((n(net) & m) >>> 0) === ((n(ip) & m) >>> 0);
}

class FakeJunosCli implements ConsoleSession {
  private dataCb: (d: string) => void = () => {};
  private exitCb: (c: number) => void = () => {};
  private line = "";
  private mode: "op" | "conf" | "load" = "op";
  private candidate: string[] = [];
  private esc = false;

  constructor(private lab: MockLab, private node: string) {
    this.candidate = [...(lab.running.get(node) ?? [])];
    setTimeout(() => this.out(`\r\n--- JUNOS (simulado) ${node} ---\r\n\r\n${this.prompt()}`), 50);
  }
  private prompt() {
    return this.mode === "conf" ? `\r\n[edit]\r\nroot@${this.node}# ` : this.mode === "load" ? "" : `root@${this.node}> `;
  }
  private out(s: string) {
    this.dataCb(s.replace(/\r?\n/g, "\r\n"));
  }
  onData(cb: (d: string) => void) { this.dataCb = cb; }
  onExit(cb: (c: number) => void) { this.exitCb = cb; }
  resize() {}
  close() {}

  write(data: string) {
    for (const ch of data) {
      if (this.esc) { if (/[A-Za-z~]/.test(ch)) this.esc = false; continue; } // ignora secuencias ANSI (flechas)
      if (ch === "\x1b") { this.esc = true; continue; }
      if (ch === "\r" || ch === "\n") { this.out("\r\n"); this.handle(this.line); this.line = ""; }
      else if (ch === "\x7f" || ch === "\b") { if (this.line) { this.line = this.line.slice(0, -1); this.out("\b \b"); } }
      else if (ch === "\x03") { this.line = ""; this.out("^C\r\n" + this.prompt()); if (this.mode === "load") this.mode = "conf"; }
      else if (ch === "\x04") { if (this.mode === "load") { this.mode = "conf"; this.out("load complete\r\n" + this.prompt()); } }
      else if (ch >= " ") { this.line += ch; if (this.mode !== "load") this.out(ch); }
    }
  }

  private handle(input: string) {
    const cmd = input.trim();
    if (this.mode === "load") {
      if (cmd.startsWith("set ") || cmd.startsWith("delete ")) this.applyConf(cmd);
      return;
    }
    if (this.mode === "op") {
      if (cmd === "configure" || cmd === "configure private" || cmd === "configure exclusive") {
        this.mode = "conf";
        this.candidate = [...(this.lab.running.get(this.node) ?? [])];
        this.out("Entering configuration mode" + this.prompt());
        return;
      }
      if (cmd === "exit" || cmd === "quit") { this.out("Connection closed.\r\n"); this.exitCb(0); return; }
      const res = runOperational(this.lab, this.node, cmd);
      this.out((res ? res + "\n\n" : "") + this.prompt());
      return;
    }
    // modo configuración
    if (cmd.startsWith("set ") || cmd.startsWith("delete ")) this.applyConf(cmd);
    else if (cmd === "load set terminal" || cmd === "load merge terminal set") { this.mode = "load"; this.out("[Type ^D at a new line to end input]\r\n"); return; }
    else if (cmd === "show | compare") {
      const run = new Set(this.lab.running.get(this.node) ?? []);
      const cand = new Set(this.candidate);
      this.out([...this.candidate.filter((l) => !run.has(l)).map((l) => `+ ${l}`), ...[...run].filter((l) => !cand.has(l)).map((l) => `- ${l}`)].join("\n"));
    } else if (cmd === "show" || cmd === "show | display set") this.out(this.candidate.join("\n"));
    else if (cmd.startsWith("commit")) {
      this.lab.running.set(this.node, [...this.candidate]);
      this.out("commit complete");
      if (cmd.includes("and-quit")) { this.mode = "op"; this.out("\r\nExiting configuration mode\r\n\r\n" + this.prompt()); return; }
    } else if (cmd === "rollback" || cmd === "rollback 0") { this.candidate = [...(this.lab.running.get(this.node) ?? [])]; this.out("load complete"); }
    else if (cmd.startsWith("run ")) this.out(runOperational(this.lab, this.node, cmd.slice(4)));
    else if (cmd === "exit" || cmd === "quit" || cmd === "exit configuration-mode") {
      const dirty = this.candidate.join("\n") !== (this.lab.running.get(this.node) ?? []).join("\n");
      if (dirty) this.out("The configuration has been changed but not committed\r\n");
      this.mode = "op"; this.out("Exiting configuration mode\r\n\r\n" + this.prompt()); return;
    } else if (cmd) this.out("syntax error (simulador: set/delete/show/show | compare/commit/rollback/run/load set terminal/exit)");
    this.out(this.prompt());
  }

  private applyConf(cmd: string) {
    if (cmd.startsWith("set ")) { if (!this.candidate.includes(cmd)) this.candidate.push(cmd); }
    else { const p = "set " + cmd.slice(7); this.candidate = this.candidate.filter((l) => !(l === p || l.startsWith(p + " "))); }
  }
}
