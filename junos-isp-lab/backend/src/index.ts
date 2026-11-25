import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { env, loadCatalog, ifaceList } from "./config.js";
import { MockDriver } from "./drivers/mock.js";
import { ContainerlabDriver } from "./drivers/containerlab.js";
import type { NetworkDriver } from "./drivers/driver.js";
import * as store from "./store.js";
import { pushSetConfig } from "./junos/configpush.js";
import { pushIosConfig } from "./ios/configpush.js";
import { runChecks, nodeView } from "./validate.js";
import { VIEW_NAMES, viewsFor, type ViewName } from "./views.js";
import type { Check, LabStatus, ProtoBgp, ProtoOspf, ServerEvent, Topology } from "./types.js";
import type { BgpPeerRow, OspfNbrRow, IsisAdjRow, LdpRow } from "./junos/parse.js";

const catalog = loadCatalog();
const driver: NetworkDriver = env.driver === "containerlab" ? new ContainerlabDriver(catalog) : new MockDriver();
console.log(`[backend] driver=${driver.name} kinds=${Object.keys(catalog).join(",")}`);

const status = new Map<string, LabStatus>();
/** Sistema operativo de un nodo (junos, ios, frr, linux) según su kind del catálogo. */
const osOfTopo = (topo: Topology) => (node: string) => catalog[topo.nodes.find((n) => n.id === node)?.kind ?? ""]?.os ?? "linux";

// ------------------------------------------------------------ eventos (WS)
const eventClients = new Set<WebSocket>();
function emit(ev: ServerEvent) {
  const msg = JSON.stringify(ev);
  for (const c of eventClients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}
const logger = (lab: string) => (line: string) => { console.log(`[${lab}] ${line}`); emit({ type: "log", lab, line }); };
const setStatus = (lab: string, s: LabStatus, message?: string) => { status.set(lab, s); emit({ type: "status", lab, status: s, message }); };

// Sondeo de enlaces de labs en ejecución
setInterval(async () => {
  for (const [lab, s] of status) {
    if (s !== "running") continue;
    try { emit({ type: "links", lab, links: await driver.linkStates(store.loadTopology(lab)) }); } catch { /* ignora */ }
  }
}, 4000);

// Sondeo de protocolos: pregunta a los routers Junos/IOS por BGP, OSPF, IS-IS y LDP y emite los cambios
// como eventos ("BGP a-pe1 → 10.0.0.2: Active → Established"). PROTO_POLL_SEC=0 lo desactiva.
const protoPoll = Number(process.env.PROTO_POLL_SEC ?? 5) * 1000;
const lastProto = new Map<string, Map<string, string>>();
async function pollProto(topo: Topology) {
  const bgp: ProtoBgp[] = [], ospf: ProtoOspf[] = [];
  const osOf = osOfTopo(topo);
  await Promise.all(topo.nodes.filter((n) => viewsFor(osOf(n.id))).map(async (n) => {
    const get = async <T,>(v: ViewName) => { try { return await nodeView<T>(driver, topo, osOf, n.id, v); } catch { return [] as T[]; } };
    const [b, o, i, l] = await Promise.all([get<BgpPeerRow>("bgp"), get<OspfNbrRow>("ospf"), get<IsisAdjRow>("isis"), get<LdpRow>("ldp")]);
    b.forEach((x) => bgp.push({ node: n.id, peer: x.peer, asn: x.asn, state: x.state }));
    o.forEach((x) => ospf.push({ node: n.id, iface: x.iface, neighbor: x.address, state: x.state, proto: "OSPF" }));
    i.forEach((x) => ospf.push({ node: n.id, iface: x.iface, neighbor: x.system, state: x.state, proto: "IS-IS" }));
    l.forEach((x) => ospf.push({ node: n.id, iface: "", neighbor: x.neighbor, state: x.state, proto: "LDP" }));
  }));
  const now = new Map<string, string>([
    ...bgp.map((x) => [`BGP ${x.node} → ${x.peer}`, x.state] as [string, string]),
    ...ospf.map((x) => [`${x.proto} ${x.node} ${x.iface || "→"} ${x.proto === "OSPF" ? "" : x.neighbor}`.replace(/\s+/g, " ").trim(), x.state] as [string, string]),
  ]);
  const prev = lastProto.get(topo.name);
  if (prev) {
    for (const [k, v] of now) if (prev.get(k) !== v) emit({ type: "log", lab: topo.name, line: `[estado] ${k}: ${prev.get(k) ?? "—"} → ${v}` });
    for (const [k, v] of prev) if (!now.has(k)) emit({ type: "log", lab: topo.name, line: `[estado] ${k}: ${v} → Down` });
  }
  lastProto.set(topo.name, now);
  emit({ type: "proto", lab: topo.name, bgp, ospf });
}
if (protoPoll > 0) {
  let busyPoll = false;
  setInterval(async () => {
    if (busyPoll) return;
    busyPoll = true;
    try {
      for (const [lab, s] of status) if (s === "running") await pollProto(store.loadTopology(lab)).catch(() => {});
    } finally { busyPoll = false; }
  }, protoPoll);
}

// ------------------------------------------------------------ API REST
const app = express();

// Autenticación básica opcional (la activa la appliance/ISO con WEB_PASSWORD en .env).
const WEB_USER = process.env.WEB_USER ?? "lab";
const WEB_PASSWORD = process.env.WEB_PASSWORD ?? "";
function authorized(header: string | undefined) {
  if (!WEB_PASSWORD) return true;
  const want = Buffer.from(`Basic ${Buffer.from(`${WEB_USER}:${WEB_PASSWORD}`).toString("base64")}`);
  const got = Buffer.from(header ?? "");
  return got.length === want.length && timingSafeEqual(got, want);
}
app.use((req, res, next) => {
  if (authorized(req.headers.authorization)) return next();
  res.set("WWW-Authenticate", 'Basic realm="Junos ISP Lab", charset="UTF-8"').status(401).send("Autenticación requerida");
});
app.use(express.json({ limit: "2mb" }));
app.use(express.text({ limit: "2mb" }));

const h = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).then((r) => { if (!res.headersSent) res.json(r ?? { ok: true }); }).catch(next);

app.get("/api/info", h(() => ({ driver: driver.name, ramBudgetMB: env.ramBudgetMB, vcpuBudget: env.vcpuBudget })));

app.get("/api/catalog", h(() =>
  Object.fromEntries(Object.entries(catalog).map(([k, v]) => [k, {
    label: v.label, os: v.os, icon: v.icon, resources: v.resources, bootTimeSec: v.bootTimeSec, interfaces: ifaceList(v),
  }]))));

app.get("/api/topologies", h(() => store.listTopologies()));
app.get("/api/topologies/:name", h((req) => store.loadTopology(req.params.name)));
app.put("/api/topologies/:name", h((req) => {
  const t = store.saveTopology({ ...req.body, name: req.params.name });
  for (const n of t.nodes) if (!catalog[n.kind]) throw new Error(`kind ${n.kind} no está en el catálogo`);
  return t;
}));

app.get("/api/templates", h(() => store.listTemplates()));
app.post("/api/templates/:id/instantiate", h((req) => store.instantiateTemplate(req.params.id)));

const osOfLab = (lab: string, node: string) => osOfTopo(store.loadTopology(lab))(node);
app.get("/api/labs/:name/configs/:node", (req, res) => {
  res.type("text/plain").send(store.readNodeConfig(req.params.name, req.params.node, osOfLab(req.params.name, req.params.node)) ?? "");
});
app.put("/api/labs/:name/configs/:node", h((req) => store.writeNodeConfig(req.params.name, req.params.node, String(req.body), osOfLab(req.params.name, req.params.node))));

app.get("/api/labs/:name/status", h((req) => ({ status: status.get(req.params.name) ?? "stopped" })));

app.post("/api/labs/:name/deploy", h((req) => {
  const topo = store.loadTopology(req.params.name);
  const ram = topo.nodes.reduce((a, n) => a + catalog[n.kind].resources.ramMB, 0);
  const cpu = topo.nodes.reduce((a, n) => a + catalog[n.kind].resources.vcpu, 0);
  if (ram > env.ramBudgetMB) throw new Error(`El lab necesita ~${ram} MB de RAM y el presupuesto es ${env.ramBudgetMB} MB. Usa nodos ligeros (cRPD/FRR) para los ASes de relleno.`);
  if (cpu > env.vcpuBudget * 2) throw new Error(`El lab pide ${cpu} vCPU (presupuesto ${env.vcpuBudget}, se permite 2x overcommit).`);
  if (status.get(topo.name) === "deploying") throw new Error("ya se está desplegando");
  setStatus(topo.name, "deploying", `~${ram} MB RAM, ${cpu} vCPU`);
  driver.deploy(topo, logger(topo.name))
    .then(() => setStatus(topo.name, "running"))
    .catch((e) => setStatus(topo.name, "error", e.message));
  return { accepted: true, ramMB: ram, vcpu: cpu };
}));

app.post("/api/labs/:name/destroy", h((req) => {
  const topo = store.loadTopology(req.params.name);
  setStatus(topo.name, "destroying");
  driver.destroy(topo, logger(topo.name))
    .then(() => setStatus(topo.name, "stopped"))
    .catch((e) => setStatus(topo.name, "error", e.message));
  return { accepted: true };
}));

app.post("/api/labs/:name/apply-configs", h(async (req) => {
  const topo = store.loadTopology(req.params.name);
  const wanted: string[] = req.body?.nodes ?? topo.nodes.map((n) => n.id);
  const log = logger(topo.name);
  const results: Record<string, string> = {};
  // en paralelo: cada nodo tiene su propia consola
  const osOf = osOfTopo(topo);
  await Promise.all(wanted.map(async (node) => {
    const os = osOf(node);
    if (os === "frr" || os === "linux") { results[node] = "se carga al desplegar"; return; }
    const text = store.readNodeConfig(topo.name, node, os);
    if (!text) { results[node] = "sin config"; return; }
    try {
      if (os === "ios") await pushIosConfig(driver, topo, node, text, log);
      else await pushSetConfig(driver, topo, node, text, log);
      results[node] = "ok";
    } catch (e) { results[node] = (e as Error).message; log((e as Error).message); }
  }));
  return results;
}));

app.get("/api/labs/:name/nodes/:node/view/:view", h(async (req) => {
  const v = req.params.view as ViewName;
  if (!VIEW_NAMES.includes(v)) throw new Error("vista desconocida");
  const topo = store.loadTopology(req.params.name);
  const vrf = typeof req.query.vrf === "string" && /^[\w-]{1,32}$/.test(req.query.vrf) ? req.query.vrf : undefined;
  return { rows: await nodeView(driver, topo, osOfTopo(topo), req.params.node, v, { vrf }) };
}));

// Solo comandos de lectura desde el panel; para configurar está la consola.
// Junos: | match/except/count/display …   IOS: | include/exclude/begin/section
const SAFE_EXEC = /^(show|ping|traceroute)\s[\w\s.\-/:"*]+(\|\s*(match|except|count|no-more|display (json|xml|set|detail)|include|exclude|begin|section|i|e|b|s)\b[\w\s.\-/:"*]*)*$/;
app.post("/api/labs/:name/nodes/:node/exec", h(async (req) => {
  const cmd = String(req.body?.cmd ?? "").trim();
  if (!SAFE_EXEC.test(cmd)) throw new Error("solo se permiten show / ping / traceroute (con | match/include/…)");
  const topo = store.loadTopology(req.params.name);
  const ios = osOfTopo(topo)(req.params.node) === "ios";
  const finalCmd = /^ping /.test(cmd) && !/(count|repeat)/.test(cmd) ? `${cmd} ${ios ? "repeat" : "count"} 3` : cmd;
  return { output: await driver.exec(topo, req.params.node, finalCmd) };
}));

app.post("/api/labs/:name/links/:id", h(async (req) => {
  const topo = store.loadTopology(req.params.name);
  await driver.setLink(topo, req.params.id, !!req.body?.up);
  emit({ type: "links", lab: topo.name, links: await driver.linkStates(topo) });
}));

app.post("/api/labs/:name/validate", h(async (req) => { const t = store.loadTopology(req.params.name); return runChecks(driver, t, osOfTopo(t)); }));
// Comprobaciones arbitrarias (las usa la lección para saber si un paso está cumplido)
app.post("/api/labs/:name/check", h(async (req) => { const t = store.loadTopology(req.params.name); return runChecks(driver, t, osOfTopo(t), (req.body?.checks ?? []) as Check[]); }));

// Frontend compilado (modo producción)
if (existsSync(env.frontendDist)) {
  app.use(express.static(env.frontendDist));
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(env.frontendDist, "index.html")));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(400).json({ error: err.message });
});

// ------------------------------------------------------------ WebSockets
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (!authorized(req.headers.authorization)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); return socket.destroy(); }
  if (url.pathname !== "/ws/events" && url.pathname !== "/ws/console") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === "/ws/events") {
      eventClients.add(ws);
      for (const [lab, s] of status) ws.send(JSON.stringify({ type: "status", lab, status: s }));
      ws.on("close", () => eventClients.delete(ws));
      return;
    }
    // /ws/console?lab=x&node=y&cols=120&rows=30
    // Protocolo: binario/texto crudo = teclas; JSON {"resize":[cols,rows]} = redimensionar
    const lab = url.searchParams.get("lab") ?? "";
    const node = url.searchParams.get("node") ?? "";
    try {
      const topo = store.loadTopology(lab);
      if (status.get(lab) !== "running") throw new Error("el lab no está en ejecución (Deploy primero)");
      const s = driver.openConsole(topo, node, Number(url.searchParams.get("cols") ?? 120), Number(url.searchParams.get("rows") ?? 30));
      s.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(d));
      s.onExit(() => ws.close());
      ws.on("message", (m, isBinary) => {
        const text = m.toString();
        if (!isBinary && text.startsWith("{\"resize\"")) {
          const [c, r] = JSON.parse(text).resize;
          s.resize(c, r);
        } else s.write(text);
      });
      ws.on("close", () => s.close());
    } catch (e) {
      ws.send(`\r\n\x1b[31m${(e as Error).message}\x1b[0m\r\n`);
      ws.close();
    }
  });
});

const HOST = process.env.HOST ?? "127.0.0.1"; // la consola da acceso root a los nodos: no expongas sin auth
server.listen(env.port, HOST, () => console.log(`[backend] http://${HOST}:${env.port}`));
