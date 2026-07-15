import * as vscode from "vscode";
import { History } from "./history";
import { collect, formatRate, type Snapshot } from "./monitor";
import {
  SysMonPanelProvider,
  VIEW_ID,
  type CpuChartsMode,
  type TimeWindow,
} from "./panel";
import {
  clearProcessSample,
  listProcessPicks,
  matchDebugProcess,
  type ProcessPick,
} from "./process";

let timer: ReturnType<typeof setInterval> | undefined;
let cpuItem: vscode.StatusBarItem;
let memItem: vscode.StatusBarItem;
let diskItem: vscode.StatusBarItem;
let gpuItem: vscode.StatusBarItem;
let netItem: vscode.StatusBarItem;
let procItem: vscode.StatusBarItem;
let busy = false;
let panel: SysMonPanelProvider;
const history = new History();
let attached: ProcessPick | null = null;

function cfg() {
  return vscode.workspace.getConfiguration("systemMonitor");
}

function cpuMode(): CpuChartsMode {
  const v = cfg().get<string>("cpuCharts", "total");
  return v === "logical" ? "logical" : "total";
}

function timeWindow(): TimeWindow {
  const v = cfg().get<string>("timeWindow", "5m");
  if (v === "1m" || v === "30m") return v;
  return "5m";
}

function paint(s: Snapshot) {
  cpuItem.text = `$(pulse) ${s.cpuTotal}%`;
  cpuItem.tooltip =
    cpuMode() === "logical"
      ? `CPU ${s.cpuTotal}% · logical charts in panel\n${s.cpuCores.map((v, i) => `c${i}: ${v}%`).join(" | ")}`
      : `CPU ${s.cpuTotal}% · total chart in panel\nClick: toggle Total / Logical graphs`;

  memItem.text = `$(database) ${s.memUsedGb.toFixed(1)}/${s.memTotalGb.toFixed(1)}G`;
  memItem.tooltip = `RAM ${s.memPct.toFixed(0)}%`;

  if (cfg().get<boolean>("showDisk", true)) {
    diskItem.show();
    diskItem.text = `$(disc) R ${formatRate(s.diskReadKBs)} W ${formatRate(s.diskWriteKBs)}`;
    diskItem.tooltip =
      s.disks.length <= 1
        ? "Disk read / write"
        : s.disks
            .map(
              (d) =>
                `${d.name}: R ${formatRate(d.readKBs)} W ${formatRate(d.writeKBs)}` +
                (d.busyPct != null ? ` (${d.busyPct}%)` : ""),
            )
            .join("\n");
  } else {
    diskItem.hide();
  }

  if (cfg().get<boolean>("showGpu", true)) {
    gpuItem.show();
    const util = s.gpuPct != null ? `${s.gpuPct}%` : "—";
    const temp = s.gpuTemp != null ? ` ${s.gpuTemp}°` : "";
    const hot = [...s.gpus].sort((a, b) => (b.util ?? 0) - (a.util ?? 0))[0];
    const vram =
      hot?.memUsedMb != null && hot.memTotalMb
        ? ` ${(hot.memUsedMb / 1024).toFixed(1)}/${(hot.memTotalMb / 1024).toFixed(0)}G`
        : "";
    gpuItem.text = `$(circuit-board) ${util}${temp}${vram}`;
    gpuItem.tooltip =
      s.gpus.length === 0
        ? "GPU n/a"
        : s.gpus
            .map((g) => {
              const u = g.util == null ? "n/a" : `${g.util}%`;
              const t = g.temp == null ? "" : ` · ${g.temp}°C`;
              const m =
                g.memUsedMb != null && g.memTotalMb
                  ? ` · VRAM ${(g.memUsedMb / 1024).toFixed(1)}/${(g.memTotalMb / 1024).toFixed(1)} GB`
                  : "";
              return `${g.name}: ${u}${t}${m}`;
            })
            .join("\n");
  } else {
    gpuItem.hide();
  }

  if (cfg().get<boolean>("showNetwork", true)) {
    netItem.show();
    netItem.text = `$(arrow-down) ${formatRate(s.netDownKBs)} $(arrow-up) ${formatRate(s.netUpKBs)}`;
    netItem.tooltip = "Network RX / TX";
  } else {
    netItem.hide();
  }

  if (attached) {
    if (!s.process || !s.process.alive) {
      const dead = attached;
      detachProcess(false);
      void vscode.window.showWarningMessage(
        `System Monitor: process ${dead.name} (${dead.pid}) exited`,
      );
    } else {
      procItem.show();
      procItem.text = `$(debug-alt) ${s.process.cpu.toFixed(0)}% ${s.process.memMb.toFixed(0)}M`;
      procItem.tooltip = `${s.process.name} · PID ${s.process.pid}\nR ${formatRate(s.process.readKBs)} W ${formatRate(s.process.writeKBs)}\nClick: open panel · Detach via command`;
      procItem.command = "systemMonitor.openPanel";
    }
  } else if (cfg().get<boolean>("showProcess", true)) {
    procItem.show();
    procItem.text = "$(debug-alt) attach";
    procItem.tooltip = "Attach to a process — track its CPU / RAM";
    procItem.command = "systemMonitor.attachProcess";
  } else {
    procItem.hide();
  }

  history.push(s);
  panel.update(s);
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    paint(await collect(attached?.pid));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    cpuItem.text = "$(warning) sysmon";
    cpuItem.tooltip = msg;
  } finally {
    busy = false;
  }
}

function restartTimer() {
  if (timer) clearInterval(timer);
  const ms = Math.max(500, cfg().get<number>("intervalMs", 2000));
  timer = setInterval(() => void tick(), ms);
}

async function setCpuMode(mode: CpuChartsMode) {
  if (cpuMode() !== mode) {
    await cfg().update("cpuCharts", mode, vscode.ConfigurationTarget.Global);
  }
  panel.setCpuMode(mode);
}

async function setTimeWindow(win: TimeWindow) {
  if (timeWindow() !== win) {
    await cfg().update("timeWindow", win, vscode.ConfigurationTarget.Global);
  }
  panel.setTimeWindow(win);
}

function attachProcess(pick: ProcessPick) {
  if (attached) clearProcessSample(attached.pid);
  attached = pick;
  clearProcessSample(pick.pid);
  void vscode.window.setStatusBarMessage(
    `System Monitor: attached ${pick.name} (${pick.pid})`,
    2500,
  );
  void tick();
}

function detachProcess(notify = true) {
  if (attached) clearProcessSample(attached.pid);
  attached = null;
  if (notify) {
    void vscode.window.setStatusBarMessage("System Monitor: detached", 2000);
  }
  void tick();
}

async function pickAndAttach() {
  const picks = await listProcessPicks();
  if (!picks.length) {
    void vscode.window.showWarningMessage("System Monitor: no processes found");
    return;
  }
  const items = picks.slice(0, 250).map((p) => ({
    label: p.name,
    description: `PID ${p.pid}`,
    detail: `CPU ${p.cpu}% · ${p.memMb.toFixed(0)} MB`,
    pick: p,
  }));
  const chosen = await vscode.window.showQuickPick(items, {
    placeHolder: "Attach process to monitor CPU / RAM",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (chosen) attachProcess(chosen.pick);
}

async function tryAutoAttach(session: vscode.DebugSession) {
  if (!cfg().get<boolean>("autoAttachDebug", true)) return;
  await new Promise((r) => setTimeout(r, 900));
  try {
    const picks = await listProcessPicks();
    const match = matchDebugProcess(picks, {
      name: session.name,
      type: session.type,
      configuration: session.configuration as Record<string, unknown>,
    });
    if (match) {
      attachProcess(match);
      return;
    }
    const pick = await vscode.window.showInformationMessage(
      "System Monitor: could not auto-detect debug process",
      "Pick process",
    );
    if (pick === "Pick process") await pickAndAttach();
  } catch {
    /* ignore */
  }
}

export function activate(context: vscode.ExtensionContext) {
  panel = new SysMonPanelProvider(
    history,
    (mode) => void setCpuMode(mode),
    (win) => void setTimeWindow(win),
    {
      onAttach: () => void pickAndAttach(),
      onDetach: () => detachProcess(true),
    },
  );
  panel.setCpuMode(cpuMode());
  panel.setTimeWindow(timeWindow());

  cpuItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  memItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  diskItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  gpuItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  netItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
  procItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);

  cpuItem.command = "systemMonitor.toggleCpuCharts";
  memItem.command = "systemMonitor.openPanel";
  diskItem.command = "systemMonitor.openPanel";
  gpuItem.command = "systemMonitor.openPanel";
  netItem.command = "systemMonitor.openPanel";

  for (const item of [cpuItem, memItem, diskItem, gpuItem, netItem, procItem]) {
    item.show();
    context.subscriptions.push(item);
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, panel),
    vscode.commands.registerCommand("systemMonitor.toggleCpuCharts", async () => {
      await setCpuMode(cpuMode() === "total" ? "logical" : "total");
      void tick();
    }),
    vscode.commands.registerCommand("systemMonitor.refresh", () => void tick()),
    vscode.commands.registerCommand("systemMonitor.openPanel", async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand("systemMonitor.attachProcess", () => pickAndAttach()),
    vscode.commands.registerCommand("systemMonitor.detachProcess", () => detachProcess(true)),
    vscode.debug.onDidStartDebugSession((session) => void tryAutoAttach(session)),
    vscode.debug.onDidTerminateDebugSession(() => {
      if (cfg().get<boolean>("detachOnDebugEnd", false) && attached) {
        detachProcess(true);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("systemMonitor")) {
        panel.setCpuMode(cpuMode());
        panel.setTimeWindow(timeWindow());
        restartTimer();
        void tick();
      }
    }),
  );

  restartTimer();
  void tick();
}

export function deactivate() {
  if (timer) clearInterval(timer);
}
