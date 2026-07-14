import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import si from "systeminformation";

const execFileAsync = promisify(execFile);
const ncpu = Math.max(1, os.cpus().length);

export type ProcessPick = {
  pid: number;
  name: string;
  cpu: number;
  memMb: number;
};

export type ProcessStats = {
  pid: number;
  name: string;
  cpu: number;
  memMb: number;
  readKBs: number;
  writeKBs: number;
  alive: boolean;
};

type Sample = {
  at: number;
  cpuTime: number;
  readBytes: number;
  writeBytes: number;
};

const prev = new Map<number, Sample>();

function cpuPct(pid: number, cpuTimeSec: number, now: number): number {
  const p = prev.get(pid);
  if (!p) return 0;
  const dt = (now - p.at) / 1000;
  if (dt <= 0) return 0;
  const pct = ((cpuTimeSec - p.cpuTime) / dt / ncpu) * 100;
  return Math.max(0, Math.min(100 * ncpu, pct));
}

function ioRate(
  pid: number,
  readBytes: number,
  writeBytes: number,
  now: number,
): { r: number; w: number } {
  const p = prev.get(pid);
  if (!p) return { r: 0, w: 0 };
  const dt = (now - p.at) / 1000;
  if (dt <= 0) return { r: 0, w: 0 };
  return {
    r: Math.max(0, (readBytes - p.readBytes) / dt / 1024),
    w: Math.max(0, (writeBytes - p.writeBytes) / dt / 1024),
  };
}

function remember(
  pid: number,
  now: number,
  cpuTime: number,
  readBytes: number,
  writeBytes: number,
) {
  prev.set(pid, { at: now, cpuTime, readBytes, writeBytes });
}

export function clearProcessSample(pid?: number) {
  if (pid == null) prev.clear();
  else prev.delete(pid);
}

export async function listProcessPicks(): Promise<ProcessPick[]> {
  const data = await si.processes();
  return (data.list || [])
    .filter((p) => p.pid > 0 && p.name)
    .map((p) => ({
      pid: p.pid,
      name: String(p.name),
      cpu: Math.round(p.cpu || 0),
      // memRss is KB in systeminformation
      memMb: Math.max(0, (p.memRss || 0) / 1024),
    }))
    .sort((a, b) => b.cpu - a.cpu || b.memMb - a.memMb);
}

async function sampleLinux(pid: number): Promise<ProcessStats | null> {
  const now = Date.now();
  try {
    const [stat, status, ioRaw, cmdline] = await Promise.all([
      fs.readFile(`/proc/${pid}/stat`, "utf8"),
      fs.readFile(`/proc/${pid}/status`, "utf8"),
      fs.readFile(`/proc/${pid}/io`, "utf8").catch(() => ""),
      fs.readFile(`/proc/${pid}/comm`, "utf8").catch(() => String(pid)),
    ]);
    const parts = stat.slice(stat.indexOf(")") + 2).trim().split(/\s+/);
    // utime=11 stime=12 (0-based after comm) — after ") " fields: state ppid ... utime stime at index 11,12 from post-comm? 
    // /proc/pid/stat: after comm) field 12=utime, 13=stime (1-based field numbers in man = index 11,12 in 0-based after split of post-paren)
    const utime = parseInt(parts[11] || "0", 10) || 0;
    const stime = parseInt(parts[12] || "0", 10) || 0;
    const clk = 100; // ponytail: common HZ; ok for relative %
    const cpuTime = (utime + stime) / clk;

    let memKb = 0;
    const m = status.match(/^VmRSS:\s+(\d+)/m);
    if (m) memKb = parseInt(m[1], 10) || 0;

    let readBytes = 0;
    let writeBytes = 0;
    for (const line of ioRaw.split("\n")) {
      if (line.startsWith("read_bytes:")) readBytes = parseInt(line.split(/\s+/)[1] || "0", 10) || 0;
      if (line.startsWith("write_bytes:")) writeBytes = parseInt(line.split(/\s+/)[1] || "0", 10) || 0;
    }

    const cpu = cpuPct(pid, cpuTime, now);
    const { r, w } = ioRate(pid, readBytes, writeBytes, now);
    remember(pid, now, cpuTime, readBytes, writeBytes);

    return {
      pid,
      name: cmdline.trim() || String(pid),
      cpu: Math.round(cpu * 10) / 10,
      memMb: memKb / 1024,
      readKBs: r,
      writeKBs: w,
      alive: true,
    };
  } catch {
    return null;
  }
}

async function sampleWindows(pid: number): Promise<ProcessStats | null> {
  const now = Date.now();
  const ps = [
    "-NoProfile",
    "-Command",
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { '{}' } else { @{ pid=$p.Id; name=$p.ProcessName; cpu=[double]$p.CPU; ws=[int64]$p.WorkingSet64 } | ConvertTo-Json -Compress }`,
  ];
  try {
    const { stdout } = await execFileAsync("powershell.exe", ps, {
      timeout: 3000,
      windowsHide: true,
    });
    const raw = JSON.parse(stdout || "{}") as {
      pid?: number;
      name?: string;
      cpu?: number;
      ws?: number;
    };
    if (!raw.pid) return null;
    const cpuTime = Number(raw.cpu || 0); // total processor seconds
    const cpu = cpuPct(pid, cpuTime, now);
    remember(pid, now, cpuTime, 0, 0);
    return {
      pid,
      name: String(raw.name || pid),
      cpu: Math.round(cpu * 10) / 10,
      memMb: Math.max(0, Number(raw.ws || 0) / 1024 / 1024),
      readKBs: 0,
      writeKBs: 0,
      alive: true,
    };
  } catch {
    return null;
  }
}

async function sampleDarwin(pid: number): Promise<ProcessStats | null> {
  const now = Date.now();
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "pid=,pcpu=,rss=,comm="],
      { timeout: 2000 },
    );
    const line = stdout.trim();
    if (!line) return null;
    const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!m) return null;
    // pcpu is already %; rss KB
    return {
      pid,
      name: m[4].trim(),
      cpu: Math.round(parseFloat(m[2]) * 10) / 10,
      memMb: (parseInt(m[3], 10) || 0) / 1024,
      readKBs: 0,
      writeKBs: 0,
      alive: true,
    };
  } catch {
    return null;
  }
}

export async function sampleProcess(pid: number): Promise<ProcessStats | null> {
  const platform = os.platform();
  if (platform === "linux") return sampleLinux(pid);
  if (platform === "win32") return sampleWindows(pid);
  if (platform === "darwin") return sampleDarwin(pid);
  return sampleLinux(pid).catch(() => null);
}

export function matchDebugProcess(
  picks: ProcessPick[],
  session: { name?: string; type?: string; configuration?: Record<string, unknown> },
): ProcessPick | undefined {
  const conf = session.configuration || {};
  const hints: string[] = [];
  for (const key of ["program", "python", "runtimeExecutable", "name"]) {
    const v = conf[key];
    if (typeof v === "string" && v.trim()) hints.push(v);
  }
  if (session.name) hints.push(session.name);
  if (session.type) hints.push(session.type);

  const needles = hints
    .flatMap((h) => h.replace(/\\/g, "/").split("/"))
    .map((s) => s.toLowerCase().replace(/\.(exe|js|py|dll)$/i, ""))
    .filter((s) => s.length > 2 && !["debug", "launch", "attach"].includes(s));

  if (!needles.length) return undefined;

  const scored = picks
    .map((p) => {
      const n = p.name.toLowerCase();
      let score = 0;
      for (const needle of needles) {
        if (n === needle || n === needle + ".exe") score += 100;
        else if (n.includes(needle)) score += 40;
      }
      score += Math.min(20, p.cpu);
      return { p, score };
    })
    .filter((x) => x.score >= 40)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.p;
}
