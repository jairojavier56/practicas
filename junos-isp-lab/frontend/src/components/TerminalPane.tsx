import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { consoleUrl } from "../api";
import { consoleBus } from "../consoleBus";

/** Consola Junos embebida: xterm.js ⇄ WebSocket ⇄ PTY (docker exec / ssh) en el backend. */
export function TerminalPane({ lab, node, visible }: { lab: string; node: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: "#0b0f14", foreground: "#d6e2ee" },
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(host.current!);
    fit.fit();

    const ws = new WebSocket(consoleUrl(lab, node, term.cols, term.rows));
    ws.binaryType = "arraybuffer";
    const bus = consoleBus.register(node, (d) => ws.readyState === WebSocket.OPEN && ws.send(d));
    ws.onopen = () => term.focus();
    ws.onmessage = (m) => {
      const text = typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data);
      term.write(text);
      bus.onOutput(text);
    };
    ws.onclose = () => term.write("\r\n\x1b[33m[sesión cerrada — cierra la pestaña o reabre con doble clic en el nodo]\x1b[0m\r\n");
    const sub = term.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(d));
    const sendSize = () => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ resize: [term.cols, term.rows] }));
    const rsub = term.onResize(sendSize);
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* oculto */ } });
    ro.observe(host.current!);

    return () => { bus.dispose(); ro.disconnect(); sub.dispose(); rsub.dispose(); ws.close(); term.dispose(); };
  }, [lab, node]);

  useEffect(() => { if (visible) setTimeout(() => fitRef.current?.fit(), 0); }, [visible]);

  return <div ref={host} className="terminal-host" style={{ display: visible ? "block" : "none" }} />;
}
