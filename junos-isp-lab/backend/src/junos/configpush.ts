import type { NetworkDriver } from "../drivers/driver.js";
import type { Topology } from "../types.js";

/**
 * Empuja configuración `set` a un nodo a través de su consola, igual que lo
 * haría una persona: configure → load set terminal → pegar → ^D → commit.
 *
 * Funciona igual en cRPD (docker exec cli), vJunos/vMX/vSRX (ssh) y en el mock,
 * sin depender del formato de startup-config de cada kind de containerlab.
 */
export async function pushSetConfig(
  driver: NetworkDriver,
  topo: Topology,
  node: string,
  setText: string,
  log: (l: string) => void,
): Promise<string> {
  const lines = setText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const s = driver.openConsole(topo, node, 200, 50);
  let buf = "";
  let transcript = "";
  s.onData((d) => { buf += d; transcript += d; });

  const waitFor = async (re: RegExp, ms: number) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const clean = buf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      if (re.test(clean)) { buf = ""; return clean; }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timeout esperando ${re} en ${node}. Última salida: ${buf.slice(-300)}`);
  };
  const send = (t: string) => s.write(t);

  try {
    send("\r");
    // Puede caer en shell (%, $ o #) o directamente en el CLI (>). Si es shell, entramos con `cli`.
    const first = await waitFor(/(>\s*$)|([%$#]\s*$)/m, 120_000);
    if (!/>\s*$/m.test(first)) { send("cli\r"); await waitFor(/>\s*$/m, 30_000); }
    send("set cli screen-length 0\r");
    await waitFor(/>\s*$/m, 10_000);
    send("configure private\r");
    await waitFor(/#\s*$/m, 20_000);
    send("load set terminal\r");
    await waitFor(/\^D|Type \^D/i, 10_000);
    for (const l of lines) { send(l + "\r"); await new Promise((r) => setTimeout(r, 15)); }
    send("\x04");
    const loaded = await waitFor(/#\s*$/m, 60_000);
    if (/error|syntax/i.test(loaded)) log(`[${node}] avisos al cargar:\n${loaded}`);
    send("commit and-quit\r");
    const res = await waitFor(/(commit complete[\s\S]*>\s*$)|(error:[\s\S]*#\s*$)/m, 180_000);
    if (/error:/.test(res)) {
      send("rollback 0\rexit\r");
      throw new Error(`[${node}] commit falló:\n${res}`);
    }
    log(`[${node}] ${lines.length} líneas aplicadas, commit complete`);
    return transcript;
  } finally {
    s.close();
  }
}
