import type { Catalog, Check, CheckResult, ServerEvent, Topology } from "./types";

async function req<T>(method: string, url: string, body?: unknown, text = false): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": typeof body === "string" ? "text/plain" : "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(e.error ?? r.statusText);
  }
  return (text ? r.text() : r.json()) as Promise<T>;
}

const lab = (name: string) => `/api/labs/${encodeURIComponent(name)}`;

export const api = {
  info: () => req<{ driver: string; ramBudgetMB: number; vcpuBudget: number }>("GET", "/api/info"),
  catalog: () => req<Catalog>("GET", "/api/catalog"),
  topologies: () => req<string[]>("GET", "/api/topologies"),
  topology: (n: string) => req<Topology>("GET", `/api/topologies/${n}`),
  saveTopology: (t: Topology) => req<Topology>("PUT", `/api/topologies/${t.name}`, t),
  templates: () => req<{ id: string; name: string; description?: string }[]>("GET", "/api/templates"),
  instantiate: (id: string) => req<Topology>("POST", `/api/templates/${id}/instantiate`),
  status: (n: string) => req<{ status: string }>("GET", `${lab(n)}/status`),
  deploy: (n: string) => req<{ ramMB: number; vcpu: number }>("POST", `${lab(n)}/deploy`),
  destroy: (n: string) => req("POST", `${lab(n)}/destroy`),
  applyConfigs: (n: string, nodes?: string[]) => req<Record<string, string>>("POST", `${lab(n)}/apply-configs`, { nodes }),
  getConfig: (n: string, node: string) => req<string>("GET", `${lab(n)}/configs/${node}`, undefined, true),
  putConfig: (n: string, node: string, text: string) => req("PUT", `${lab(n)}/configs/${node}`, text),
  view: <T,>(n: string, node: string, v: string, vrf?: string) => req<{ rows: T[] }>("GET", `${lab(n)}/nodes/${node}/view/${v}${vrf ? `?vrf=${encodeURIComponent(vrf)}` : ""}`),
  exec: (n: string, node: string, cmd: string) => req<{ output: string }>("POST", `${lab(n)}/nodes/${node}/exec`, { cmd }),
  setLink: (n: string, id: string, up: boolean) => req("POST", `${lab(n)}/links/${id}`, { up }),
  validate: (n: string) => req<CheckResult[]>("POST", `${lab(n)}/validate`),
  check: (n: string, checks: Check[]) => req<CheckResult[]>("POST", `${lab(n)}/check`, { checks }),
};

const wsBase = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

export function connectEvents(onEvent: (e: ServerEvent) => void): () => void {
  let ws: WebSocket | null = null;
  let stop = false;
  const open = () => {
    ws = new WebSocket(`${wsBase()}/ws/events`);
    ws.onmessage = (m) => onEvent(JSON.parse(m.data));
    ws.onclose = () => { if (!stop) setTimeout(open, 2000); };
  };
  open();
  return () => { stop = true; ws?.close(); };
}

export const consoleUrl = (labName: string, node: string, cols: number, rows: number) =>
  `${wsBase()}/ws/console?lab=${encodeURIComponent(labName)}&node=${encodeURIComponent(node)}&cols=${cols}&rows=${rows}`;
