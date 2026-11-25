import type { NetworkDriver } from "./drivers/driver.js";
import type { Check, Topology } from "./types.js";
import type { BgpPeerRow, OspfNbrRow, IsisAdjRow, LdpRow, RouteRow } from "./junos/parse.js";
import { viewsFor, type ViewName, type ViewOpts } from "./views.js";

export interface CheckResult { check: Check; ok: boolean; detail: string }

/** Ejecuta una vista (bgp, ospf, rutas…) en un nodo, con el comando de su sistema operativo. */
export async function nodeView<T>(driver: NetworkDriver, topo: Topology, osOf: (node: string) => string, node: string, v: ViewName, o: ViewOpts = {}): Promise<T[]> {
  const views = viewsFor(osOf(node));
  if (!views) throw new Error(`el nodo ${node} no es Junos ni IOS: usa la pestaña Comando`);
  const raw = await driver.exec(topo, node, views[v].cmd(o));
  return views[v].parse(raw, o) as T[];
}

const sameProto = (a: string, b?: string) => !b || a.toLowerCase().replace("-", "") === b.toLowerCase().replace("-", "");

/** Ejecuta comprobaciones contra los equipos (reales o mock), Junos o IOS. */
export async function runChecks(driver: NetworkDriver, topo: Topology, osOf: (node: string) => string, checks: Check[] = topo.checks ?? []): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  let links: Awaited<ReturnType<NetworkDriver["linkStates"]>> | undefined;
  const v = <T,>(node: string, name: ViewName, o: ViewOpts = {}) => nodeView<T>(driver, topo, osOf, node, name, o);
  const route = async (node: string, prefix: string, vrf?: string) =>
    (await v<RouteRow>(node, "routes", { vrf })).filter((x) => x.prefix === prefix && x.active);

  for (const c of checks) {
    try {
      switch (c.type) {
        case "bgp-established": {
          const p = (await v<BgpPeerRow>(c.node, "bgp")).find((x) => x.peer === c.peer);
          out.push({ check: c, ok: p?.state === "Established", detail: p ? `estado ${p.state}` : "vecino no configurado" });
          break;
        }
        case "ospf-full": {
          const n = (await v<OspfNbrRow>(c.node, "ospf")).filter((x) => x.state === "Full").length;
          out.push({ check: c, ok: n >= c.minNeighbors, detail: `${n} vecinos Full` });
          break;
        }
        case "isis-up": {
          const n = (await v<IsisAdjRow>(c.node, "isis")).filter((x) => x.state === "Up").length;
          out.push({ check: c, ok: n >= c.minAdjacencies, detail: `${n} adyacencias Up` });
          break;
        }
        case "ldp-up": {
          const n = (await v<LdpRow>(c.node, "ldp")).filter((x) => x.state === "Operational").length;
          out.push({ check: c, ok: n >= c.minSessions, detail: `${n} sesiones LDP operativas` });
          break;
        }
        case "route-present": {
          const rs = (await route(c.node, c.prefix, c.vrf)).filter((r) => sameProto(r.protocol, c.protocol));
          out.push({ check: c, ok: rs.length > 0, detail: rs[0] ? `${rs[0].protocol} via ${rs[0].nextHop ?? rs[0].via ?? "-"}` : `no está en ${c.vrf ?? "la tabla global"}` });
          break;
        }
        case "route-absent": {
          const rs = await route(c.node, c.prefix, c.vrf);
          out.push({ check: c, ok: rs.length === 0, detail: rs.length ? `sigue presente (${rs[0].protocol})` : "ya no está" });
          break;
        }
        case "route-aspath": {
          const r = (await route(c.node, c.prefix, c.vrf))[0];
          out.push({ check: c, ok: !!r?.asPath?.includes(c.contains), detail: r ? `AS path: ${r.asPath ?? "(n/d en IOS: usa show bgp)"}` : "ruta no encontrada" });
          break;
        }
        case "route-via": {
          const r = (await route(c.node, c.prefix, c.vrf))[0];
          out.push({ check: c, ok: r?.via === c.via, detail: r ? `sale por ${r.via ?? "-"} (${r.protocol})` : "ruta no encontrada" });
          break;
        }
        case "link-state": {
          links ??= await driver.linkStates(topo);
          const l = links.find((x) => x.id === c.link);
          out.push({ check: c, ok: l?.state === c.state, detail: `enlace ${c.link}: ${l?.state ?? "desconocido"}` });
          break;
        }
      }
    } catch (e) {
      out.push({ check: c, ok: false, detail: `error: ${(e as Error).message.slice(0, 200)}` });
    }
  }
  return out;
}
