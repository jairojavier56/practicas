/**
 * Mini-simulador de control-plane para el MockDriver.
 *
 * NO es Junos: interpreta un subconjunto de comandos `set` (interfaces, OSPF,
 * BGP, rutas estáticas) y calcula vecindades y tablas de forma aproximada para
 * poder desarrollar la UI y practicar el flujo de los labs sin imágenes.
 * La verdad siempre la tiene el Junos real (driver containerlab).
 */
import type { Topology } from "../types.js";

interface Cidr { ip: number; len: number; text: string }
const ip2n = (s: string) => s.split(".").reduce((a, o) => a * 256 + Number(o), 0);
const n2ip = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
const mask = (len: number) => (len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0);
const parseCidr = (t: string): Cidr => {
  const [a, l] = t.split("/");
  return { ip: ip2n(a), len: Number(l ?? 32), text: t };
};
export const network = (c: Cidr) => `${n2ip((c.ip & mask(c.len)) >>> 0)}/${c.len}`;
const contains = (net: Cidr, ip: number) => ((ip & mask(net.len)) >>> 0) === ((net.ip & mask(net.len)) >>> 0);

interface BgpNbr { addr: string; group: string; peerAs?: number; type: "internal" | "external"; localAddr?: string; rrClient: boolean; nhs: boolean; localPref?: number; prepend?: number }

export interface NodeCfg {
  id: string;
  asn?: number;
  ifaces: Map<string, Cidr>; // "ge-0/0/0.0" → 10.0.0.1/30
  ospf: Set<string>;
  isis: Set<string>;
  bgp: BgpNbr[];
  statics: string[];
}

const unitName = (i: string) => (i.includes(".") ? i : `${i}.0`);

export function parseSetConfig(id: string, lines: string[]): NodeCfg {
  const c: NodeCfg = { id, ifaces: new Map(), ospf: new Set(), isis: new Set(), bgp: [], statics: [] };
  const groups = new Map<string, Partial<BgpNbr> & { cluster?: boolean; export?: string[] }>();
  const policyHas = new Map<string, string[]>(); // policy → líneas
  const nbrLines: { group: string; addr: string; rest: string }[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^set interfaces (\S+) unit (\d+) family inet address (\S+)/))) c.ifaces.set(`${m[1]}.${m[2]}`, parseCidr(m[3]));
    else if ((m = l.match(/^set routing-options autonomous-system (\d+)/))) c.asn = Number(m[1]);
    else if ((m = l.match(/^set routing-options static route (\S+)/))) c.statics.push(m[1]);
    else if ((m = l.match(/^set protocols ospf3? area \S+ interface (\S+)/))) c.ospf.add(unitName(m[1]));
    else if ((m = l.match(/^set protocols isis interface (\S+)/))) c.isis.add(unitName(m[1]));
    else if ((m = l.match(/^set policy-options policy-statement (\S+) (.*)$/))) policyHas.set(m[1], [...(policyHas.get(m[1]) ?? []), m[2]]);
    else if ((m = l.match(/^set protocols bgp group (\S+) neighbor (\S+)\s*(.*)$/))) nbrLines.push({ group: m[1], addr: m[2], rest: m[3] });
    else if ((m = l.match(/^set protocols bgp group (\S+) (.*)$/))) {
      const g = groups.get(m[1]) ?? {};
      const r = m[2];
      let k: RegExpMatchArray | null;
      if ((k = r.match(/^type (internal|external)/))) g.type = k[1] as BgpNbr["type"];
      if ((k = r.match(/^peer-as (\d+)/))) g.peerAs = Number(k[1]);
      if ((k = r.match(/^local-address (\S+)/))) g.localAddr = k[1];
      if (r.startsWith("cluster")) g.cluster = true;
      if ((k = r.match(/^(?:export|import) (\S+)/))) g.export = [...(g.export ?? []), k[1]];
      groups.set(m[1], g);
    }
  }
  const byKey = new Map<string, BgpNbr>();
  const ensure = (group: string, addr: string) => {
    const key = `${group}|${addr}`;
    if (!byKey.has(key)) {
      const g = groups.get(group) ?? {};
      const pol = (g.export ?? []).flatMap((p) => policyHas.get(p) ?? []);
      const lp = pol.map((x) => x.match(/local-preference (\d+)/)).find(Boolean);
      const pp = pol.map((x) => x.match(/as-path-prepend "?([\d ]+)"?/)).find(Boolean);
      byKey.set(key, {
        addr, group,
        type: g.type ?? "external",
        peerAs: g.peerAs,
        localAddr: g.localAddr,
        rrClient: !!g.cluster,
        nhs: pol.some((x) => /next-hop self/.test(x)),
        localPref: lp ? Number(lp[1]) : undefined,
        prepend: pp ? pp[1].trim().split(/\s+/).length : undefined,
      });
    }
    return byKey.get(key)!;
  };
  for (const n of nbrLines) {
    const nb = ensure(n.group, n.addr);
    const k = n.rest.match(/^peer-as (\d+)/);
    if (k) nb.peerAs = Number(k[1]);
  }
  c.bgp = [...byKey.values()];
  return c;
}

export interface Route { prefix: string; protocol: "Direct" | "Local" | "Static" | "OSPF" | "IS-IS" | "BGP"; nextHop?: string; via?: string; asPath?: number[]; localPref?: number; active?: boolean; pref: number; ibgp?: boolean; peer?: string }
export interface Session { node: string; peer: string; peerAs?: number; state: "Established" | "Active" | "Connect" | "Idle"; received: number; active: number }
export interface Adj { node: string; peerNode: string; iface: string; peerAddr: string; peerRid: string }
export interface SimState { routes: Map<string, Route[]>; bgp: Session[]; ospf: Adj[]; isis: Adj[]; cfg: Map<string, NodeCfg> }

const PREF = { Direct: 0, Local: 0, Static: 5, OSPF: 10, "IS-IS": 15, BGP: 170 } as const;

export function simulate(topo: Topology, configs: Map<string, string[]>, downLinks: Set<string>): SimState {
  const cfg = new Map(topo.nodes.map((n) => {
    const c = parseSetConfig(n.id, configs.get(n.id) ?? []);
    c.asn ??= n.asn;
    return [n.id, c] as const;
  }));
  const rid = (n: string) => cfg.get(n)?.ifaces.get("lo0.0")?.text.split("/")[0] ?? "0.0.0.0";

  // 1) Adyacencias L3 por enlace activo
  interface L3 { a: string; b: string; ai: string; bi: string; aAddr: string; bAddr: string }
  const l3: L3[] = [];
  for (const l of topo.links) {
    if (downLinks.has(l.id)) continue;
    const ai = unitName(l.a.iface), bi = unitName(l.b.iface);
    const A = cfg.get(l.a.node)?.ifaces.get(ai), B = cfg.get(l.b.node)?.ifaces.get(bi);
    if (A && B && A.len === B.len && contains(A, B.ip)) l3.push({ a: l.a.node, b: l.b.node, ai, bi, aAddr: A.text.split("/")[0], bAddr: B.text.split("/")[0] });
  }
  const adjOf = (proto: "ospf" | "isis") => {
    const out: Adj[] = [];
    for (const x of l3) {
      if (cfg.get(x.a)![proto].has(x.ai) && cfg.get(x.b)![proto].has(x.bi)) {
        out.push({ node: x.a, peerNode: x.b, iface: x.ai, peerAddr: x.bAddr, peerRid: rid(x.b) });
        out.push({ node: x.b, peerNode: x.a, iface: x.bi, peerAddr: x.aAddr, peerRid: rid(x.a) });
      }
    }
    return out;
  };
  const ospf = adjOf("ospf"), isis = adjOf("isis");

  // 2) Rutas conectadas / estáticas / IGP
  const routes = new Map<string, Route[]>(topo.nodes.map((n) => [n.id, []]));
  for (const [id, c] of cfg) {
    const r = routes.get(id)!;
    for (const [ifn, ci] of c.ifaces) {
      const up = ifn.startsWith("lo0") || l3.some((x) => (x.a === id && x.ai === ifn) || (x.b === id && x.bi === ifn))
        || topo.links.some((l) => !downLinks.has(l.id) && ((l.a.node === id && unitName(l.a.iface) === ifn) || (l.b.node === id && unitName(l.b.iface) === ifn)));
      if (!up) continue;
      if (ci.len < 32) r.push({ prefix: network(ci), protocol: "Direct", via: ifn, pref: 0 });
      r.push({ prefix: `${ci.text.split("/")[0]}/32`, protocol: "Local", via: ifn, pref: 0 });
    }
    for (const s of c.statics) r.push({ prefix: s, protocol: "Static", pref: 5 });
  }
  for (const [proto, adjs] of [["OSPF", ospf], ["IS-IS", isis]] as const) {
    const key = proto === "OSPF" ? "ospf" : "isis";
    for (const src of topo.nodes.map((n) => n.id)) {
      // BFS por número de saltos; guardamos el primer salto
      const first = new Map<string, Adj>();
      const q: string[] = [src];
      const seen = new Set([src]);
      while (q.length) {
        const cur = q.shift()!;
        for (const a of adjs.filter((x) => x.node === cur)) {
          if (seen.has(a.peerNode)) continue;
          seen.add(a.peerNode);
          first.set(a.peerNode, cur === src ? a : first.get(cur)!);
          q.push(a.peerNode);
        }
      }
      const r = routes.get(src)!;
      for (const [dst, hop] of first) {
        const dc = cfg.get(dst)!;
        for (const [ifn, ci] of dc.ifaces) {
          if (!dc[key].has(ifn)) continue;
          const pfx = ifn.startsWith("lo0") ? `${ci.text.split("/")[0]}/32` : network(ci);
          if (r.some((x) => x.prefix === pfx && x.pref <= PREF[proto])) continue;
          r.push({ prefix: pfx, protocol: proto, nextHop: hop.peerAddr, via: hop.iface, pref: PREF[proto] });
        }
      }
    }
  }
  const reach = (node: string, ip: string) => routes.get(node)!.some((r) => r.protocol !== "Static" && contains(parseCidr(r.prefix), ip2n(ip)));
  const owner = (ip: string) => [...cfg.values()].find((c) => [...c.ifaces.values()].some((x) => x.text.split("/")[0] === ip));

  // 3) Sesiones BGP
  const bgp: Session[] = [];
  const est: { from: string; to: string; nbr: BgpNbr; back: BgpNbr }[] = [];
  for (const [id, c] of cfg) {
    for (const nb of c.bgp) {
      const peer = owner(nb.addr);
      let state: Session["state"] = "Active";
      if (peer && c.asn && reach(id, nb.addr)) {
        const back = peer.bgp.find((b) => owner(b.addr)?.id === id);
        const asOk = nb.type === "internal" ? peer.asn === c.asn : nb.peerAs === peer.asn && back?.peerAs === c.asn;
        if (back && asOk && reach(peer.id, back.addr)) {
          state = "Established";
          est.push({ from: id, to: peer.id, nbr: nb, back });
        }
      }
      bgp.push({ node: id, peer: nb.addr, peerAs: nb.type === "internal" ? c.asn : nb.peerAs, state, received: 0, active: 0 });
    }
  }

  // 4) Propagación BGP hasta punto fijo
  type B = Route & { origin: string };
  const rib = new Map<string, Map<string, B[]>>(topo.nodes.map((n) => [n.id, new Map()]));
  const best = (node: string, pfx: string) => {
    const c = rib.get(node)!.get(pfx) ?? [];
    return [...c].sort((x, y) =>
      (y.localPref ?? 100) - (x.localPref ?? 100) ||
      (x.asPath?.length ?? 0) - (y.asPath?.length ?? 0) ||
      Number(!!x.ibgp) - Number(!!y.ibgp) ||
      (x.peer ?? "").localeCompare(y.peer ?? ""))[0];
  };
  for (const [id, c] of cfg) for (const s of c.statics) rib.get(id)!.set(s, [{ prefix: s, protocol: "BGP", asPath: [], pref: 170, origin: id }]);
  for (let round = 0; round < 16; round++) {
    let changed = false;
    for (const e of est) {
      const fromCfg = cfg.get(e.from)!, toCfg = cfg.get(e.to)!;
      const ebgp = e.nbr.type === "external";
      for (const pfx of rib.get(e.from)!.keys()) {
        const b = best(e.from, pfx);
        if (!b) continue;
        if (b.peer === e.back.addr) continue; // no devolver al que lo envió
        if (!ebgp && b.ibgp && !e.nbr.rrClient && !(fromCfg.bgp.find((x) => x.addr === b.peer)?.rrClient)) continue; // split-horizon iBGP
        const path = ebgp ? [...Array(1 + (e.nbr.prepend ?? 0)).fill(fromCfg.asn!), ...(b.asPath ?? [])] : (b.asPath ?? []);
        if (ebgp && path.includes(toCfg.asn!)) continue; // loop AS-PATH
        const nh = ebgp || e.nbr.nhs || !b.nextHop ? e.back.addr : b.nextHop;
        const cand: B = { prefix: pfx, protocol: "BGP", asPath: path, nextHop: nh, pref: 170, ibgp: !ebgp, peer: e.back.addr, origin: b.origin, localPref: ebgp ? e.back.localPref : b.localPref };
        const list = rib.get(e.to)!.get(pfx) ?? [];
        const prev = list.find((x) => x.peer === cand.peer);
        if (prev && JSON.stringify(prev) === JSON.stringify(cand)) continue;
        rib.get(e.to)!.set(pfx, [...list.filter((x) => x.peer !== cand.peer), cand]);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const [id, m] of rib) {
    for (const [pfx, cands] of m) {
      const b = best(id, pfx);
      for (const x of cands) {
        if (!x.peer) continue;
        routes.get(id)!.push({ ...x, active: false });
        const s = bgp.find((s) => s.node === id && s.peer === x.peer);
        if (s) { s.received++; if (x === b) s.active++; }
      }
    }
  }
  // 5) Selección de ruta activa por preferencia
  for (const [id, r] of routes) {
    const byPfx = new Map<string, Route[]>();
    r.forEach((x) => byPfx.set(x.prefix, [...(byPfx.get(x.prefix) ?? []), x]));
    for (const list of byPfx.values()) {
      list.forEach((x) => (x.active = false));
      // Un next-hop BGP no resoluble deja la ruta inutilizable (en Junos: "Unusable"/hidden)
      const ok = list.filter((x) => x.protocol !== "BGP" || !x.nextHop || reach(id, x.nextHop));
      ok.sort((a, b) => a.pref - b.pref || (b.localPref ?? 100) - (a.localPref ?? 100) || (a.asPath?.length ?? 0) - (b.asPath?.length ?? 0) || Number(!!a.ibgp) - Number(!!b.ibgp));
      if (ok[0]) ok[0].active = true;
    }
    // Resolución recursiva del next-hop BGP → interfaz de salida (vía IGP/directa, match más largo)
    for (const x of r) {
      if (x.protocol !== "BGP" || !x.nextHop) continue;
      const res = r.filter((y) => y.protocol !== "BGP" && y.via && contains(parseCidr(y.prefix), ip2n(x.nextHop!)))
        .sort((a, b) => parseCidr(b.prefix).len - parseCidr(a.prefix).len)[0];
      x.via = res?.via;
    }
  }
  return { routes, bgp, ospf, isis, cfg };
}
