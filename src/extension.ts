import * as vscode from "vscode";
import { History } from "./history";
import { collect, formatRate, type Snapshot } from "./monitor";
import { SysMonPanelProvider, VIEW_ID, type CpuChartsMode } from "./panel";

let timer: ReturnType<typeof setInterval> | undefined;
let cpuItem: vscode.StatusBarItem;
let memItem: vscode.StatusBarItem;
let diskItem: vscode.StatusBarItem;
let gpuItem: vscode.StatusBarItem;
let netItem: vscode.StatusBarItem;
let busy = false;
let panel: SysMonPanelProvider;
const history = new History();

function cfg() {
  return vscode.workspace.getConfiguration("systemMonitor");
}

function cpuMode(): CpuChartsMode {
  const v = cfg().get<string>("cpuCharts", "total");
  return v === "logical" ? "logical" : "total";
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
    gpuItem.text =
      s.gpuPct != null ? `$(circuit-board) ${s.gpuPct}%` : `$(circuit-board) —`;
    gpuItem.tooltip =
      s.gpus.length <= 1
        ? s.gpuLabel
        : s.gpus.map((g) => `${g.name}: ${g.util == null ? "n/a" : g.util + "%"}`).join("\n");
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

  history.push(s);
  panel.update(s);
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    paint(await collect());
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

export function activate(context: vscode.ExtensionContext) {
  panel = new SysMonPanelProvider(history, (mode) => {
    void setCpuMode(mode);
  });
  panel.setCpuMode(cpuMode());

  cpuItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  memItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  diskItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  gpuItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  netItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);

  cpuItem.command = "systemMonitor.toggleCpuCharts";
  memItem.command = "systemMonitor.openPanel";
  diskItem.command = "systemMonitor.openPanel";
  gpuItem.command = "systemMonitor.openPanel";
  netItem.command = "systemMonitor.openPanel";

  for (const item of [cpuItem, memItem, diskItem, gpuItem, netItem]) {
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
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("systemMonitor")) {
        panel.setCpuMode(cpuMode());
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
