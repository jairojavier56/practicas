import { useEffect, useState } from "react";
import { api } from "../api";
import type { Catalog, LabLink, LabNode, LinkStateValue, Topology } from "../types";

type Rows = Record<string, string | boolean | undefined>[];

const VIEWS = [
  { id: "bgp", label: "BGP" },
  { id: "ospf", label: "OSPF" },
  { id: "isis", label: "IS-IS" },
  { id: "routes", label: "Rutas" },
  { id: "interfaces", label: "Interfaces" },
] as const;

function Table({ rows }: { rows: Rows }) {
  if (!rows.length) return <p className="muted">Sin datos.</p>;
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => (v === true ? "✔" : v === false ? "" : String(v ?? ""));
  const cls = (v: unknown) => {
    const s = String(v);
    if (/^(Established|Full|Up|up)$/.test(s)) return "ok";
    if (/^(Active|Connect|Idle|OpenSent|OpenConfirm|Init|ExStart|down|Down)$/.test(s)) return "bad";
    return "";
  };
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c} className={cls(r[c])}>{cell(r[c])}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function NodeInspector({ lab, node, catalog, running, onChange }: { lab: string; node: LabNode; catalog: Catalog; running: boolean; onChange: (n: LabNode) => void }) {
  const [tab, setTab] = useState<"estado" | "config" | "cmd" | "props">(running ? "estado" : "props");
  const [view, setView] = useState<string>("bgp");
  const [rows, setRows] = useState<Rows>([]);
  const [err, setErr] = useState("");
  const [cfg, setCfg] = useState("");
  const [cfgMsg, setCfgMsg] = useState("");
  const [cmd, setCmd] = useState("show route protocol bgp");
  const [out, setOut] = useState("");
  const os = catalog[node.kind]?.os;

  const load = async () => {
    setErr("");
    try { setRows((await api.view<Rows[number]>(lab, node.id, view)).rows); }
    catch (e) { setErr((e as Error).message); setRows([]); }
  };
  useEffect(() => { if (tab === "estado" && running && os === "junos") load(); }, [tab, view, node.id, running]); // eslint-disable-line
  useEffect(() => { if (tab === "config") api.getConfig(lab, node.id).then(setCfg).catch(() => setCfg("")); }, [tab, node.id, lab]);

  return (
    <div>
      <h3>{node.label ?? node.id} <span className="muted">({node.id})</span></h3>
      <div className="tabs">
        {(["estado", "config", "cmd", "props"] as const).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {{ estado: "Estado", config: "Config", cmd: "Comando", props: "Propiedades" }[t]}
          </button>
        ))}
      </div>

      {tab === "estado" && (
        !running ? <p className="muted">Despliega el lab para ver tablas en vivo.</p> :
        os !== "junos" ? <p className="muted">Nodo no-Junos: usa la pestaña Comando (salida en bruto).</p> : (
          <>
            <div className="tabs small">
              {VIEWS.map((v) => <button key={v.id} className={view === v.id ? "active" : ""} onClick={() => setView(v.id)}>{v.label}</button>)}
              <button onClick={load} title="Refrescar">⟳</button>
            </div>
            {err ? <pre className="error">{err}</pre> : <Table rows={rows} />}
          </>
        )
      )}

      {tab === "config" && (
        <>
          <p className="muted">Configuración en formato <code>set</code>. «Aplicar» la empuja por consola (configure → load set terminal → commit).</p>
          <textarea className="code" value={cfg} onChange={(e) => setCfg(e.target.value)} spellCheck={false} />
          <div className="row">
            <button onClick={async () => { await api.putConfig(lab, node.id, cfg); setCfgMsg("Guardada"); }}>Guardar</button>
            <button disabled={!running} onClick={async () => {
              setCfgMsg("Aplicando…");
              await api.putConfig(lab, node.id, cfg);
              const r = await api.applyConfigs(lab, [node.id]).catch((e) => ({ [node.id]: e.message }));
              setCfgMsg(r[node.id] === "ok" ? "Commit OK" : r[node.id]);
            }}>Guardar y aplicar</button>
            <span className="muted">{cfgMsg}</span>
          </div>
        </>
      )}

      {tab === "cmd" && (
        <>
          <form className="row" onSubmit={async (e) => {
            e.preventDefault();
            setOut("…");
            try { setOut((await api.exec(lab, node.id, cmd)).output); } catch (x) { setOut(`Error: ${(x as Error).message}`); }
          }}>
            <input className="grow mono" value={cmd} onChange={(e) => setCmd(e.target.value)} disabled={!running} />
            <button disabled={!running}>Ejecutar</button>
          </form>
          <div className="chips">
            {["show bgp summary", "show route protocol bgp", "show ospf neighbor", "show route 198.51.100.0/24 detail", "show route advertising-protocol bgp 192.0.2.2", "show bgp neighbor | match \"State|Peer\""].map((c) =>
              <button key={c} className="chip" onClick={() => setCmd(c)}>{c}</button>)}
          </div>
          <pre className="output">{out}</pre>
        </>
      )}

      {tab === "props" && (
        <div className="form">
          <label>Etiqueta<input value={node.label ?? ""} onChange={(e) => onChange({ ...node, label: e.target.value })} /></label>
          <label>Tipo de equipo
            <select value={node.kind} disabled={running} onChange={(e) => onChange({ ...node, kind: e.target.value })}>
              {Object.entries(catalog).map(([k, v]) => <option key={k} value={k}>{v.label} ({v.resources.ramMB} MB)</option>)}
            </select>
          </label>
          <label>ASN<input type="number" value={node.asn ?? ""} onChange={(e) => onChange({ ...node, asn: e.target.value ? Number(e.target.value) : undefined })} /></label>
          <label>Grupo / ISP<input value={node.group ?? ""} placeholder="ISP-A" onChange={(e) => onChange({ ...node, group: e.target.value || undefined })} /></label>
        </div>
      )}
    </div>
  );
}

function LinkInspector({ lab, link, topo, catalog, state, running, onChange }: {
  lab: string; link: LabLink; topo: Topology; catalog: Catalog; state: LinkStateValue; running: boolean; onChange: (l: LabLink) => void;
}) {
  const used = (node: string, except: string) => new Set(topo.links.flatMap((l) => [l.a, l.b]).filter((e) => e.node === node && e.iface !== except).map((e) => e.iface));
  const ifaceSelect = (side: "a" | "b") => {
    const e = link[side];
    const kind = catalog[topo.nodes.find((n) => n.id === e.node)?.kind ?? ""];
    const taken = used(e.node, e.iface);
    return (
      <label>{e.node}
        <select value={e.iface} disabled={running} onChange={(ev) => onChange({ ...link, [side]: { ...e, iface: ev.target.value } })}>
          {(kind?.interfaces ?? [e.iface]).map((i) => <option key={i} value={i} disabled={taken.has(i)}>{i}</option>)}
        </select>
      </label>
    );
  };
  return (
    <div>
      <h3>Enlace <span className="muted">{link.id}</span></h3>
      <p>Estado: <b className={state === "up" ? "ok" : state === "down" ? "bad" : "muted"}>{state}</b></p>
      <div className="form">{ifaceSelect("a")}{ifaceSelect("b")}</div>
      {running && (
        <div className="row">
          <button className="danger" onClick={() => api.setLink(lab, link.id, false)}>✂ Cortar enlace</button>
          <button onClick={() => api.setLink(lab, link.id, true)}>Restaurar</button>
        </div>
      )}
      {running && <p className="muted">Cortar baja la interfaz en un extremo: ideal para ver convergencia OSPF/BGP.</p>}
    </div>
  );
}

export function Inspector(props: {
  lab: string; topo: Topology; catalog: Catalog; running: boolean;
  selected: { type: "node" | "link"; id: string } | null;
  linkStates: Record<string, LinkStateValue>;
  onTopo: (t: Topology) => void;
}) {
  const { selected, topo } = props;
  if (!selected) return <p className="muted">Selecciona un router o un enlace. Doble clic en un router abre su consola.</p>;
  if (selected.type === "node") {
    const n = topo.nodes.find((x) => x.id === selected.id);
    if (!n) return null;
    return <NodeInspector key={n.id} lab={props.lab} node={n} catalog={props.catalog} running={props.running}
      onChange={(nn) => props.onTopo({ ...topo, nodes: topo.nodes.map((x) => (x.id === nn.id ? nn : x)) })} />;
  }
  const l = topo.links.find((x) => x.id === selected.id);
  if (!l) return null;
  return <LinkInspector lab={props.lab} link={l} topo={topo} catalog={props.catalog} running={props.running}
    state={props.linkStates[l.id] ?? "unknown"}
    onChange={(ll) => props.onTopo({ ...topo, links: topo.links.map((x) => (x.id === ll.id ? ll : x)) })} />;
}
