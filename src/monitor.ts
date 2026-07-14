import si from "systeminformation";
import { collectDisks, collectGpus, type DiskInfo, type GpuInfo } from "./devices";

export type Snapshot = {
  cpuTotal: number;
  cpuCores: number[];
  memUsedGb: number;
  memTotalGb: number;
  memPct: number;
  gpus: GpuInfo[];
  /** primary / max util — status bar */
  gpuLabel: string;
  gpuPct: number | null;
  disks: DiskInfo[];
  diskReadKBs: number;
  diskWriteKBs: number;
  netDownKBs: number;
  netUpKBs: number;
  platform: string;
};

let prevNet: { rx: number; tx: number; at: number } | null = null;

function toKBs(bytesPerSec: number): number {
  return bytesPerSec / 1024;
}

export async function collect(): Promise<Snapshot> {
  const [load, mem, graphics, netStats, osInfo, disks] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.graphics(),
    si.networkStats(),
    si.osInfo(),
    collectDisks(),
  ]);

  const cpuCores = (load.cpus ?? []).map((c) => Math.round(c.load));
  const memUsedGb = (mem.active || mem.used) / 1024 ** 3;
  const memTotalGb = mem.total / 1024 ** 3;
  const memPct = mem.total > 0 ? ((mem.active || mem.used) / mem.total) * 100 : 0;

  const gpus = collectGpus(graphics);
  const withUtil = gpus.filter((g) => g.util != null);
  const gpuPct =
    withUtil.length > 0 ? Math.max(...withUtil.map((g) => g.util as number)) : gpus[0]?.util ?? null;
  const top =
    [...withUtil].sort((a, b) => (b.util ?? 0) - (a.util ?? 0))[0] ?? gpus[0];
  const gpuLabel = top
    ? gpus.length > 1
      ? `${top.name} (+${gpus.length - 1})`
      : top.name
    : "GPU n/a";

  const now = Date.now();
  let netDownKBs = 0;
  let netUpKBs = 0;
  const rx = netStats.reduce((s, n) => s + (n.rx_bytes || 0), 0);
  const tx = netStats.reduce((s, n) => s + (n.tx_bytes || 0), 0);
  if (prevNet) {
    const dt = (now - prevNet.at) / 1000;
    if (dt > 0) {
      netDownKBs = toKBs((rx - prevNet.rx) / dt);
      netUpKBs = toKBs((tx - prevNet.tx) / dt);
    }
  }
  prevNet = { rx, tx, at: now };

  const diskReadKBs = disks.reduce((s, d) => s + d.readKBs, 0);
  const diskWriteKBs = disks.reduce((s, d) => s + d.writeKBs, 0);

  return {
    cpuTotal: Math.round(load.currentLoad),
    cpuCores,
    memUsedGb,
    memTotalGb,
    memPct,
    gpus,
    gpuLabel,
    gpuPct,
    disks,
    diskReadKBs,
    diskWriteKBs,
    netDownKBs,
    netUpKBs,
    platform: `${osInfo.platform}/${osInfo.distro || osInfo.codename || ""}`.replace(/\/$/, ""),
  };
}

export function formatRate(kBs: number): string {
  if (kBs >= 1024 * 1024) return `${(kBs / 1024 / 1024).toFixed(1)}G`;
  if (kBs >= 1024) return `${(kBs / 1024).toFixed(1)}M`;
  return `${kBs.toFixed(0)}K`;
}

export const formatNet = formatRate;
