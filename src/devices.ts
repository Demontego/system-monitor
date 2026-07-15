import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import si from "systeminformation";

const execFileAsync = promisify(execFile);

export type GpuInfo = {
  id: string;
  name: string;
  util: number | null;
  temp: number | null;
  /** VRAM used / total in MiB */
  memUsedMb: number | null;
  memTotalMb: number | null;
};

export type DiskInfo = {
  id: string;
  name: string;
  kind: string;
  readKBs: number;
  writeKBs: number;
  busyPct: number | null;
};

type ByteSample = { r: number; w: number; at: number };
const prevDiskBytes = new Map<string, ByteSample>();

type Ctrl = {
  model?: string;
  vendor?: string;
  utilizationGpu?: number | null;
  temperatureGpu?: number | null;
  memoryUsed?: number | null;
  memoryTotal?: number | null;
  vram?: number | null;
};
type Block = {
  type?: string;
  name?: string;
  label?: string;
  device?: string;
  physical?: string;
  protocol?: string;
};
type Layout = { name?: string; device?: string; type?: string; interfaceType?: string };

function shortName(s: string, max = 22): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function rateFromDelta(
  id: string,
  rBytes: number,
  wBytes: number,
  now: number,
): { r: number; w: number } {
  const prev = prevDiskBytes.get(id);
  prevDiskBytes.set(id, { r: rBytes, w: wBytes, at: now });
  if (!prev) return { r: 0, w: 0 };
  const dt = (now - prev.at) / 1000;
  if (dt <= 0) return { r: 0, w: 0 };
  return {
    r: Math.max(0, (rBytes - prev.r) / dt / 1024),
    w: Math.max(0, (wBytes - prev.w) / dt / 1024),
  };
}

function parseMemMb(v: unknown): number | null {
  if (typeof v !== "number" || Number.isNaN(v) || v < 0) return null;
  // systeminformation may report MB already; values >> 256000 are likely MiB from smi
  return Math.round(v);
}

export function collectGpusFromControllers(graphics: { controllers?: Ctrl[] }): GpuInfo[] {
  const list = graphics.controllers ?? [];
  return list.map((c, i) => {
    const name = shortName(c.model || c.vendor || `GPU ${i}`);
    const util =
      typeof c.utilizationGpu === "number" && !Number.isNaN(c.utilizationGpu)
        ? Math.round(c.utilizationGpu)
        : null;
    const temp =
      typeof c.temperatureGpu === "number" && !Number.isNaN(c.temperatureGpu)
        ? Math.round(c.temperatureGpu)
        : null;
    const memUsedMb = parseMemMb(c.memoryUsed);
    const memTotalMb = parseMemMb(c.memoryTotal ?? c.vram);
    return { id: `gpu-${i}`, name, util, temp, memUsedMb, memTotalMb };
  });
}

/** systeminformation often returns empty controllers in WSL2; nvidia-smi still works */
async function gpusFromNvidiaSmi(): Promise<GpuInfo[]> {
  const bins =
    os.platform() === "win32"
      ? [
          "nvidia-smi.exe",
          `${process.env.SystemRoot || "C:\\Windows"}\\System32\\nvidia-smi.exe`,
        ]
      : ["nvidia-smi", "/usr/lib/wsl/lib/nvidia-smi", "/usr/bin/nvidia-smi"];

  const args = [
    "--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total",
    "--format=csv,noheader,nounits",
  ];

  const env = {
    ...process.env,
    PATH:
      os.platform() === "win32"
        ? process.env.PATH || ""
        : `${process.env.PATH || ""}:/usr/lib/wsl/lib:/usr/bin`,
  };

  for (const bin of bins) {
    try {
      const { stdout } = await execFileAsync(bin, args, {
        timeout: 4000,
        windowsHide: true,
        env,
        maxBuffer: 256 * 1024,
      });
      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (!lines.length) continue;
      const gpus: GpuInfo[] = [];
      for (let i = 0; i < lines.length; i++) {
        const parts = lines[i].split(",").map((p) => p.trim());
        if (parts.length < 1) continue;
        const name = shortName(parts[0] || `GPU ${i}`);
        const num = (raw: string | undefined) => {
          if (!raw || raw === "[N/A]" || raw === "N/A") return null;
          const n = parseFloat(raw);
          return Number.isNaN(n) ? null : Math.round(n);
        };
        gpus.push({
          id: `gpu-${i}`,
          name,
          util: num(parts[1]),
          temp: num(parts[2]),
          memUsedMb: num(parts[3]),
          memTotalMb: num(parts[4]),
        });
      }
      if (gpus.length) return gpus;
    } catch {
      /* try next binary */
    }
  }
  return [];
}

export async function collectGpus(
  graphics?: { controllers?: Ctrl[] },
): Promise<GpuInfo[]> {
  // Prefer nvidia-smi first on Linux/WSL: si.graphics() is often empty there
  if (os.platform() === "linux") {
    const smi = await gpusFromNvidiaSmi();
    if (smi.length) return smi;
  }

  const g = graphics ?? (await si.graphics().catch(() => ({ controllers: [] as Ctrl[] })));
  const fromSi = collectGpusFromControllers(g);
  const hasMetrics = fromSi.some((x) => x.util != null || x.temp != null);
  if (fromSi.length && hasMetrics) return fromSi;

  const smi = await gpusFromNvidiaSmi();
  if (smi.length) return smi;
  return fromSi;
}

/** @deprecated use collectGpus() */
export const collectGpusSync = collectGpusFromControllers;

async function disksWindows(): Promise<DiskInfo[]> {
  const ps = [
    "-NoProfile",
    "-Command",
    "Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Where-Object { $_.Name -ne '_Total' } | Select-Object Name,DiskReadBytesPersec,DiskWriteBytesPersec,PercentDiskTime | ConvertTo-Json -Compress",
  ];
  try {
    const { stdout } = await execFileAsync("powershell.exe", ps, {
      timeout: 4000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    if (!stdout.trim()) return [];
    const raw = JSON.parse(stdout) as
      | {
          Name: string;
          DiskReadBytesPersec: number;
          DiskWriteBytesPersec: number;
          PercentDiskTime: number;
        }
      | Array<{
          Name: string;
          DiskReadBytesPersec: number;
          DiskWriteBytesPersec: number;
          PercentDiskTime: number;
        }>;
    const rows = Array.isArray(raw) ? raw : [raw];
    return rows.map((row, i) => {
      const name = String(row.Name || `Disk ${i}`);
      const id = `disk-${name.split(" ")[0] ?? i}`;
      return {
        id,
        name: shortName(`Disk ${name}`, 28),
        kind: "",
        readKBs: Math.max(0, Number(row.DiskReadBytesPersec || 0) / 1024),
        writeKBs: Math.max(0, Number(row.DiskWriteBytesPersec || 0) / 1024),
        busyPct:
          typeof row.PercentDiskTime === "number"
            ? Math.min(100, Math.round(row.PercentDiskTime))
            : null,
      };
    });
  } catch {
    return [];
  }
}

async function disksLinux(): Promise<DiskInfo[]> {
  const now = Date.now();
  let blocks: Block[] = [];
  try {
    blocks = (await si.blockDevices()) as Block[];
  } catch {
    return [];
  }
  const disks = blocks.filter((b) => b.type === "disk" && b.name && !String(b.name).includes("loop"));
  const out: DiskInfo[] = [];
  for (const [i, b] of disks.entries()) {
    const dev = String(b.name).replace(/[^a-zA-Z0-9._-]/g, "");
    const id = `disk-${dev || i}`;
    try {
      const raw = (await fs.readFile(`/sys/block/${dev}/stat`, "utf8")).trim().split(/\s+/);
      const rBytes = (parseInt(raw[2] || "0", 10) || 0) * 512;
      const wBytes = (parseInt(raw[6] || "0", 10) || 0) * 512;
      const { r, w } = rateFromDelta(id, rBytes, wBytes, now);
      out.push({
        id,
        name: shortName(b.label || b.device || dev || `Disk ${i}`),
        kind: b.physical || b.protocol || "",
        readKBs: r,
        writeKBs: w,
        busyPct: null,
      });
    } catch {
      out.push({
        id,
        name: shortName(b.label || b.device || dev || `Disk ${i}`),
        kind: b.physical || "",
        readKBs: 0,
        writeKBs: 0,
        busyPct: null,
      });
    }
  }
  return out;
}

async function disksFallbackAggregate(): Promise<DiskInfo[]> {
  const now = Date.now();
  const layout = ((await si.diskLayout().catch(() => [])) as Layout[]) || [];
  const fsStats = await si.fsStats().catch(() => null);
  let r = 0;
  let w = 0;
  if (fsStats) {
    if (typeof fsStats.rx_sec === "number") {
      r = fsStats.rx_sec / 1024;
      w = (fsStats.wx_sec || 0) / 1024;
    } else {
      const rates = rateFromDelta("agg", fsStats.rx || 0, fsStats.wx || 0, now);
      r = rates.r;
      w = rates.w;
    }
  }
  if (layout.length <= 1) {
    const d = layout[0];
    return [
      {
        id: "disk-0",
        name: shortName(d?.name || d?.device || "Disk 0"),
        kind: d?.type || d?.interfaceType || "",
        readKBs: Math.max(0, r),
        writeKBs: Math.max(0, w),
        busyPct: null,
      },
    ];
  }
  // ponytail: macOS — no cheap per-disk byte rates; aggregate stays on Disk 0
  return layout.map((d, i) => ({
    id: `disk-${i}`,
    name: shortName(d.name || d.device || `Disk ${i}`),
    kind: d.type || d.interfaceType || "",
    readKBs: i === 0 ? Math.max(0, r) : 0,
    writeKBs: i === 0 ? Math.max(0, w) : 0,
    busyPct: null,
  }));
}

export async function collectDisks(): Promise<DiskInfo[]> {
  const platform = os.platform();
  if (platform === "win32") {
    const list = await disksWindows();
    if (list.length) return list;
  } else if (platform === "linux") {
    const list = await disksLinux();
    if (list.length) return list;
  }
  return disksFallbackAggregate();
}
