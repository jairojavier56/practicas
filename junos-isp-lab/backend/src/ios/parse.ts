/**
 * Parsers de la salida de texto de Cisco IOS / IOS-XE (IOL, CSR, Cat8000v).
 * Devuelven las mismas filas que los parsers de Junos para que inspector,
 * validaciones y estado en vivo funcionen igual con los dos fabricantes.
 */
import type { BgpPeerRow, IsisAdjRow, OspfNbrRow, RouteRow, IfaceRow, LdpRow } from "../junos/parse.js";

const lines = (t: string) => t.replace(/\r/g, "").split("\n");
const IP = String.raw`\d+\.\d+\.\d+\.\d+`;

/** `show bgp all summary`: una tabla por address-family; una fila por vecino. */
export function iosBgpSummary(text: string): BgpPeerRow[] {
  const out = new Map<string, BgpPeerRow>();
  let af = "IPv4 Unicast";
  let inTable = false;
  for (const l of lines(text)) {
    const m = l.match(/^For address family: (.+)$/);
    if (m) { af = m[1].trim(); inTable = false; continue; }
    if (/^Neighbor\s+V\s+AS/.test(l)) { inTable = true; continue; }
    if (!inTable) continue;
    const r = l.match(new RegExp(`^(${IP})\\s+\\d+\\s+(\\d+)\\s+\\d+\\s+\\d+\\s+\\d+\\s+\\d+\\s+\\d+\\s+(\\S+)\\s+(.+)$`));
    if (!r) continue;
    const [, peer, asn, upDown, st] = r;
    const est = /^\d+$/.test(st.trim());
    const row: BgpPeerRow = { peer, asn, state: est ? "Established" : st.trim().replace(/\s*\(Admin\)/, " (Admin)"), uptime: upDown, received: est ? st.trim() : undefined, family: af };
    const prev = out.get(peer);
    // un vecino aparece en varias familias: nos quedamos con "Established" si lo está en alguna
    if (!prev || (prev.state !== "Established" && est)) out.set(peer, row);
    else if (prev && est) prev.family = `${prev.family}, ${af}`;
  }
  return [...out.values()];
}

/** `show ip ospf neighbor` */
export function iosOspfNeighbors(text: string): OspfNbrRow[] {
  const rows: OspfNbrRow[] = [];
  for (const l of lines(text)) {
    // "FULL/DR", "FULL/  -" (punto a punto), "INIT/DROTHER"...
    const r = l.match(new RegExp(`^(${IP})\\s+\\d+\\s+([A-Z-]+)(?:/\\s*[-A-Z]*)?\\s+[\\d:]+\\s+(${IP})\\s+(\\S+)`));
    if (!r) continue;
    const st = r[2];
    rows.push({ routerId: r[1], state: st === "FULL" ? "Full" : st[0] + st.slice(1).toLowerCase(), address: r[3], iface: r[4] });
  }
  return rows;
}

/** `show isis neighbors` */
export function iosIsisNeighbors(text: string): IsisAdjRow[] {
  const rows: IsisAdjRow[] = [];
  for (const l of lines(text)) {
    const r = l.match(new RegExp(`^(\\S+)\\s+(L1|L2|L1L2)\\s+(\\S+)\\s+(${IP})?\\s*(UP|DOWN|INIT)\\b`));
    if (r) rows.push({ system: r[1], level: r[2], iface: r[3], state: r[5] === "UP" ? "Up" : r[5][0] + r[5].slice(1).toLowerCase() });
  }
  return rows;
}

/** `show mpls ldp neighbor`: bloques "Peer LDP Ident: x:0; ... State: Oper" */
export function iosLdpNeighbors(text: string): LdpRow[] {
  const rows: LdpRow[] = [];
  let cur: LdpRow | null = null;
  for (const l of lines(text)) {
    const p = l.match(new RegExp(`Peer LDP Ident:\\s*(${IP}):\\d+`));
    if (p) { cur = { neighbor: p[1], state: "Nonexistent" }; rows.push(cur); continue; }
    const s = l.match(/\bState:\s*(\w+)/);
    if (s && cur) cur.state = s[1] === "Oper" ? "Operational" : s[1];
  }
  return rows;
}

const PROTO: Record<string, string> = { C: "Direct", L: "Local", S: "Static", O: "OSPF", i: "IS-IS", B: "BGP", D: "EIGRP", R: "RIP" };

/** `show ip route [vrf X]` */
export function iosRoutes(text: string, table = "inet.0"): RouteRow[] {
  const rows: RouteRow[] = [];
  let classfulLen: number | null = null;
  let last: RouteRow | null = null;
  for (const raw of lines(text)) {
    const l = raw.replace(/\s+$/, "");
    const hdr = l.match(new RegExp(`^\\s+${IP}/(\\d+) is subnetted`));
    if (hdr) { classfulLen = Number(hdr[1]); continue; }
    if (/is variably subnetted/.test(l)) { classfulLen = null; continue; }
    const r = l.match(new RegExp(`^([A-Za-z*+%&]{1,2}(?:\\s?(?:IA|E1|E2|N1|N2|L1|L2|ia|su))?\\*?)\\s+(${IP})(/\\d+)?\\s+(.*)$`));
    if (r) {
      const code = r[1].replace("*", "").trim().split(/\s+/)[0];
      const len = r[3] ? r[3] : classfulLen != null ? `/${classfulLen}` : "/32";
      const rest = r[4];
      const nh = rest.match(new RegExp(`via (${IP})`));
      const ifc = rest.match(/(?:connected,|,)\s*([A-Za-z][\w/.:-]*\d)\s*$/);
      last = {
        table, prefix: `${r[2]}${len}`, active: true, protocol: PROTO[code[0]] ?? code,
        preference: rest.match(/\[(\d+)\/\d+\]/)?.[1], nextHop: nh?.[1], via: ifc?.[1],
      };
      rows.push(last);
      continue;
    }
    // ECMP: línea de continuación "[110/20] via 10.0.0.5, 00:01:02, Ethernet0/2"
    const cont = l.match(new RegExp(`^\\s+\\[(\\d+)/\\d+\\] via (${IP})(?:.*,\\s*([A-Za-z][\\w/.:-]*\\d))?`));
    if (cont && last) rows.push({ ...last, nextHop: cont[2], via: cont[3] });
  }
  // BGP (sobre todo iBGP) no muestra interfaz: la resolvemos por el IGP, match más largo
  const toN = (ip: string) => ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);
  const covers = (pfx: string, ip: string) => {
    const [net, len] = pfx.split("/"); const L = Number(len);
    const m = L === 0 ? 0 : (0xffffffff << (32 - L)) >>> 0;
    return ((toN(net) & m) >>> 0) === ((toN(ip) & m) >>> 0);
  };
  for (const r of rows) {
    if (r.via || !r.nextHop) continue;
    const res = rows.filter((x) => x.via && x.protocol !== "BGP" && covers(x.prefix, r.nextHop!))
      .sort((a, b) => Number(b.prefix.split("/")[1]) - Number(a.prefix.split("/")[1]))[0];
    r.via = res?.via;
  }
  return rows;
}

/** `show ip interface brief` */
export function iosInterfaces(text: string): IfaceRow[] {
  const rows: IfaceRow[] = [];
  for (const l of lines(text)) {
    const r = l.match(/^(\S+)\s+(\S+)\s+(?:YES|NO)\s+\S+\s+(administratively down|up|down)\s+(up|down)/);
    if (r) rows.push({ name: r[1], address: r[2] === "unassigned" ? undefined : r[2], admin: r[3] === "administratively down" ? "down" : "up", oper: r[4] });
  }
  return rows;
}
