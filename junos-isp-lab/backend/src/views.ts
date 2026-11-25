/**
 * Vistas por sistema operativo: qué comando lanzar y cómo leer su salida.
 * Junos usa `| display json`; IOS se parsea en texto. Ambos devuelven las
 * mismas filas, así que inspector, validaciones y estado en vivo son comunes.
 */
import {
  safeJson, parseBgpSummary, parseOspfNeighbors, parseIsisAdjacency, parseLdpSessions, parseRoutes, parseInterfacesTerse,
} from "./junos/parse.js";
import { iosBgpSummary, iosOspfNeighbors, iosIsisNeighbors, iosLdpNeighbors, iosRoutes, iosInterfaces } from "./ios/parse.js";

export const VIEW_NAMES = ["bgp", "ospf", "isis", "ldp", "routes", "interfaces"] as const;
export type ViewName = (typeof VIEW_NAMES)[number];
export interface ViewOpts { vrf?: string }
export interface ViewSpec { cmd: (o: ViewOpts) => string; parse: (raw: string, o: ViewOpts) => unknown[] }

const junosTable = (o: ViewOpts) => (o.vrf ? `${o.vrf}.inet.0` : "inet.0");

const JUNOS: Record<ViewName, ViewSpec> = {
  bgp: { cmd: () => "show bgp summary | display json", parse: (r) => parseBgpSummary(safeJson(r)) },
  ospf: { cmd: () => "show ospf neighbor | display json", parse: (r) => parseOspfNeighbors(safeJson(r)) },
  isis: { cmd: () => "show isis adjacency | display json", parse: (r) => parseIsisAdjacency(safeJson(r)) },
  ldp: { cmd: () => "show ldp session | display json", parse: (r) => parseLdpSessions(safeJson(r)) },
  routes: { cmd: (o) => `show route table ${junosTable(o)} | display json`, parse: (r) => parseRoutes(safeJson(r)) },
  interfaces: { cmd: () => "show interfaces terse | display json", parse: (r) => parseInterfacesTerse(safeJson(r)) },
};

const IOS: Record<ViewName, ViewSpec> = {
  bgp: { cmd: () => "show bgp all summary", parse: (r) => iosBgpSummary(r) },
  ospf: { cmd: () => "show ip ospf neighbor", parse: (r) => iosOspfNeighbors(r) },
  isis: { cmd: () => "show isis neighbors", parse: (r) => iosIsisNeighbors(r) },
  ldp: { cmd: () => "show mpls ldp neighbor", parse: (r) => iosLdpNeighbors(r) },
  routes: { cmd: (o) => (o.vrf ? `show ip route vrf ${o.vrf}` : "show ip route"), parse: (r, o) => iosRoutes(r, o.vrf ?? "inet.0") },
  interfaces: { cmd: () => "show ip interface brief", parse: (r) => iosInterfaces(r) },
};

export function viewsFor(os: string): Record<ViewName, ViewSpec> | null {
  return os === "junos" ? JUNOS : os === "ios" ? IOS : null;
}
