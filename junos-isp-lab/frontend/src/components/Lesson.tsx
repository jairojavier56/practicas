import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { consoleBus } from "../consoleBus";
import type { ProtoBgp, ProtoOspf, Topology } from "../types";

/**
 * Lección guiada sobre los routers REALES (o el mock): cada paso trae comandos
 * que se teclean en la consola del equipo y comprobaciones que el backend
 * ejecuta contra Junos para saber si la red llegó al estado esperado.
 */
export function Lesson({ lab, topo, running, openTerminal, proto, events }: {
  lab: string;
  topo: Topology;
  running: boolean;
  openTerminal: (node: string) => void;
  proto: { bgp: ProtoBgp[]; ospf: ProtoOspf[] };
  events: string[];
}) {
  const lesson = topo.lesson!;
  const steps = lesson.steps;
  const storageKey = `lesson:${lab}`;
  const [done, setDone] = useState<Set<number>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(storageKey) ?? "[]")); } catch { return new Set(); }
  });
  const [open, setOpen] = useState(() => Math.min(done.size, steps.length - 1));
  const [typing, setTyping] = useState(false);
  const [detail, setDetail] = useState<string[]>([]);
  const seenOk = useRef<Set<number>>(new Set());

  const current = steps.findIndex((_, i) => !done.has(i));
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify([...done])); } catch { /* sin storage */ } }, [done, storageKey]);

  // Comprueba el paso actual cada 3 s contra los equipos
  useEffect(() => {
    if (!running || current < 0) return;
    let stop = false;
    const step = steps[current];
    const poll = async () => {
      try {
        const seen = step.seen ?? [];
        const res = await api.check(lab, [...seen, ...step.check]);
        if (stop) return;
        const seenRes = res.slice(0, seen.length), nowRes = res.slice(seen.length);
        if (seen.length && seenRes.every((r) => r.ok)) seenOk.current.add(current);
        setDetail(nowRes.map((r) => `${r.ok ? "✔" : "…"} ${r.check.description ?? r.check.type}: ${r.detail}`));
        const ok = nowRes.every((r) => r.ok) && (!seen.length || seenOk.current.has(current));
        if (ok) {
          setDone((d) => new Set([...d, current]));
          setOpen(current + 1 < steps.length ? current + 1 : current);
        }
      } catch { /* el backend puede estar ocupado: reintenta */ }
    };
    poll();
    const iv = setInterval(poll, 3000);
    return () => { stop = true; clearInterval(iv); };
  }, [running, current, lab]); // eslint-disable-line

  const runBlock = async (node: string, lines: string[]) => {
    if (!running) return;
    setTyping(true);
    try {
      openTerminal(node);
      await consoleBus.waitOpen(node);
      if (!consoleBus.isOpen(node)) return;
      await consoleBus.run(node, "", 15000); // asegura que hay prompt
      for (const l of lines) await consoleBus.run(node, l);
    } catch (e) {
      setDetail([(e as Error).message]);
    } finally {
      setTyping(false);
    }
  };

  const stateCls = (s: string) => (/^(Established|Full|Up|Operational)$/.test(s) ? "ok" : /^(Active|Idle|Connect|Down)$/.test(s) ? "bad" : "warn");

  return (
    <div className="lesson">
      <div className="lesson-head">
        <b>{lesson.title}</b>
        <div className="row" style={{ margin: "6px 0" }}>
          <div className="progress-bar"><i style={{ width: `${(done.size / steps.length) * 100}%` }} /></div>
          <span className="muted">{done.size}/{steps.length}</span>
          <button className="chip" onClick={() => { setDone(new Set()); setOpen(0); seenOk.current.clear(); }}>Reiniciar progreso</button>
        </div>
        {lesson.intro && <p className="muted">{lesson.intro}</p>}
        {!running && <p className="bad">Despliega el lab y pulsa «Cargar configs» para empezar.</p>}
      </div>

      <ol className="lesson-steps">
        {steps.map((s, i) => (
          <li key={i} className={`lstep ${done.has(i) ? "done" : ""} ${i === current ? "current" : ""} ${i === open ? "open" : ""}`}>
            <button className="lstep-head" onClick={() => setOpen(open === i ? -1 : i)}>
              <span className="lnum">{done.has(i) ? "✓" : i + 1}</span>{s.title}
            </button>
            {i === open && (
              <div className="lstep-body">
                <p>{s.text}</p>
                {s.cmds.map((c, j) => (
                  <div className="cmd" key={j}>
                    <div className="cmd-top">en <b className="mono">{c.node}</b>
                      <button className="primary small" disabled={!running || typing} onClick={() => runBlock(c.node, c.lines)}>▶ Ejecutar</button>
                    </div>
                    <pre>{c.lines.join("\n")}</pre>
                  </div>
                ))}
                <div className="observe"><b>Observa</b><br />{s.observe}</div>
                {done.has(i)
                  ? <div className="resultbox"><b>Qué ha pasado</b><br />{s.result}</div>
                  : i === current && running && <ul className="waiting">{detail.map((d, k) => <li key={k}>{d}</li>)}</ul>}
              </div>
            )}
          </li>
        ))}
      </ol>

      <h4>Estado en vivo <small className="muted">(consultado a los routers)</small></h4>
      <div className="live">
        {proto.ospf.map((o, i) => <div key={"o" + i} className={stateCls(o.state)}><span className="dot" />{o.proto ?? "OSPF"} {o.node} {o.iface} → {o.neighbor}<span className="st">{o.state}</span></div>)}
        {proto.bgp.map((b, i) => <div key={"b" + i} className={stateCls(b.state)}><span className="dot" />BGP {b.node} → {b.peer} (AS{b.asn})<span className="st">{b.state}</span></div>)}
        {!proto.bgp.length && !proto.ospf.length && <p className="muted">Sin datos todavía.</p>}
      </div>
      <h4>Eventos</h4>
      <pre className="log small">{events.slice(-14).join("\n") || "—"}</pre>
    </div>
  );
}
