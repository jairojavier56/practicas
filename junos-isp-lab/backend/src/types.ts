// Modelo de datos compartido (el frontend tiene una copia en frontend/src/types.ts)

export interface Endpoint {
  node: string; // id del nodo
  iface: string; // nombre "Junos" visible en la UI, ej. ge-0/0/0
}

export interface LabNode {
  id: string; // también es el nombre del nodo en containerlab (r1, isp-a-pe1...)
  kind: string; // clave del catálogo config/images.yaml (crpd, vjunos-router, frr...)
  label?: string;
  asn?: number;
  group?: string; // ej. "ISP-A" para colorear en el canvas
  position: { x: number; y: number };
}

export interface LabLink {
  id: string;
  a: Endpoint;
  b: Endpoint;
}

export type Check =
  | { type: "bgp-established"; node: string; peer: string; description?: string }
  | { type: "ospf-full"; node: string; minNeighbors: number; description?: string }
  | { type: "isis-up"; node: string; minAdjacencies: number; description?: string }
  | { type: "ldp-up"; node: string; minSessions: number; description?: string }
  | { type: "route-present"; node: string; prefix: string; protocol?: string; vrf?: string; description?: string }
  | { type: "route-absent"; node: string; prefix: string; vrf?: string; description?: string }
  | { type: "route-aspath"; node: string; prefix: string; contains: string; vrf?: string; description?: string }
  | { type: "route-via"; node: string; prefix: string; via: string; vrf?: string; description?: string }
  | { type: "link-state"; link: string; state: "up" | "down"; node?: string; description?: string };

/** Paso de una lección guiada (mismo formato que la lección interactiva del navegador). */
export interface LessonStep {
  title: string;
  text: string;
  cmds: { node: string; lines: string[] }[];
  observe: string;
  result: string;
  check: Check[]; // deben cumplirse a la vez AHORA
  seen?: Check[]; // deben haberse cumplido juntos en algún momento (p. ej. durante un failover)
}

export interface Topology {
  name: string; // nombre del lab (se usa como nombre de lab de containerlab)
  description?: string;
  nodes: LabNode[];
  links: LabLink[];
  checks?: Check[];
  guide?: string[]; // pasos del laboratorio guiado (markdown simple)
  lesson?: { title: string; intro?: string; steps: LessonStep[] };
}

export type LabStatus = "stopped" | "deploying" | "running" | "destroying" | "error";

export interface LinkState {
  id: string;
  state: "up" | "down" | "unknown";
}

export type ServerEvent =
  | { type: "status"; lab: string; status: LabStatus; message?: string }
  | { type: "log"; lab: string; line: string }
  | { type: "links"; lab: string; links: LinkState[] }
  | { type: "proto"; lab: string; bgp: ProtoBgp[]; ospf: ProtoOspf[] };

export interface ProtoBgp { node: string; peer: string; asn: string; state: string }
export interface ProtoOspf { node: string; iface: string; neighbor: string; state: string; proto?: "OSPF" | "IS-IS" | "LDP" }
