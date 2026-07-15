import os from "node:os";
import si from "systeminformation";
import {
  collectDisks,
  collectGpus,
  collectMounts,
  type DiskInfo,
  type GpuInfo,
  type MountInfo,
} from "./devices";
import {
  listGpuComputeApps,
  listProcessPicks,
  sampleProcess,
  type ProcessPick,
  type ProcessStats,
} from "./process";

export type Snapshot = {
  cpuTotal: number;
  cpuCores: number[];
  loadAvg: [number, number, number] | null;
  memUsedGb: number;
  memTotalGb: number;
  memPct: number;
  /** App / actively used (excludes reclaimable cache when possible) */
  memAppGb: number;
  memCacheGb: number;
  memFreeGb: number;
  memAvailableGb: number;
  gpus: GpuInfo[];
  gpuLabel: string;
  gpuPct: number | null;
  gpuTemp: number | null;
  gpuPowerW: number | null;
  disks: DiskInfo[];
  mounts: MountInfo[];
  diskReadKBs: number;
  diskWriteKBs: number;
  netDownKBs: number;
  netUpKBs: number;
  process: ProcessStats | null;
  topProcs: ProcessPick[];
  gpuProcs: ProcessPick[];
  platform: string;
};

let prevNet: { rx: number; tx: number; at: number } | null = null;

function toKBs(bytesPerSec: number): number {
  return bytesPerSec / 1024;
}

function toGb(bytes: number): number {
  return bytes / 1024 ** 3;
}

export async function collect(attachedPid?: number | null): Promise<Snapshot> {
  const [load, mem, netStats, osInfo, disks, mounts, process, gpus, topProcs, gpuProcs] =
    await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.networkStats(),
      si.osInfo(),
      collectDisks(),
      collectMounts(),
      attachedPid ? sampleProcess(attachedPid) : Promise.resolve(null),
      collectGpus(),
      listProcessPicks().then((p) => p.slice(0, 12)),
      listGpuComputeApps(),
    ]);

  const cpuCores = (load.cpus ?? []).map((c) => Math.round(c.load));
  const memTotalGb = toGb(mem.total);
  const memFreeGb = toGb(mem.free || 0);
  const cacheBytes =
    mem.buffcache ||
    (mem.buffers || 0) + (mem.cached || 0) ||
    Math.max(0, (mem.available || 0) - (mem.free || 0));
  const memCacheGb = toGb(cacheBytes);
  const memAppGb = Math.max(0, memTotalGb - memFreeGb - memCacheGb);
  const memAvailableGb = toGb(mem.available || mem.free || 0);
  const memUsedGb = memAppGb;
  const memPct = mem.total > 0 ? (memAppGb / memTotalGb) * 100 : 0;

  const withUtil = gpus.filter((g) => g.util != null);
  const withTemp = gpus.filter((g) => g.temp != null);
  const withPower = gpus.filter((g) => g.powerW != null);
  const gpuPct =
    withUtil.length > 0
      ? Math.max(...withUtil.map((g) => g.util as number))
      : gpus[0]?.util ?? null;
  const gpuTemp =
    withTemp.length > 0 ? Math.max(...withTemp.map((g) => g.temp as number)) : null;
  const gpuPowerW =
    withPower.length > 0 ? withPower.reduce((s, g) => s + (g.powerW || 0), 0) : null;
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

  const la = os.loadavg();
  const loadAvg: [number, number, number] | null =
    os.platform() === "win32" ? null : [la[0], la[1], la[2]];

  return {
    cpuTotal: Math.round(load.currentLoad),
    cpuCores,
    loadAvg,
    memUsedGb,
    memTotalGb,
    memPct,
    memAppGb,
    memCacheGb,
    memFreeGb,
    memAvailableGb,
    gpus,
    gpuLabel,
    gpuPct,
    gpuTemp,
    gpuPowerW,
    disks,
    mounts,
    diskReadKBs,
    diskWriteKBs,
    netDownKBs,
    netUpKBs,
    process,
    topProcs,
    gpuProcs,
    platform: `${osInfo.platform}/${osInfo.distro || osInfo.codename || ""}`.replace(/\/$/, ""),
  };
}

export function formatRate(kBs: number): string {
  if (kBs >= 1024 * 1024) return `${(kBs / 1024 / 1024).toFixed(1)}G`;
  if (kBs >= 1024) return `${(kBs / 1024).toFixed(1)}M`;
  return `${kBs.toFixed(0)}K`;
}

export const formatNet = formatRate;
