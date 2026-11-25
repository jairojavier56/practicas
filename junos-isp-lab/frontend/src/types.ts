// Copia del modelo del backend (backend/src/types.ts)
export interface Endpoint { node: string; iface: string }
export interface LabNode { id: string; kind: string; label?: string; asn?: number; group?: string; position: { x: number; y: number } }
export interface LabLink { id: string; a: Endpoint; b: Endpoint }
export type Check = { type: string; node?: string; description?: string; [k: string]: unknown };
export interface LessonStep { title: string; text: string; cmds: { node: string; lines: string[] }[]; observe: string; result: string; check: Check[]; seen?: Check[] }
export interface Topology { name: string; description?: string; nodes: LabNode[]; links: LabLink[]; checks?: unknown[]; guide?: string[]; lesson?: { title: string; intro?: string; steps: LessonStep[] } }
export interface ProtoBgp { node: string; peer: string; asn: string; state: string }
export interface ProtoOspf { node: string; iface: string; neighbor: string; state: string; proto?: string }
export type LabStatus = "stopped" | "deploying" | "running" | "destroying" | "error";
export type LinkStateValue = "up" | "down" | "unknown";

export interface KindInfo {
  label: string;
  os: "junos" | "ios" | "frr" | "linux";
  icon: "router" | "switch" | "server" | "cloud";
  resources: { ramMB: number; vcpu: number };
  bootTimeSec: number;
  interfaces: string[];
}
export type Catalog = Record<string, KindInfo>;

export type ServerEvent =
  | { type: "status"; lab: string; status: LabStatus; message?: string }
  | { type: "log"; lab: string; line: string }
  | { type: "links"; lab: string; links: { id: string; state: LinkStateValue }[] }
  | { type: "proto"; lab: string; bgp: ProtoBgp[]; ospf: ProtoOspf[] };

export interface CheckResult { check: Check; ok: boolean; detail: string }
