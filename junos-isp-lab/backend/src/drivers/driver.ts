import type { LinkState, Topology } from "../types.js";

/** Sesión de consola interactiva (PTY real o CLI simulado). */
export interface ConsoleSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
  close(): void;
}

/**
 * Motor de red. Hay dos implementaciones:
 *  - MockDriver: sin imágenes, CLI Junos simulado (desarrollo de la UI / demos).
 *  - ContainerlabDriver: despliegue real con imágenes Juniper vía containerlab.
 */
export interface NetworkDriver {
  readonly name: string;
  deploy(topo: Topology, log: (line: string) => void): Promise<void>;
  destroy(topo: Topology, log: (line: string) => void): Promise<void>;
  openConsole(topo: Topology, nodeId: string, cols: number, rows: number): ConsoleSession;
  /** Ejecuta un comando operacional (no interactivo) y devuelve stdout. */
  exec(topo: Topology, nodeId: string, cmd: string): Promise<string>;
  linkStates(topo: Topology): Promise<LinkState[]>;
  setLink(topo: Topology, linkId: string, up: boolean): Promise<void>;
}
