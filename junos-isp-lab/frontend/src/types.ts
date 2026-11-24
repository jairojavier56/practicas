// Copia del modelo del backend (backend/src/types.ts)
export interface Endpoint { node: string; iface: string }
export interface LabNode { id: string; kind: string; label?: string; asn?: number; group?: string; position: { x: number; y: number } }
export interface LabLink { id: string; a: Endpoint; b: Endpoint }
export interface Topology { name: string; description?: string; nodes: LabNode[]; links: LabLink[]; checks?: unknown[]; guide?: string[] }
export type LabStatus = "stopped" | "deploying" | "running" | "destroying" | "error";
export type LinkStateValue = "up" | "down" | "unknown";

export interface KindInfo {
  label: string;
  os: "junos" | "frr" | "linux";
  icon: "router" | "switch" | "server" | "cloud";
  resources: { ramMB: number; vcpu: number };
  bootTimeSec: number;
  interfaces: string[];
}
export type Catalog = Record<string, KindInfo>;

export type ServerEvent =
  | { type: "status"; lab: string; status: LabStatus; message?: string }
  | { type: "log"; lab: string; line: string }
  | { type: "links"; lab: string; links: { id: string; state: LinkStateValue }[] };

export interface CheckResult { check: { type: string; node: string; description?: string }; ok: boolean; detail: string }
