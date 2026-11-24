import type { NetworkDriver } from "./drivers/driver.js";
import type { Check, Topology } from "./types.js";
import { VIEWS, safeJson, type BgpPeerRow, type OspfNbrRow, type IsisAdjRow, type RouteRow } from "./junos/parse.js";

export interface CheckResult { check: Check; ok: boolean; detail: string }

async function view<T>(driver: NetworkDriver, topo: Topology, node: string, v: keyof typeof VIEWS, extra = ""): Promise<T[]> {
  const spec = VIEWS[v];
  const cmd = extra ? spec.cmd.replace(" | display json", ` ${extra} | display json`) : spec.cmd;
  return spec.parse(safeJson(await driver.exec(topo, node, cmd))) as T[];
}

/** Ejecuta las validaciones del lab guiado contra los equipos (reales o mock). */
export async function runChecks(driver: NetworkDriver, topo: Topology, checks: Check[] = topo.checks ?? []): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  let links: Awaited<ReturnType<NetworkDriver["linkStates"]>> | undefined;
  for (const c of checks) {
    try {
      switch (c.type) {
        case "bgp-established": {
          const p = (await view<BgpPeerRow>(driver, topo, c.node, "bgp")).find((x) => x.peer === c.peer);
          out.push({ check: c, ok: p?.state === "Established", detail: p ? `estado ${p.state}` : "vecino no configurado" });
          break;
        }
        case "ospf-full": {
          const n = (await view<OspfNbrRow>(driver, topo, c.node, "ospf")).filter((x) => x.state === "Full").length;
          out.push({ check: c, ok: n >= c.minNeighbors, detail: `${n} vecinos Full` });
          break;
        }
        case "isis-up": {
          const n = (await view<IsisAdjRow>(driver, topo, c.node, "isis")).filter((x) => x.state === "Up").length;
          out.push({ check: c, ok: n >= c.minAdjacencies, detail: `${n} adyacencias Up` });
          break;
        }
        case "route-present": {
          const rs = (await view<RouteRow>(driver, topo, c.node, "routes", `${c.prefix} exact`))
            .filter((r) => r.prefix === c.prefix && r.active && (!c.protocol || r.protocol.toLowerCase() === c.protocol.toLowerCase()));
          out.push({ check: c, ok: rs.length > 0, detail: rs[0] ? `${rs[0].protocol} via ${rs[0].nextHop ?? rs[0].via ?? "-"}` : "no está en inet.0 (activa)" });
          break;
        }
        case "route-aspath": {
          const r = (await view<RouteRow>(driver, topo, c.node, "routes", `${c.prefix} exact`)).find((x) => x.prefix === c.prefix && x.active);
          out.push({ check: c, ok: !!r?.asPath?.includes(c.contains), detail: r ? `AS path: ${r.asPath ?? "(vacío)"}` : "ruta no encontrada" });
          break;
        }
        case "route-via": {
          // Interfaz de salida de la ruta activa (vale igual para eBGP directo que para iBGP resuelto por IGP)
          const r = (await view<RouteRow>(driver, topo, c.node, "routes", `${c.prefix} exact`)).find((x) => x.prefix === c.prefix && x.active);
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
