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
  gpuMemMb?: number | null;
  gpuIndex?: number | null;
  gpuName?: string | null;
  user?: string | null;
  /** docker / k8s / container short id, if any */
  container?: string | null;
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
    // utime=11 stime=12 (0-based after comm) ? after ") " fields: state ppid ... utime stime at index 11,12 from post-comm? 
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

function nvidiaBins(): string[] {
  return os.platform() === "win32"
    ? [
        "nvidia-smi.exe",
        `${process.env.SystemRoot || "C:\\Windows"}\\System32\\nvidia-smi.exe`,
      ]
    : ["nvidia-smi", "/usr/lib/wsl/lib/nvidia-smi", "/usr/bin/nvidia-smi"];
}

function nvidiaEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH:
      os.platform() === "win32"
        ? process.env.PATH || ""
        : `${process.env.PATH || ""}:/usr/lib/wsl/lib:/usr/bin`,
  };
}

async function nvidiaQuery(args: string[]): Promise<string | null> {
  for (const bin of nvidiaBins()) {
    try {
      const { stdout } = await execFileAsync(bin, args, {
        timeout: 4000,
        windowsHide: true,
        env: nvidiaEnv(),
        maxBuffer: 512 * 1024,
      });
      if (stdout.trim()) return stdout;
    } catch {
      /* next */
    }
  }
  return null;
}

async function mapGpuUuidToIndex(): Promise<Map<string, { index: number; name: string }>> {
  const out = new Map<string, { index: number; name: string }>();
  const raw = await nvidiaQuery([
    "--query-gpu=index,uuid,name",
    "--format=csv,noheader,nounits",
  ]);
  if (!raw) return out;
  for (const line of raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const parts = line.split(",").map((p) => p.trim());
    const index = parseInt(parts[0] || "", 10);
    const uuid = parts[1] || "";
    const name = parts[2] || `GPU ${index}`;
    if (!uuid || Number.isNaN(index)) continue;
    out.set(uuid, { index, name });
  }
  return out;
}

async function usersForPids(pids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (!pids.length) return map;
  if (os.platform() === "win32") {
    try {
      const list = pids.join(",");
      // GetOwner via Invoke-CimMethod ? direct .GetOwner() often fails silently
      const ps = [
        "-NoProfile",
        "-Command",
        `$ids=@(${list}); foreach($id in $ids){ $p=Get-CimInstance Win32_Process -Filter \"ProcessId=$id\" -EA SilentlyContinue; if(-not $p){continue}; try { $o=Invoke-CimMethod -InputObject $p -MethodName GetOwner -EA Stop; if($o.ReturnValue -eq 0 -and $o.User){ Write-Output \"$id,$($o.User)\" } else { Write-Output \"$id,?\" } } catch { Write-Output \"$id,?\" } }`,
      ];
      const { stdout } = await execFileAsync("powershell.exe", ps, {
        timeout: 6000,
        windowsHide: true,
        maxBuffer: 512 * 1024,
      });
      for (const line of stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        const [id, user] = line.split(",");
        const pid = parseInt(id || "", 10);
        if (pid && user && user !== "?") map.set(pid, user.trim());
      }
    } catch {
      /* ignore */
    }
    return map;
  }
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-o", "pid=,user=", "-p", pids.join(",")],
      { timeout: 3000 },
    );
    for (const line of stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      const m = line.match(/^(\d+)\s+(\S+)/);
      if (m) map.set(parseInt(m[1], 10), m[2]);
    }
  } catch {
    /* ignore */
  }
  return map;
}

function procBasename(raw: string): string {
  const s = raw.trim();
  if (!s || /^\[insufficient permissions\]$/i.test(s)) return "system";
  const norm = s.replace(/\\/g, "/");
  const base = norm.split("/").pop() || s;
  return base.length > 40 ? `${base.slice(0, 39)}?` : base;
}

/** Desktop / compositor noise on Windows ? hide unless significant VRAM */
const WIN_NOISE = /^(explorer|dwm|csrss|winlogon|sihost|shellexperiencehost|startmenuexperiencehost|searchhost|textinputhost|runtimebroker|applicationframehost|systemsettings|nvidia(overlay|share|webhelper)?|nvcontainer|nvdisplay|razer|steamwebhelper|telegram|yandex|msedge|chrome|firefox|discord|slack)\b/i;

/** Min VRAM (MiB) to show as a "real" GPU consumer. Desktop noise often reports N/A. */
const MIN_VRAM_MIB = 64;

async function containerForPid(pid: number): Promise<string | null> {
  if (os.platform() !== "linux") return null;
  try {
    const raw = await fs.readFile(`/proc/${pid}/cgroup`, "utf8");
    const docker =
      raw.match(/docker[-/]([0-9a-f]{12,})/i) ||
      raw.match(/docker-([0-9a-f]{12,})\.scope/i);
    if (docker) return `docker:${docker[1].slice(0, 12)}`;
    if (/kubepods|cri-containerd|containerd/i.test(raw)) {
      const id = raw.match(/([0-9a-f]{32,})/i);
      return id ? `k8s:${id[1].slice(0, 12)}` : "k8s";
    }
    try {
      const [a, b] = await Promise.all([
        fs.readlink(`/proc/${pid}/ns/mnt`),
        fs.readlink("/proc/1/ns/mnt"),
      ]);
      if (a && b && a !== b) return "container";
    } catch {
      /* no ns access */
    }
  } catch {
    /* gone */
  }
  return null;
}

/** NVIDIA processes currently holding VRAM ? per GPU + user + docker/k8s */
export async function listGpuComputeApps(): Promise<ProcessPick[]> {
  const [appsRaw, uuidMap] = await Promise.all([
    nvidiaQuery([
      "--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory",
      "--format=csv,noheader,nounits",
    ]),
    mapGpuUuidToIndex(),
  ]);
  if (!appsRaw) return [];

  const rows: ProcessPick[] = [];
  for (const line of appsRaw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 3) continue;
    const uuid = parts[0] || "";
    const pid = parseInt(parts[1] || "0", 10);
    if (!pid) continue;
    const rawName = parts[2] || `pid-${pid}`;
    if (/insufficient permissions/i.test(rawName)) continue;
    const name = procBasename(rawName);
    const memRaw = parts[3] || "";
    const gpuMem =
      !memRaw || /^\[?n\/?a\]?$/i.test(memRaw) ? NaN : parseFloat(memRaw);
    const memMb = Number.isNaN(gpuMem) ? null : Math.round(gpuMem);
    // Windows lists every D3D client with N/A mem ? keep only real VRAM holders
    if (memMb == null || memMb < MIN_VRAM_MIB) {
      if (os.platform() === "win32") continue;
      // Linux: keep 0-mem compute apps (can be briefly idle CUDA) only if named
      if (memMb == null) continue;
    }
    if (os.platform() === "win32" && WIN_NOISE.test(name) && (memMb ?? 0) < 512) {
      continue;
    }
    const g = uuidMap.get(uuid);
    rows.push({
      pid,
      name,
      cpu: 0,
      memMb: 0,
      gpuMemMb: memMb,
      gpuIndex: g?.index ?? null,
      gpuName: g?.name ?? null,
      user: null,
      container: null,
    });
  }
  if (!rows.length) return [];

  // Dedup same pid on same GPU (keep max mem)
  const seen = new Map<string, ProcessPick>();
  for (const r of rows) {
    const key = `${r.gpuIndex ?? "?"}:${r.pid}`;
    const prev = seen.get(key);
    if (!prev || (r.gpuMemMb ?? 0) > (prev.gpuMemMb ?? 0)) seen.set(key, r);
  }
  const deduped = [...seen.values()];

  const pids = [...new Set(deduped.map((r) => r.pid))];
  const [users, containers] = await Promise.all([
    usersForPids(pids),
    os.platform() === "linux"
      ? Promise.all(pids.map(async (pid) => [pid, await containerForPid(pid)] as const)).then(
          (pairs) => new Map(pairs),
        )
      : Promise.resolve(new Map<number, string | null>()),
  ]);

  for (const r of deduped) {
    r.user = users.get(r.pid) ?? null;
    r.container = containers.get(r.pid) ?? null;
  }

  return deduped.sort(
    (a, b) =>
      (a.gpuIndex ?? 99) - (b.gpuIndex ?? 99) ||
      (b.gpuMemMb ?? 0) - (a.gpuMemMb ?? 0),
  );
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
