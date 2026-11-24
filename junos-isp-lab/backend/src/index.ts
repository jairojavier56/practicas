import http from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { env, loadCatalog, ifaceList } from "./config.js";
import { MockDriver } from "./drivers/mock.js";
import { ContainerlabDriver } from "./drivers/containerlab.js";
import type { NetworkDriver } from "./drivers/driver.js";
import * as store from "./store.js";
import { VIEWS, safeJson, type ViewName } from "./junos/parse.js";
import { pushSetConfig } from "./junos/configpush.js";
import { runChecks } from "./validate.js";
import type { LabStatus, ServerEvent } from "./types.js";

const catalog = loadCatalog();
const driver: NetworkDriver = env.driver === "containerlab" ? new ContainerlabDriver(catalog) : new MockDriver();
console.log(`[backend] driver=${driver.name} kinds=${Object.keys(catalog).join(",")}`);

const status = new Map<string, LabStatus>();

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

// ------------------------------------------------------------ API REST
const app = express();
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

app.get("/api/labs/:name/configs/:node", (req, res) => {
  res.type("text/plain").send(store.readNodeConfig(req.params.name, req.params.node) ?? "");
});
app.put("/api/labs/:name/configs/:node", h((req) => store.writeNodeConfig(req.params.name, req.params.node, String(req.body))));

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
  await Promise.all(wanted.map(async (node) => {
    const text = store.readNodeConfig(topo.name, node);
    if (!text) { results[node] = "sin config"; return; }
    try { await pushSetConfig(driver, topo, node, text, log); results[node] = "ok"; }
    catch (e) { results[node] = (e as Error).message; log((e as Error).message); }
  }));
  return results;
}));

app.get("/api/labs/:name/nodes/:node/view/:view", h(async (req) => {
  const v = req.params.view as ViewName;
  if (!(v in VIEWS)) throw new Error("vista desconocida");
  const topo = store.loadTopology(req.params.name);
  const raw = await driver.exec(topo, req.params.node, VIEWS[v].cmd);
  return { rows: VIEWS[v].parse(safeJson(raw)) };
}));

// Solo comandos de lectura desde el panel; para configurar está la consola.
const SAFE_EXEC = /^(show|ping|traceroute)\s[\w\s.\-/:"*]+(\|\s*(match|except|count|no-more|display (json|xml|set|detail))[\w\s.\-/:"*]*)*$/;
app.post("/api/labs/:name/nodes/:node/exec", h(async (req) => {
  const cmd = String(req.body?.cmd ?? "").trim();
  if (!SAFE_EXEC.test(cmd)) throw new Error("solo se permiten show / ping / traceroute (con | match/except/count/display)");
  const finalCmd = /^ping /.test(cmd) && !/count/.test(cmd) ? `${cmd} count 3` : cmd;
  return { output: await driver.exec(store.loadTopology(req.params.name), req.params.node, finalCmd) };
}));

app.post("/api/labs/:name/links/:id", h(async (req) => {
  const topo = store.loadTopology(req.params.name);
  await driver.setLink(topo, req.params.id, !!req.body?.up);
  emit({ type: "links", lab: topo.name, links: await driver.linkStates(topo) });
}));

app.post("/api/labs/:name/validate", h(async (req) => runChecks(driver, store.loadTopology(req.params.name))));

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
