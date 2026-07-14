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

type Ctrl = { model?: string; vendor?: string; utilizationGpu?: number };
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

export function collectGpus(graphics: { controllers?: Ctrl[] }): GpuInfo[] {
  const list = graphics.controllers ?? [];
  return list.map((c, i) => {
    const name = shortName(c.model || c.vendor || `GPU ${i}`);
    const util =
      typeof c.utilizationGpu === "number" && !Number.isNaN(c.utilizationGpu)
        ? Math.round(c.utilizationGpu)
        : null;
    return { id: `gpu-${i}`, name, util };
  });
}

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
