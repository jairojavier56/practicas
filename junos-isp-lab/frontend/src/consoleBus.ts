/**
 * Puente entre la lección y las consolas abiertas: permite "teclear" comandos
 * en la consola real de un router y esperar a que Junos devuelva el prompt.
 */
type Entry = { send: (d: string) => void; tail: string; listeners: Set<() => void> };
const consoles = new Map<string, Entry>();

export const consoleBus = {
  register(node: string, send: (d: string) => void) {
    const e: Entry = { send, tail: "", listeners: new Set() };
    consoles.set(node, e);
    return {
      onOutput(data: string) {
        e.tail = (e.tail + data).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").slice(-400);
        e.listeners.forEach((l) => l());
      },
      dispose() { if (consoles.get(node) === e) consoles.delete(node); },
    };
  },

  isOpen: (node: string) => consoles.has(node),

  /** Espera a que la consola exista (la pestaña puede tardar en abrirse). */
  async waitOpen(node: string, ms = 15000) {
    const t0 = Date.now();
    while (!consoles.has(node)) {
      if (Date.now() - t0 > ms) throw new Error(`No se pudo abrir la consola de ${node}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  },

  /** Envía una línea y espera al prompt de Junos (">" o "#") o hasta el timeout. */
  async run(node: string, line: string, timeoutMs = 90000) {
    const e = consoles.get(node);
    if (!e) throw new Error(`Consola de ${node} cerrada`);
    e.tail = "";
    e.send(line + "\r");
    await new Promise<void>((resolve) => {
      const t0 = Date.now();
      const check = () => {
        // el eco de la propia línea no cuenta: esperamos al prompt DESPUÉS de la salida
        const after = e.tail.slice(e.tail.indexOf(line) + line.length);
        if (/[>#%]\s*$/.test(after) || Date.now() - t0 > timeoutMs) { e.listeners.delete(check); clearInterval(iv); resolve(); }
      };
      const iv = setInterval(check, 250);
      e.listeners.add(check);
    });
  },
};
