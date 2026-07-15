# System Monitor — CPU RAM GPU Disk

Live system resources in the status bar and a Task Manager–style charts panel.

**Windows · macOS · Linux · WSL**

## Features

- **Status bar:** CPU %, RAM, disk R/W, GPU %/W, network ↓↑ — pick which via command
- **Sidebar panel:** smooth charts for CPU, memory, disk, GPU, network
- **RAM:** used / cache / free (+ available) with stacked history
- **CPU:** Total utilization **or** Logical processors mosaic (scales to many cores)
- **Multi-GPU:** util + temp + VRAM + power; copy `CUDA_VISIBLE_DEVICES`
- **Disk:** per-disk R/W + mount free/used
- **Time windows:** 1m / 5m / 30m (global switch for all charts)
- **Process attach:** top CPU list + NVIDIA GPU apps → Attach
- Works in **VS Code** and **Cursor**

## Install

### From marketplace (after publish)

- **Cursor / Open VSX:** search `System Monitor CPU RAM GPU Disk`
- **VS Code:** search the same name, or install `demontego.system-monitor`

### From VSIX

```bash
cursor --install-extension system-monitor-1.0.0.vsix
# or
code --install-extension system-monitor-1.0.0.vsix
```

Command Palette → **Extensions: Install from VSIX…**

## Usage

1. Open the **System Monitor** icon in the Activity Bar
2. Toggle CPU **Total** / **Logical processors**
3. Select a disk or GPU when several are present
4. Click status-bar CPU to switch chart mode; other metrics open the panel

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `systemMonitor.intervalMs` | `2000` | Poll interval (ms) |
| `systemMonitor.cpuCharts` | `total` | `total` or `logical` |
| `systemMonitor.timeWindow` | `5m` | `1m` / `5m` / `30m` |
| `systemMonitor.autoAttachDebug` | `true` | Auto-attach on debug start |
| `systemMonitor.detachOnDebugEnd` | `false` | Detach when debug ends |
| `systemMonitor.showCpu` / `showMem` / `showProcess` / `showGpu` / `showDisk` / `showNetwork` | `true` | Status bar toggles (or command **Configure Status Bar**) |

## Platform notes

- **Windows disks:** per-disk R/W via PhysicalDisk counters
- **Linux disks:** per-disk from `/sys/block/*/stat`
- **macOS disks:** disk list + aggregate I/O (cheap per-disk rates limited)
- **WSL:** guest resources; GPU via `nvidia-smi` (WSL path `/usr/lib/wsl/lib`)
- **GPU % / temp:** NVIDIA via nvidia-smi; other vendors depend on OS APIs

## Develop

```bash
npm install
npm run compile
npx vsce package
```

## License

MIT
