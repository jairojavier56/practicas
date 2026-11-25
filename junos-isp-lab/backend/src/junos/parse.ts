/**
 * Parsers de la salida `| display json` de Junos.
 * Junos envuelve cada hoja como [{ "data": "valor" }]; `d()` lo aplana.
 */
type J = Record<string, any>;

export const d = (o: J | undefined, key: string): string | undefined => o?.[key]?.[0]?.data;
const arr = (o: J | undefined, key: string): J[] => (o?.[key] ?? []) as J[];

export interface BgpPeerRow {
  peer: string;
  asn: string;
  state: string;
  uptime?: string;
  received?: string;
  accepted?: string;
  active?: string;
  family?: string;
}

export interface LdpRow {
  neighbor: string;
  state: string; // "Operational" cuando la sesión está arriba
}

export function parseLdpSessions(json: J): LdpRow[] {
  const info = arr(json, "ldp-session-information")[0];
  return arr(info, "ldp-session").map((x) => ({
    neighbor: d(x, "ldp-neighbor-address") ?? "",
    state: d(x, "ldp-session-state") ?? "",
  }));
}

export function parseBgpSummary(json: J): BgpPeerRow[] {
  const info = arr(json, "bgp-information")[0];
  return arr(info, "bgp-peer").map((p) => {
    const rib = arr(p, "bgp-rib")[0];
    return {
      peer: (d(p, "peer-address") ?? "").replace(/\+\d+$/, ""),
      asn: d(p, "peer-as") ?? "",
      // Si está Established, Junos pone el estado en peer-state; algunas versiones
      // dejan "Establ" en la tabla textual pero el JSON trae el nombre completo.
      state: d(p, "peer-state") ?? "",
      uptime: d(p, "elapsed-time"),
      received: d(rib, "received-prefix-count"),
      accepted: d(rib, "accepted-prefix-count"),
      active: d(rib, "active-prefix-count"),
    };
  });
}

export interface OspfNbrRow {
  address: string;
  iface: string;
  state: string;
  routerId: string;
}

export function parseOspfNeighbors(json: J): OspfNbrRow[] {
  const info = arr(json, "ospf-neighbor-information")[0];
  return arr(info, "ospf-neighbor").map((n) => ({
    address: d(n, "neighbor-address") ?? "",
    iface: d(n, "interface-name") ?? "",
    state: d(n, "ospf-neighbor-state") ?? "",
    routerId: d(n, "neighbor-id") ?? "",
  }));
}

export interface IsisAdjRow {
  iface: string;
  system: string;
  level: string;
  state: string;
}

export function parseIsisAdjacency(json: J): IsisAdjRow[] {
  const info = arr(json, "isis-adjacency-information")[0];
  return arr(info, "isis-adjacency").map((a) => ({
    iface: d(a, "interface-name") ?? "",
    system: d(a, "system-name") ?? "",
    level: d(a, "level") ?? "",
    state: d(a, "adjacency-state") ?? "",
  }));
}

export interface RouteRow {
  table: string;
  prefix: string;
  active: boolean;
  protocol: string;
  preference?: string;
  nextHop?: string;
  via?: string;
  asPath?: string;
  localPref?: string;
  med?: string;
}

export function parseRoutes(json: J): RouteRow[] {
  const rows: RouteRow[] = [];
  for (const info of arr(json, "route-information")) {
    for (const table of arr(info, "route-table")) {
      const tname = d(table, "table-name") ?? "";
      for (const rt of arr(table, "rt")) {
        const prefix = d(rt, "rt-destination") ?? "";
        for (const e of arr(rt, "rt-entry")) {
          const nh = arr(e, "nh")[0];
          rows.push({
            table: tname,
            prefix,
            active: d(e, "active-tag") === "*",
            protocol: d(e, "protocol-name") ?? "",
            preference: d(e, "preference"),
            nextHop: d(nh, "to"),
            via: d(nh, "via"),
            asPath: d(e, "as-path")?.replace(/^AS path:\s*/, "").trim(),
            localPref: d(e, "local-preference"),
            med: d(e, "med"),
          });
        }
      }
    }
  }
  return rows;
}

export interface IfaceRow {
  name: string;
  admin: string;
  oper: string;
  address?: string;
}

export function parseInterfacesTerse(json: J): IfaceRow[] {
  const rows: IfaceRow[] = [];
  for (const info of arr(json, "interface-information")) {
    for (const p of arr(info, "physical-interface")) {
      rows.push({ name: d(p, "name") ?? "", admin: d(p, "admin-status") ?? "", oper: d(p, "oper-status") ?? "" });
      for (const l of arr(p, "logical-interface")) {
        const af = arr(l, "address-family").find((x) => d(x, "address-family-name") === "inet");
        rows.push({
          name: d(l, "name") ?? "",
          admin: d(l, "admin-status") ?? "",
          oper: d(l, "oper-status") ?? "",
          address: d(arr(af, "interface-address")[0], "ifa-local"),
        });
      }
    }
  }
  return rows;
}


/** Junos a veces antepone avisos al JSON: buscamos la primera llave. */
export function safeJson(text: string): J {
  const i = text.indexOf("{");
  if (i < 0) throw new Error(`Salida no JSON: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(i));
}
