# Changelog

## 1.5.2

- GPU cards: stacked title/metrics (no overlap in 2-col); shorter labels + tooltips

## 1.5.1

- Windows GPU process list: basename only, hide desktop noise / N/A / &lt;64 MiB VRAM
- Fix Windows process owner lookup; Apple Silicon: show GPU cores (+ Metal) from SI

## 1.5.0

- GPU processes: per-GPU index, username, docker/k8s container tag (shared SSH boxes)

## 1.4.2

- Chart sections framed; Network panel above Process

## 1.4.1

- Distinct chart colors per metric (CPU / RAM / disk / GPU / net / process)

## 1.4.0

- RAM breakdown: **used / cache / free** (+ available) with stacked chart
- GPU power draw (W) via nvidia-smi; copy `CUDA_VISIBLE_DEVICES` from panel
- Disk mounts: free/used with filters for virtual filesystems
- Top processes + NVIDIA compute apps → Attach from panel
- Status bar metric picker (`Configure Status Bar`); `showCpu` / `showMem` settings
- Load average in CPU tooltip (Unix)
- Panel visual: teal silhouette charts, minimal grid, dashboard-style titles

## 1.3.0

- Collapsible panels (click section header; state persisted)
- GPU VRAM used/total + memory % on charts
- Multi-GPU layout: 2 columns when 2+ GPUs

## 1.2.1

- Fix WSL GPU detection: use `nvidia-smi` directly (systeminformation returns empty controllers in WSL2)

## 1.2.0

- Attach process: track CPU / RAM (+ disk I/O on Linux) for a chosen PID
- QuickPick attach, panel Attach/Detach, status bar control
- Optional auto-attach on debug session start

## 1.1.0

- GPU temperature (°C) when the driver exposes it (NVIDIA via nvidia-smi, etc.)
- All GPUs charted at once (util + temp)
- Global time window: 1m / 5m / 30m for every chart

## 1.0.0

- Public release as **System Monitor — CPU RAM GPU Disk**
- Status bar: CPU, RAM, disk, GPU, network
- Sidebar charts; CPU Total / Logical processors mosaic
- Multi-GPU and multi-disk selectors
- Windows, macOS, Linux, WSL
