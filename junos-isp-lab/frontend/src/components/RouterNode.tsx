import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { KindInfo } from "../types";

export type RouterData = { label: string; kind: string; kindInfo?: KindInfo; asn?: number; group?: string; running: boolean; onOpen?: (id: string) => void };
export type RouterNodeType = Node<RouterData, "router">;

/** Color estable por grupo (ISP-A, ISP-B...). */
export function groupColor(group?: string) {
  if (!group) return "var(--muted)";
  const palette = ["#2f6fed", "#e0702b", "#1f9d55", "#9b51e0", "#d64545", "#0a9396"];
  let h = 0;
  for (const c of group) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

function Icon({ kind }: { kind: KindInfo["icon"] | undefined }) {
  if (kind === "cloud")
    return <svg viewBox="0 0 48 32" width="44" height="30"><path d="M14 28h22a9 9 0 0 0 0-18 12 12 0 0 0-23 3A8 8 0 0 0 14 28z" fill="currentColor" opacity=".85" /></svg>;
  // Router: cilindro con flechas
  return (
    <svg viewBox="0 0 48 32" width="44" height="30">
      <ellipse cx="24" cy="22" rx="20" ry="7" fill="currentColor" opacity=".6" />
      <rect x="4" y="10" width="40" height="12" fill="currentColor" opacity=".6" />
      <ellipse cx="24" cy="10" rx="20" ry="7" fill="currentColor" />
      <path d="M16 8l4 2-4 2M32 8l-4 2 4 2" stroke="var(--bg)" strokeWidth="1.6" fill="none" />
    </svg>
  );
}

export function RouterNode({ id, data, selected }: NodeProps<RouterNodeType>) {
  const color = groupColor(data.group);
  return (
    <div className={`router-node ${selected ? "selected" : ""}`} style={{ borderColor: color, color }}
      onDoubleClick={(e) => { e.stopPropagation(); data.onOpen?.(id); }}>
      {/* ConnectionMode.Loose: cualquier handle sirve como origen o destino */}
      {[Position.Top, Position.Right, Position.Bottom, Position.Left].map((p) => (
        <Handle key={p} id={p} type="source" position={p} className="handle" />
      ))}
      <Icon kind={data.kindInfo?.icon} />
      <div className="router-label">{data.label}</div>
      <div className="router-meta">
        {data.kindInfo?.label ?? data.kind}
        {data.asn ? ` · AS${data.asn}` : ""}
      </div>
      <span className={`dot ${data.running ? "on" : ""}`} title={data.running ? "lab en ejecución" : "parado"} />
    </div>
  );
}
