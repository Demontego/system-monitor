import type { Snapshot } from "./monitor";

export type Point = {
  t: number;
  cpu: number;
  cpuCores: number[];
  mem: number;
  gpuUtils: (number | null)[];
  diskReads: number[];
  diskWrites: number[];
  down: number;
  up: number;
};

const MAX = 120;

export class History {
  private buf: Point[] = [];

  push(s: Snapshot) {
    this.buf.push({
      t: Date.now(),
      cpu: s.cpuTotal,
      cpuCores: s.cpuCores.slice(),
      mem: s.memPct,
      gpuUtils: s.gpus.map((g) => g.util),
      diskReads: s.disks.map((d) => d.readKBs),
      diskWrites: s.disks.map((d) => d.writeKBs),
      down: s.netDownKBs,
      up: s.netUpKBs,
    });
    if (this.buf.length > MAX) this.buf.shift();
  }

  clear() {
    this.buf = [];
  }

  snapshot() {
    return this.buf.slice();
  }
}
