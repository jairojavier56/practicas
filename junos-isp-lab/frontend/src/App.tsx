import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, Controls, ConnectionMode,
  useReactFlow, applyNodeChanges, type Edge, type NodeChange, type EdgeChange, type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, connectEvents } from "./api";
import { RouterNode, groupColors, type RouterNodeType } from "./components/RouterNode";
import { TerminalPane } from "./components/TerminalPane";
import { Inspector } from "./components/Inspector";
import { Lesson } from "./components/Lesson";
import type { Catalog, CheckResult, LabStatus, LinkStateValue, ProtoBgp, ProtoOspf, Topology } from "./types";

const nodeTypes = { router: RouterNode };
const emptyTopo = (name: string): Topology => ({ name, nodes: [], links: [] });

function Editor() {
  const rf = useReactFlow();
  const [catalog, setCatalog] = useState<Catalog>({});
  const [info, setInfo] = useState<{ driver: string; ramBudgetMB: number; vcpuBudget: number }>();
  const [labs, setLabs] = useState<string[]>([]);
  const [templates, setTemplates] = useState<{ id: string; name: string; description?: string }[]>([]);
  const [topo, setTopo] = useState<Topology>(emptyTopo("mi-lab"));
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<Record<string, LabStatus>>({});
  const [linkStates, setLinkStates] = useState<Record<string, LinkStateValue>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [proto, setProto] = useState<{ bgp: ProtoBgp[]; ospf: ProtoOspf[] }>({ bgp: [], ospf: [] });
  const [selected, setSelected] = useState<{ type: "node" | "link"; id: string } | null>(null);
  const [terms, setTerms] = useState<string[]>([]);
  const [activeTerm, setActiveTerm] = useState<string | null>(null);
  const [side, setSide] = useState<"inspector" | "guia" | "log">("inspector");
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");
  const topoRef = useRef(topo);
  topoRef.current = topo;
  const openTermRef = useRef<(id: string) => void>(() => {});

  const labStatus = status[topo.name] ?? "stopped";
  const running = labStatus === "running";
  const locked = labStatus !== "stopped" && labStatus !== "error"; // no editar topología con el lab vivo

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(""), 5000); };
  const guard = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try { await fn(); } catch (e) { flash((e as Error).message); } finally { setBusy(""); }
  };

  // --- carga inicial + eventos
  useEffect(() => {
    api.catalog().then(setCatalog);
    api.info().then(setInfo);
    api.templates().then(setTemplates);
    api.topologies().then((l) => { setLabs(l); if (l[0]) openLab(l[0]); });
    return connectEvents((e) => {
      if (e.type === "status") {
        setStatus((s) => ({ ...s, [e.lab]: e.status }));
        if (e.message) setLogs((l) => [...l.slice(-500), `[${e.lab}] ${e.status}: ${e.message}`]);
      } else if (e.type === "log") setLogs((l) => [...l.slice(-500), `[${e.lab}] ${e.line}`]);
      else if (e.type === "proto" && e.lab === topoRef.current.name) setProto({ bgp: e.bgp, ospf: e.ospf });
      else if (e.type === "links" && e.lab === topoRef.current.name)
        setLinkStates(Object.fromEntries(e.links.map((x) => [x.id, x.state])));
    });
  }, []); // eslint-disable-line

  const openLab = async (name: string) => {
    const t = await api.topology(name);
    setTopo(t); setDirty(false); setSelected(null); setChecks(null); setLinkStates({}); setProto({ bgp: [], ospf: [] });
    setTimeout(() => rf.fitView({ padding: 0.15, duration: 300 }), 150);
    setTerms([]); setActiveTerm(null);
    const s = await api.status(name);
    setStatus((x) => ({ ...x, [name]: s.status as LabStatus }));
  };

  const update = (t: Topology) => { setTopo(t); setDirty(true); };
  const save = async () => {
    const t = await api.saveTopology(topoRef.current);
    setDirty(false);
    setLabs((l) => (l.includes(t.name) ? l : [...l, t.name]));
  };

  // autoguardado
  useEffect(() => {
    if (!dirty) return;
    const h = setTimeout(() => save().catch((e) => flash(e.message)), 800);
    return () => clearTimeout(h);
  }, [topo, dirty]); // eslint-disable-line

  // --- React Flow: nodos y aristas derivados de la topología
  // Estado propio de React Flow (conserva `measured`/`selected`); la topología es la fuente de verdad del resto.
  const [nodes, setNodes] = useState<RouterNodeType[]>([]);
  const colorOf = useMemo(() => groupColors(topo.nodes.map((n) => n.group)), [topo.nodes]);
  useEffect(() => {
    setNodes((prev) => topo.nodes.map((n) => {
      const old = prev.find((p) => p.id === n.id);
      return {
        ...old, id: n.id, type: "router" as const, position: n.position,
        data: { label: n.label ?? n.id, kind: n.kind, kindInfo: catalog[n.kind], asn: n.asn, group: n.group, color: colorOf(n.group), running, onOpen: (id: string) => openTermRef.current(id) },
      };
    }));
  }, [topo.nodes, catalog, running, colorOf]);

  const edges: Edge[] = useMemo(() => topo.links.map((l) => {
    const st = running ? (linkStates[l.id] ?? "unknown") : "unknown";
    const color = st === "up" ? "var(--ok)" : st === "down" ? "var(--bad)" : "var(--muted)";
    return {
      id: l.id, source: l.a.node, target: l.b.node, type: "straight",
      ...facingHandles(topo.nodes.find((n) => n.id === l.a.node)?.position, topo.nodes.find((n) => n.id === l.b.node)?.position),
      selected: selected?.type === "link" && selected.id === l.id,
      label: `${shortIf(l.a.iface)} ⟷ ${shortIf(l.b.iface)}`,
      labelStyle: { fill: "var(--fg)", fontSize: 11, fontFamily: "ui-monospace, monospace" },
      labelBgStyle: { fill: "var(--panel)" },
      style: { stroke: color, strokeWidth: 2.5, strokeDasharray: st === "down" ? "6 4" : undefined },
    };
  }), [topo.links, topo.nodes, linkStates, running, selected]);

  const onNodesChange = useCallback((changes: NodeChange<RouterNodeType>[]) => {
    setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== "remove" || !locked), ns));
    let t = topoRef.current;
    let changed = false;
    for (const c of changes) {
      if (c.type === "position" && c.position) {
        t = { ...t, nodes: t.nodes.map((n) => (n.id === c.id ? { ...n, position: c.position! } : n)) };
        changed = true;
      } else if (c.type === "select" && c.selected) setSelected({ type: "node", id: c.id });
      else if (c.type === "remove" && !locked) {
        t = { ...t, nodes: t.nodes.filter((n) => n.id !== c.id), links: t.links.filter((l) => l.a.node !== c.id && l.b.node !== c.id) };
        changed = true;
      }
    }
    if (changed) update(t);
  }, [locked]); // eslint-disable-line

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    let t = topoRef.current;
    for (const c of changes) {
      if (c.type === "select" && c.selected) setSelected({ type: "link", id: c.id });
      if (c.type === "remove" && !locked) t = { ...t, links: t.links.filter((l) => l.id !== c.id) };
    }
    if (t !== topoRef.current) update(t);
  }, [locked]); // eslint-disable-line

  /** Al conectar dos routers se asigna la primera interfaz libre de cada uno (editable en el inspector). */
  const onConnect = useCallback((c: Connection) => {
    if (locked) return flash("Destruye el lab para cambiar el cableado.");
    const t = topoRef.current;
    if (!c.source || !c.target || c.source === c.target) return;
    const free = (node: string) => {
      const kind = catalog[t.nodes.find((n) => n.id === node)!.kind];
      const used = new Set(t.links.flatMap((l) => [l.a, l.b]).filter((e) => e.node === node).map((e) => e.iface));
      return kind?.interfaces.find((i) => !used.has(i));
    };
    const ia = free(c.source), ib = free(c.target);
    if (!ia || !ib) return flash("No quedan interfaces libres en uno de los equipos.");
    let i = 1;
    while (t.links.some((l) => l.id === `l${i}`)) i++;
    const link = { id: `l${i}`, a: { node: c.source, iface: ia }, b: { node: c.target, iface: ib } };
    update({ ...t, links: [...t.links, link] });
    setSelected({ type: "link", id: link.id });
  }, [catalog, locked]); // eslint-disable-line

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const kind = e.dataTransfer.getData("application/x-kind");
    if (!kind || locked) return;
    const t = topoRef.current;
    let i = 1;
    while (t.nodes.some((n) => n.id === `r${i}`)) i++;
    const position = rf.screenToFlowPosition({ x: e.clientX - 50, y: e.clientY - 30 });
    update({ ...t, nodes: [...t.nodes, { id: `r${i}`, kind, position }] });
  };

  const openTerminal = (node: string) => {
    if (!running) return flash("Despliega el lab para abrir consolas.");
    setTerms((t) => (t.includes(node) ? t : [...t, node]));
    setActiveTerm(node);
  };

  openTermRef.current = openTerminal;

  const ram = topo.nodes.reduce((a, n) => a + (catalog[n.kind]?.resources.ramMB ?? 0), 0);
  const groups = [...new Set(topo.nodes.map((n) => n.group).filter(Boolean))] as string[];

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">⬢ Junos ISP Lab</strong>
        <select value={topo.name} onChange={(e) => openLab(e.target.value)}>
          {[...new Set([...labs, topo.name])].map((l) => <option key={l}>{l}</option>)}
        </select>
        <button onClick={() => {
          const n = prompt("Nombre del lab (minúsculas, números, guiones):", "lab-" + (labs.length + 1));
          if (n) { setTopo(emptyTopo(n)); setDirty(true); setSelected(null); setTerms([]); }
        }}>Nuevo</button>
        <select value="" onChange={(e) => e.target.value && guard("Cargando plantilla", async () => {
          const t = await api.instantiate(e.target.value);
          setLabs((l) => (l.includes(t.name) ? l : [...l, t.name]));
          await openLab(t.name);
          setSide("guia");
        })}>
          <option value="">Laboratorios guiados…</option>
          {templates.map((t) => <option key={t.id} value={t.id} title={t.description}>{t.name}</option>)}
        </select>
        <span className="sep" />
        <button className="primary" disabled={locked || !topo.nodes.length || !!busy}
          onClick={() => guard("Desplegando", async () => { await save(); await api.deploy(topo.name); setSide("log"); })}>▶ Deploy</button>
        <button disabled={labStatus === "stopped" || !!busy} onClick={() => confirm(`¿Destruir ${topo.name}?`) && guard("Destruyendo", () => api.destroy(topo.name))}>■ Destroy</button>
        <button disabled={!running || !!busy} onClick={() => guard("Aplicando configs", async () => {
          const r = await api.applyConfigs(topo.name);
          flash(Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(" · "));
        })}>⇪ Cargar configs</button>
        <button disabled={!running || !!busy} onClick={() => guard("Validando", async () => { setChecks(await api.validate(topo.name)); setSide("guia"); })}>✓ Validar</button>
        <span className={`badge ${labStatus}`}>{labStatus}</span>
        {busy && <span className="muted">{busy}…</span>}
        <span className="grow" />
        <span className={`muted ${info && ram > info.ramBudgetMB ? "bad" : ""}`} title="RAM estimada del lab / presupuesto del host">
          RAM {(ram / 1024).toFixed(1)} / {((info?.ramBudgetMB ?? 0) / 1024).toFixed(0)} GB
        </span>
        <span className="badge">{info?.driver}</span>
      </header>

      <aside className="palette">
        <h4>Equipos</h4>
        {Object.entries(catalog).map(([k, v]) => (
          <div key={k} className="palette-item" draggable onDragStart={(e) => e.dataTransfer.setData("application/x-kind", k)}
            title={`${v.resources.ramMB} MB · ${v.resources.vcpu} vCPU · arranque ~${v.bootTimeSec}s`}>
            <span>{v.label}</span>
            <small className="muted">{v.resources.ramMB >= 1024 ? `${(v.resources.ramMB / 1024).toFixed(0)} GB` : `${v.resources.ramMB} MB`}</small>
          </div>
        ))}
        <p className="muted hint">Arrastra al canvas. Une dos routers arrastrando desde sus bordes.</p>
        {groups.length > 0 && <><h4>ISPs</h4>{groups.map((g) => <div key={g} className="legend"><i style={{ background: colorOf(g) }} />{g}</div>)}</>}
      </aside>

      <main className="canvas" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
          zoomOnDoubleClick={false}
          onPaneClick={() => setSelected(null)}
          connectionMode={ConnectionMode.Loose}
          deleteKeyCode={locked ? null : ["Delete", "Backspace"]}
          fitView colorMode="system"
        >
          <Background gap={24} />
          <Controls />
        </ReactFlow>
        {toast && <div className="toast" onClick={() => setToast("")}>{toast}</div>}
      </main>

      <aside className="side">
        <div className="tabs">
          <button className={side === "inspector" ? "active" : ""} onClick={() => setSide("inspector")}>Inspector</button>
          <button className={side === "guia" ? "active" : ""} onClick={() => setSide("guia")}>{topo.lesson ? "Lección" : "Guía / Validación"}</button>
          <button className={side === "log" ? "active" : ""} onClick={() => setSide("log")}>Log</button>
        </div>
        <div className="side-body">
          {side === "inspector" && <Inspector lab={topo.name} topo={topo} catalog={catalog} running={running} selected={selected} linkStates={linkStates} onTopo={update} />}
          {side === "guia" && topo.lesson && (
            <Lesson key={topo.name} lab={topo.name} topo={topo} running={running} openTerminal={openTerminal} proto={proto}
              events={logs.filter((l) => l.startsWith(`[${topo.name}] [estado]`) || /commit|CORTADO|restaurado/.test(l)).map((l) => l.replace(`[${topo.name}] `, ""))} />
          )}
          {side === "guia" && !topo.lesson && (
            <div>
              {topo.description && <p>{topo.description}</p>}
              {topo.guide?.length ? <ol className="guide">{topo.guide.map((g, i) => <li key={i} dangerouslySetInnerHTML={{ __html: mdInline(g.replace(/^\d+\.\s*/, "")) }} />)}</ol>
                : <p className="muted">Este lab no tiene guía. Carga uno desde «Laboratorios guiados».</p>}
              {checks && (
                <>
                  <h4>Validación ({checks.filter((c) => c.ok).length}/{checks.length})</h4>
                  <ul className="checks">{checks.map((c, i) => (
                    <li key={i} className={c.ok ? "ok" : "bad"}>{c.ok ? "✔" : "✘"} {c.check.description ?? c.check.type} <small className="muted">[{c.check.node}] {c.detail}</small></li>
                  ))}</ul>
                </>
              )}
            </div>
          )}
          {side === "log" && <pre className="log">{logs.join("\n") || "Sin eventos todavía."}</pre>}
        </div>
      </aside>

      <section className="terminals">
        <div className="tabs">
          {terms.length === 0 && <span className="muted">Doble clic en un router para abrir su consola Junos.</span>}
          {terms.map((t) => (
            <span key={t} className={`term-tab ${activeTerm === t ? "active" : ""}`} onClick={() => setActiveTerm(t)}>
              {t}
              <button className="x" onClick={(e) => { e.stopPropagation(); setTerms((x) => x.filter((y) => y !== t)); if (activeTerm === t) setActiveTerm(terms.find((y) => y !== t) ?? null); }}>×</button>
            </span>
          ))}
        </div>
        <div className="term-body">
          {terms.map((t) => <TerminalPane key={`${topo.name}/${t}`} lab={topo.name} node={t} visible={activeTerm === t} />)}
        </div>
      </section>
    </div>
  );
}

/** Nombres de interfaz cortos para las etiquetas: Ethernet0/1 → Et0/1, GigabitEthernet2 → Gi2 */
function shortIf(i: string) {
  return i.replace(/^GigabitEthernet/, "Gi").replace(/^TenGigabitEthernet/, "Te").replace(/^Ethernet/, "Et");
}

/** Elige el lado del nodo que mira hacia el otro extremo (aristas limpias sin edge custom). */
function facingHandles(a?: { x: number; y: number }, b?: { x: number; y: number }) {
  if (!a || !b) return {};
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? { sourceHandle: "right", targetHandle: "left" } : { sourceHandle: "left", targetHandle: "right" };
  return dy > 0 ? { sourceHandle: "bottom", targetHandle: "top" } : { sourceHandle: "top", targetHandle: "bottom" };
}

/** Markdown mínimo para la guía: **negrita** y `código` (escapando HTML). */
function mdInline(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`(.+?)`/g, "<code>$1</code>");
}

export default function App() {
  return <ReactFlowProvider><Editor /></ReactFlowProvider>;
}
