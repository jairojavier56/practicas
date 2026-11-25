import type { NetworkDriver } from "../drivers/driver.js";
import type { Topology } from "../types.js";

/**
 * Empuja configuración a un Cisco IOS/IOS-XE por su consola, como lo haría una
 * persona: configure terminal → pegar líneas → end → write memory.
 */
export async function pushIosConfig(
  driver: NetworkDriver,
  topo: Topology,
  node: string,
  text: string,
  log: (l: string) => void,
): Promise<string> {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() && !/^\s*!/.test(l) && !/^\s*#/.test(l));
  const s = driver.openConsole(topo, node, 200, 50);
  let buf = "";
  let transcript = "";
  s.onData((d) => { buf += d; transcript += d; });
  const clean = () => buf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const waitFor = async (re: RegExp, ms: number) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const c = clean();
      if (re.test(c)) { buf = ""; return c; }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timeout esperando ${re} en ${node}. Última salida: ${clean().slice(-300)}`);
  };
  const send = (t: string) => s.write(t);

  try {
    send("\r");
    const first = await waitFor(/[>#]\s*$/m, 120_000);
    if (/>\s*$/m.test(first)) { send("enable\r"); await waitFor(/#\s*$/m, 10_000); }
    send("terminal length 0\r");
    await waitFor(/#\s*$/m, 10_000);
    send("configure terminal\r");
    await waitFor(/\(config\)#\s*$/m, 20_000);
    for (const l of lines) {
      send(l + "\r");
      // IOS procesa línea a línea: esperamos al prompt de config para no perder entrada
      await waitFor(/\(config[^)]*\)#\s*$/m, 20_000);
    }
    send("end\r");
    await waitFor(/#\s*$/m, 20_000);
    const errors = (transcript.match(/^.*% (Invalid|Incomplete|Ambiguous|Unknown|Unrecognized).*$/gm) ?? []);
    if (errors.length) log(`[${node}] avisos de IOS:\n${errors.slice(0, 10).join("\n")}`);
    send("write memory\r");
    await waitFor(/(\[OK\]|#\s*$)/m, 60_000);
    log(`[${node}] ${lines.length} líneas aplicadas (IOS)${errors.length ? `, ${errors.length} con error` : ""}`);
    return transcript;
  } finally {
    s.close();
  }
}
