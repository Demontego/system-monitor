import type { Snapshot } from "./monitor";

export type Point = {
  t: number;
  cpu: number;
  cpuCores: number[];
  mem: number;
  gpuUtils: (number | null)[];
  gpuTemps: (number | null)[];
  gpuMemPct: (number | null)[];
  diskReads: number[];
  diskWrites: number[];
  down: number;
  up: number;
  procCpu: number | null;
  procMemMb: number | null;
  procRead: number | null;
  procWrite: number | null;
};

const KEEP_MS = 30 * 60 * 1000;
const HARD_MAX = 2000;

export class History {
  private buf: Point[] = [];

  push(s: Snapshot) {
    const now = Date.now();
    this.buf.push({
      t: now,
      cpu: s.cpuTotal,
      cpuCores: s.cpuCores.slice(),
      mem: s.memPct,
      gpuUtils: s.gpus.map((g) => g.util),
      gpuTemps: s.gpus.map((g) => g.temp),
      gpuMemPct: s.gpus.map((g) =>
        g.memUsedMb != null && g.memTotalMb && g.memTotalMb > 0
          ? (g.memUsedMb / g.memTotalMb) * 100
          : null,
      ),
      diskReads: s.disks.map((d) => d.readKBs),
      diskWrites: s.disks.map((d) => d.writeKBs),
      down: s.netDownKBs,
      up: s.netUpKBs,
      procCpu: s.process?.alive ? s.process.cpu : null,
      procMemMb: s.process?.alive ? s.process.memMb : null,
      procRead: s.process?.alive ? s.process.readKBs : null,
      procWrite: s.process?.alive ? s.process.writeKBs : null,
    });
    const cut = now - KEEP_MS;
    while (this.buf.length && this.buf[0].t < cut) this.buf.shift();
    while (this.buf.length > HARD_MAX) this.buf.shift();
  }

  clear() {
    this.buf = [];
  }

  snapshot() {
    return this.buf.slice();
  }
}
