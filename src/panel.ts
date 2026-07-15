import * as vscode from "vscode";
import type { History } from "./history";
import type { Snapshot } from "./monitor";

export const VIEW_ID = "systemMonitor.panel";

export type CpuChartsMode = "total" | "logical";
export type TimeWindow = "1m" | "5m" | "30m";

export class SysMonPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private last?: Snapshot;
  private cpuMode: CpuChartsMode = "total";
  private timeWindow: TimeWindow = "5m";

  constructor(
    private readonly history: History,
    private readonly onCpuMode: (mode: CpuChartsMode) => void,
    private readonly onTimeWindow: (win: TimeWindow) => void,
    private readonly actions?: { onAttach?: () => void; onDetach?: () => void },
  ) {}

  setCpuMode(mode: CpuChartsMode) {
    this.cpuMode = mode;
    this.flush();
  }

  setTimeWindow(win: TimeWindow) {
    this.timeWindow = win;
    this.flush();
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "cpuMode" && (msg.mode === "total" || msg.mode === "logical")) {
        this.cpuMode = msg.mode;
        this.onCpuMode(msg.mode);
        this.flush();
      }
      if (
        msg?.type === "timeWindow" &&
        (msg.win === "1m" || msg.win === "5m" || msg.win === "30m")
      ) {
        this.timeWindow = msg.win;
        this.onTimeWindow(msg.win);
        this.flush();
      }
      if (msg?.type === "attach") this.actions?.onAttach?.();
      if (msg?.type === "detach") this.actions?.onDetach?.();
    });
    this.flush();
  }

  update(s: Snapshot) {
    this.last = s;
    this.flush();
  }

  private flush() {
    if (!this.view) return;
    this.view.webview.postMessage({
      type: "tick",
      points: this.history.snapshot(),
      live: this.last,
      cpuMode: this.cpuMode,
      timeWindow: this.timeWindow,
    });
  }

  private html(webview: vscode.Webview): string {
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'unsafe-inline'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root {
    --fg: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --line: var(--vscode-widget-border, var(--vscode-panel-border, rgba(127,127,127,.28)));
    --surface: color-mix(in srgb, var(--vscode-editor-background) 72%, var(--vscode-foreground) 6%);
    --surface2: color-mix(in srgb, var(--vscode-sideBar-background, var(--vscode-editor-background)) 88%, var(--vscode-foreground) 4%);
    --btn: var(--vscode-button-secondaryBackground, color-mix(in srgb, var(--fg) 12%, transparent));
    --btn-fg: var(--vscode-button-secondaryForeground, var(--fg));
    --btn-on: var(--vscode-button-background, #0e639c);
    --btn-on-fg: var(--vscode-button-foreground, #fff);
    --accent: var(--vscode-charts-blue, #4ea1ff);
    --accent2: var(--vscode-charts-green, #73c991);
    --accent3: var(--vscode-charts-yellow, #d7ba7d);
    --accent4: var(--vscode-charts-red, #f14c4c);
    --accent5: var(--vscode-charts-orange, #ce9178);
    --mono: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 14px 12px 20px;
    color: var(--fg);
    font: 12px/1.45 var(--vscode-font-family);
    background:
      radial-gradient(120% 60% at 0% 0%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 55%),
      var(--vscode-sideBar-background, var(--vscode-editor-background));
  }
  .hero { margin-bottom: 14px; }
  .brand-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }
  .brand {
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
  }
  #gpuList {
    display: grid;
    grid-template-columns: 1fr;
    gap: 8px;
  }
  #gpuList.cols-2 {
    grid-template-columns: 1fr 1fr;
  }
  .gpu-block {
    margin: 0;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 6px;
    background: var(--surface2);
    min-width: 0;
  }
  .gpu-head {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    padding: 0 2px 6px;
    font-size: 10px;
  }
  .gpu-head b {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
  }
  .gpu-block canvas.main {
    height: 72px;
  }
  canvas.temp {
    width: 100%;
    height: 48px;
    display: block;
  }
  .hero-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 14px;
    align-items: baseline;
  }
  .hero-stat {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .hero-stat small {
    font-size: 10px;
    font-weight: 500;
    color: var(--muted);
    margin-left: 4px;
    letter-spacing: 0;
  }
  .meta {
    margin-top: 8px;
    color: var(--muted);
    font-size: 11px;
    word-break: break-word;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px 10px 8px;
    margin-bottom: 10px;
    position: relative;
    overflow: hidden;
  }
  .card::before {
    content: "";
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 3px;
    background: var(--tone, var(--accent));
    opacity: 0.85;
  }
  .card.cpu { --tone: var(--accent); }
  .card.mem { --tone: var(--accent2); }
  .card.gpu { --tone: var(--accent3); }
  .card.disk { --tone: var(--accent5); }
  .card.net { --tone: var(--accent4); }
  .card.proc { --tone: var(--vscode-charts-purple, #b180d7); }
  .card.proc.hidden { display: none; }
  .card.collapsed .card-body { display: none; }
  .card .chev {
    display: inline-block;
    width: 1em;
    margin-right: 4px;
    transition: transform .12s ease;
    opacity: 0.75;
  }
  .card.collapsed .chev { transform: rotate(-90deg); }
  .card .head {
    cursor: pointer;
    user-select: none;
  }
  .card .head .seg,
  .card .head .seg button {
    cursor: pointer;
  }
  .linkish {
    appearance: none;
    border: 0;
    background: transparent;
    color: var(--vscode-textLink-foreground, var(--accent));
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding-left: 6px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  .label {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: 600;
  }
  .val {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    font-weight: 600;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--line);
    border-radius: 7px;
    overflow: hidden;
  }
  .seg button {
    appearance: none;
    border: 0;
    margin: 0;
    padding: 4px 9px;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .seg button.on {
    background: var(--btn-on);
    color: var(--btn-on-fg);
  }
  .plot {
    position: relative;
    border-radius: 8px;
    background: var(--surface2);
    overflow: hidden;
  }
  canvas.main {
    width: 100%;
    height: 96px;
    display: block;
  }
  .logical-wrap {
    border-radius: 6px;
    background: var(--surface2);
    overflow: hidden;
    border: 1px solid var(--line);
  }
  .logical-wrap.hidden, .plot.hidden { display: none; }
  #cpuLogical {
    width: 100%;
    display: block;
    /* height set in JS from core count */
    height: 120px;
    cursor: crosshair;
  }
  .logical-hint {
    font-size: 10px;
    color: var(--muted);
    padding: 5px 6px 0;
    font-variant-numeric: tabular-nums;
    min-height: 1.2em;
  }
  .seg.wrap {
    flex-wrap: wrap;
    max-width: 100%;
  }
  .seg.wrap button {
    max-width: 110px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dev-meta {
    font-size: 10px;
    color: var(--muted);
    padding: 0 6px 6px;
    word-break: break-word;
  }
  .legend {
    display: flex;
    gap: 12px;
    padding: 6px 6px 0;
    color: var(--muted);
    font-size: 10px;
  }
  .legend i {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 4px;
    vertical-align: middle;
  }
</style>
</head>
<body>
  <div class="hero">
    <div class="brand-row">
      <div class="brand">System Monitor</div>
      <div class="seg" id="winSeg">
        <button type="button" data-win="1m">1m</button>
        <button type="button" data-win="5m" class="on">5m</button>
        <button type="button" data-win="30m">30m</button>
      </div>
    </div>
    <div class="hero-row">
      <div class="hero-stat" id="hCpu">—<small>cpu</small></div>
      <div class="hero-stat" id="hMem">—<small>ram</small></div>
      <div class="hero-stat" id="hDisk">—<small>disk</small></div>
      <div class="hero-stat" id="hGpu">—<small>gpu</small></div>
    </div>
    <div class="meta" id="meta">waiting…</div>
  </div>

  <section class="card cpu" data-panel="cpu">
    <div class="head">
      <span class="label"><span class="chev">▾</span>CPU</span>
      <div class="seg" id="cpuSeg">
        <button type="button" data-mode="total" class="on">Total</button>
        <button type="button" data-mode="logical">Logical processors</button>
      </div>
      <span class="val" id="cpuVal">—</span>
    </div>
    <div class="card-body">
      <div class="plot" id="cpuTotalPlot"><canvas class="main" id="cpu"></canvas></div>
      <div class="logical-wrap hidden" id="cpuLogicalWrap">
        <canvas id="cpuLogical"></canvas>
        <div class="logical-hint" id="logicalHint">hover a cell</div>
      </div>
    </div>
  </section>

  <section class="card mem" data-panel="mem">
    <div class="head">
      <span class="label"><span class="chev">▾</span>Memory</span>
      <span class="val" id="memVal">—</span>
    </div>
    <div class="card-body">
      <div class="plot"><canvas class="main" id="mem"></canvas></div>
    </div>
  </section>

  <section class="card disk" data-panel="disk">
    <div class="head">
      <span class="label"><span class="chev">▾</span>Disk</span>
      <div class="seg wrap" id="diskSeg"></div>
      <span class="val" id="diskVal">—</span>
    </div>
    <div class="card-body">
      <div class="dev-meta" id="diskMeta"></div>
      <div class="plot"><canvas class="main" id="disk"></canvas></div>
      <div class="legend">
        <span><i style="background:var(--accent5)"></i>read</span>
        <span><i style="background:var(--accent)"></i>write</span>
      </div>
    </div>
  </section>

  <section class="card gpu" data-panel="gpu">
    <div class="head">
      <span class="label"><span class="chev">▾</span>GPU</span>
      <span class="val" id="gpuVal">—</span>
    </div>
    <div class="card-body">
      <div id="gpuList"></div>
    </div>
  </section>

  <section class="card proc" id="procCard" data-panel="proc">
    <div class="head">
      <span class="label"><span class="chev">▾</span>Process</span>
      <div class="seg">
        <button type="button" id="attachBtn">Attach</button>
        <button type="button" id="detachBtn">Detach</button>
      </div>
      <span class="val" id="procVal">—</span>
    </div>
    <div class="card-body">
      <div class="dev-meta" id="procMeta">Not attached — track CPU / RAM of a debuggee or any PID</div>
      <div class="plot" id="procPlot"><canvas class="main" id="proc"></canvas></div>
      <div class="legend">
        <span><i style="background:var(--vscode-charts-purple, #b180d7)"></i>cpu %</span>
        <span><i style="background:var(--accent2)"></i>mem (scaled)</span>
      </div>
    </div>
  </section>

  <section class="card net" data-panel="net">
    <div class="head">
      <span class="label"><span class="chev">▾</span>Network</span>
      <span class="val" id="netVal">—</span>
    </div>
    <div class="card-body">
      <div class="plot"><canvas class="main" id="net"></canvas></div>
      <div class="legend">
        <span><i style="background:var(--accent)"></i>down</span>
        <span><i style="background:var(--accent4)"></i>up</span>
      </div>
    </div>
  </section>

<script>
const vscodeApi = acquireVsCodeApi();
const dpr = () => window.devicePixelRatio || 1;
let cpuMode = 'total';
let timeWindow = '5m';
/** @type {{cols:number,rows:number,gap:number,n:number,cssW:number,cssH:number}|null} */
let logicalLayout = null;
let hoverCore = -1;
let selectedDisk = 0;
let gpuReady = 0;

function windowMinutes(win) {
  if (win === '1m') return 1;
  if (win === '30m') return 30;
  return 5;
}

function filterWindow(pts, win) {
  const cut = Date.now() - windowMinutes(win) * 60 * 1000;
  return (pts || []).filter(p => p.t >= cut);
}

function setWinUI(win) {
  timeWindow = win;
  document.querySelectorAll('#winSeg button').forEach(b => {
    b.classList.toggle('on', b.getAttribute('data-win') === win);
  });
}

document.getElementById('winSeg').addEventListener('click', e => {
  const btn = e.target.closest('button[data-win]');
  if (!btn) return;
  const win = btn.getAttribute('data-win');
  setWinUI(win);
  vscodeApi.postMessage({ type: 'timeWindow', win });
  if (lastMsg) paint(lastMsg);
});

document.getElementById('attachBtn').addEventListener('click', () => {
  vscodeApi.postMessage({ type: 'attach' });
});
document.getElementById('detachBtn').addEventListener('click', () => {
  vscodeApi.postMessage({ type: 'detach' });
});

const foldState = (vscodeApi.getState && vscodeApi.getState()) || {};
const collapsed = foldState.collapsed || {};
document.querySelectorAll('.card[data-panel]').forEach(card => {
  const key = card.getAttribute('data-panel');
  if (collapsed[key]) card.classList.add('collapsed');
  const head = card.querySelector('.head');
  if (!head) return;
  head.addEventListener('click', (e) => {
    if (e.target.closest('button, .seg')) return;
    card.classList.toggle('collapsed');
    collapsed[key] = card.classList.contains('collapsed');
    vscodeApi.setState({ collapsed });
    if (lastMsg && !card.classList.contains('collapsed')) paint(lastMsg);
  });
});

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function size(canvas) {
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(r.width * dpr()));
  const h = Math.max(1, Math.floor(r.height * dpr()));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h };
}

function ema(values, alpha) {
  if (!values.length) return values;
  const out = new Array(values.length);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    out[i] = out[i - 1] + alpha * (values[i] - out[i - 1]);
  }
  return out;
}

function toXY(values, maxY, w, h, pad) {
  const n = values.length;
  const m = maxY > 0 ? maxY : 1;
  return values.map((v, i) => ({
    x: n === 1 ? w / 2 : pad + (i / (n - 1)) * (w - pad * 2),
    y: h - pad - (Math.min(Math.max(v, 0), m) / m) * (h - pad * 2),
  }));
}

function strokeSmooth(ctx, pts) {
  if (pts.length < 2) {
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, 2 * dpr(), 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    ctx.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6,
      p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6,
      p2.y - (p3.y - p1.y) / 6,
      p2.x, p2.y
    );
  }
  ctx.stroke();
}

function fillSmooth(ctx, pts, w, h, color) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, h);
  ctx.lineTo(pts[0].x, pts[0].y);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    ctx.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6,
      p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6,
      p2.y - (p3.y - p1.y) / 6,
      p2.x, p2.y
    );
  }
  ctx.lineTo(pts[pts.length - 1].x, h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, hexAlpha(color, 0.28));
  grad.addColorStop(1, hexAlpha(color, 0.02));
  ctx.fillStyle = grad;
  ctx.fill();
}

function hexAlpha(c, a) {
  c = (c || '#4ea1ff').trim();
  if (c.startsWith('#')) {
    let h = c.slice(1);
    if (h.length === 3) h = h.split('').map(x => x + x).join('');
    if (h.length >= 6) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }
  }
  if (c.startsWith('rgb(')) return c.replace('rgb(', 'rgba(').replace(')', ',' + a + ')');
  return c;
}

function drawGrid(ctx, w, h, pad, lines) {
  const n = lines == null ? 3 : lines;
  if (n <= 0) return;
  const grid = cssVar('--line', 'rgba(127,127,127,.25)');
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.35;
  for (let i = 1; i <= n; i++) {
    const y = pad + ((h - pad * 2) / (n + 1)) * i;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function chart(canvas, values, maxY, color, opts) {
  opts = opts || {};
  const { w, h } = size(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const pad = (opts.pad || 6) * dpr();
  drawGrid(ctx, w, h, pad, opts.grid == null ? 3 : opts.grid);
  if (!values.length) return;
  const smoothed = ema(values, opts.alpha == null ? 0.38 : opts.alpha);
  const pts = toXY(smoothed, maxY, w, h, pad);
  if (!opts.noFill) fillSmooth(ctx, pts, w, h, color);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = (opts.lw || 2) * dpr();
  strokeSmooth(ctx, pts);
  if (!opts.noDot) {
    const tip = pts[pts.length - 1];
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(tip.x, tip.y, 2.2 * dpr(), 0, Math.PI * 2);
    ctx.fill();
  }
}

function dualChart(canvas, a, b, maxY, ca, cb) {
  const { w, h } = size(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const pad = 6 * dpr();
  drawGrid(ctx, w, h, pad, 3);
  if (!a.length) return;
  const aPts = toXY(ema(a, 0.4), maxY, w, h, pad);
  const bPts = toXY(ema(b, 0.4), maxY, w, h, pad);
  fillSmooth(ctx, aPts, w, h, ca);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.strokeStyle = ca; ctx.lineWidth = 2 * dpr(); strokeSmooth(ctx, aPts);
  fillSmooth(ctx, bPts, w, h, cb);
  ctx.strokeStyle = cb; strokeSmooth(ctx, bPts);
}

function fillSeries(series) {
  return series.map((v, i) => {
    if (v != null) return v;
    let L = i - 1, R = i + 1;
    while (L >= 0 && series[L] == null) L--;
    while (R < series.length && series[R] == null) R++;
    if (L >= 0 && R < series.length) return (series[L] + series[R]) / 2;
    if (L >= 0) return series[L];
    if (R < series.length) return series[R];
    return 0;
  });
}

/** util % + VRAM % + temp °C */
function gpuChart(canvas, util, memPct, temp, colorU, colorM, colorT) {
  const { w, h } = size(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const pad = 5 * dpr();
  drawGrid(ctx, w, h, pad, 2);
  if (!util.length) return;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const uPts = toXY(ema(util, 0.38), 100, w, h, pad);
  fillSmooth(ctx, uPts, w, h, colorU);
  ctx.strokeStyle = colorU; ctx.lineWidth = 1.8 * dpr(); strokeSmooth(ctx, uPts);
  if (memPct.some(v => v != null)) {
    const mPts = toXY(ema(fillSeries(memPct), 0.38), 100, w, h, pad);
    ctx.strokeStyle = colorM; ctx.lineWidth = 1.5 * dpr(); strokeSmooth(ctx, mPts);
  }
  if (temp.some(v => v != null)) {
    const filled = fillSeries(temp);
    const maxT = Math.max(80, ...filled) * 1.05;
    const tPts = toXY(ema(filled, 0.35), maxT, w, h, pad);
    ctx.strokeStyle = colorT; ctx.lineWidth = 1.4 * dpr(); strokeSmooth(ctx, tPts);
  }
}

function ensureGpuCards(n) {
  const list = document.getElementById('gpuList');
  list.classList.toggle('cols-2', n >= 2);
  if (gpuReady === n && list.children.length === n) return;
  gpuReady = n;
  list.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div');
    el.className = 'gpu-block';
    el.innerHTML =
      '<div class="gpu-head"><span id="gpuName' + i + '">GPU ' + i + '</span>' +
      '<b id="gpuLive' + i + '">—</b></div>' +
      '<div class="plot"><canvas class="main" id="gpuC' + i + '"></canvas></div>' +
      '<div class="legend">' +
      '<span><i style="background:var(--accent3)"></i>util</span>' +
      '<span><i style="background:var(--accent2)"></i>vram</span>' +
      '<span><i style="background:var(--accent4)"></i>temp</span>' +
      '</div>';
    list.appendChild(el);
  }
}

function fmtVram(mb) {
  if (mb == null) return '';
  if (mb >= 1024) return (mb / 1024).toFixed(1) + 'G';
  return Math.round(mb) + 'M';
}

function fmtRate(k) {
  if (k >= 1024 * 1024) return (k / 1024 / 1024).toFixed(1) + 'G';
  if (k >= 1024) return (k / 1024).toFixed(1) + 'M';
  return Math.round(k) + 'K';
}

/** Task Manager-ish packing for sidebar width */
function packLogical(n, cssW) {
  const minCell = n > 64 ? 22 : n > 32 ? 28 : n > 16 ? 40 : 52;
  const maxCols = Math.max(2, Math.floor((cssW - 2) / minCell));
  let cols = Math.min(n, Math.max(2, Math.ceil(Math.sqrt(n))));
  // prefer wider grids in narrow panels so rows stay short
  cols = Math.min(Math.max(cols, Math.ceil(n / Math.max(3, Math.ceil(Math.sqrt(n))))), maxCols);
  cols = Math.min(n, Math.max(2, cols));
  const rows = Math.ceil(n / cols);
  const cellH = n > 64 ? 18 : n > 32 ? 22 : n > 24 ? 26 : n > 16 ? 30 : n > 8 ? 34 : 40;
  const gap = n > 32 ? 1 : 2;
  return { cols, rows, cellH, gap };
}

function downsample(values, maxPts) {
  if (values.length <= maxPts) return values;
  const out = [];
  const step = (values.length - 1) / (maxPts - 1);
  for (let i = 0; i < maxPts; i++) out.push(values[Math.round(i * step)]);
  return out;
}

function strokePoly(ctx, pts) {
  if (!pts.length) return;
  ctx.beginPath();
  pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
  ctx.stroke();
}

function drawLogicalMosaic(canvas, history, liveCores, color) {
  const n = liveCores.length || (history[0] && history[0].cpuCores && history[0].cpuCores.length) || 0;
  if (!n) return;

  const cssW = Math.max(80, canvas.clientWidth || canvas.getBoundingClientRect().width);
  const layout = packLogical(n, cssW);
  const cssH = layout.rows * layout.cellH + (layout.rows + 1) * layout.gap;
  canvas.style.height = cssH + 'px';

  const scale = dpr();
  const w = Math.max(1, Math.floor(cssW * scale));
  const h = Math.max(1, Math.floor(cssH * scale));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  logicalLayout = { cols: layout.cols, rows: layout.rows, gap: layout.gap * scale, n, cssW, cssH };

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  const gap = layout.gap * scale;
  const cellW = (w - gap * (layout.cols + 1)) / layout.cols;
  const cellH = layout.cellH * scale;
  const dense = n > 32;
  const ultra = n > 64;
  const maxPts = ultra ? 24 : dense ? 40 : 60;
  const lineW = (ultra ? 0.9 : dense ? 1.1 : 1.35) * scale;
  const pad = (ultra ? 1 : 2) * scale;
  const border = cssVar('--line', 'rgba(127,127,127,.35)');

  for (let i = 0; i < n; i++) {
    const col = i % layout.cols;
    const row = Math.floor(i / layout.cols);
    const x0 = gap + col * (cellW + gap);
    const y0 = gap + row * (cellH + gap);

    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(x0, y0, cellW, cellH);
    ctx.strokeStyle = border;
    ctx.globalAlpha = hoverCore === i ? 0.9 : 0.4;
    ctx.lineWidth = hoverCore === i ? 1.5 * scale : 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, cellW - 1, cellH - 1);
    ctx.globalAlpha = 1;

    let series = history.map(p => (p.cpuCores && p.cpuCores[i] != null) ? p.cpuCores[i] : 0);
    series = downsample(ema(series, dense ? 0.5 : 0.38), maxPts);
    const live = liveCores[i] != null ? liveCores[i] : series[series.length - 1] || 0;

    if (ultra) {
      // heat wash + micro sparkline — readable at 128 threads
      ctx.fillStyle = hexAlpha(color, 0.08 + (live / 100) * 0.35);
      ctx.fillRect(x0 + 1, y0 + 1, cellW - 2, cellH - 2);
    }

    const innerW = cellW - pad * 2;
    const innerH = cellH - pad * 2;
    const pts = series.map((v, idx) => ({
      x: x0 + pad + (series.length === 1 ? innerW / 2 : (idx / (series.length - 1)) * innerW),
      y: y0 + pad + innerH - (Math.min(100, Math.max(0, v)) / 100) * innerH,
    }));

    if (!ultra && series.length > 1) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, y0 + cellH - pad);
      pts.forEach(p => ctx.lineTo(p.x, p.y));
      ctx.lineTo(pts[pts.length - 1].x, y0 + cellH - pad);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, y0, 0, y0 + cellH);
      g.addColorStop(0, hexAlpha(color, 0.22));
      g.addColorStop(1, hexAlpha(color, 0.02));
      ctx.fillStyle = g;
      ctx.fill();
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = lineW;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (dense || ultra) strokePoly(ctx, pts);
    else strokeSmooth(ctx, pts);
  }
}

function hitLogicalCore(ev) {
  if (!logicalLayout) return -1;
  const canvas = document.getElementById('cpuLogical');
  const r = canvas.getBoundingClientRect();
  const x = ev.clientX - r.left;
  const y = ev.clientY - r.top;
  const { cols, rows, gap, n, cssW, cssH } = logicalLayout;
  const gapCss = gap / dpr();
  const cellW = (cssW - gapCss * (cols + 1)) / cols;
  const cellH = (cssH - gapCss * (rows + 1)) / rows;
  const col = Math.floor((x - gapCss) / (cellW + gapCss));
  const row = Math.floor((y - gapCss) / (cellH + gapCss));
  if (col < 0 || row < 0 || col >= cols || row >= rows) return -1;
  const i = row * cols + col;
  return i < n ? i : -1;
}

function syncSeg(elId, items, selected, onPick) {
  const el = document.getElementById(elId);
  if (!el) return;
  const key = items.map(it => it.id + ':' + it.label).join('|');
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    el.innerHTML = items.map((it, i) =>
      '<button type="button" data-i="' + i + '"' + (i === selected ? ' class="on"' : '') + ' title="' +
      String(it.title || it.label).replace(/"/g, '&quot;') + '">' + it.label + '</button>'
    ).join('');
    el.onclick = (e) => {
      const btn = e.target.closest('button[data-i]');
      if (!btn) return;
      onPick(parseInt(btn.getAttribute('data-i'), 10));
    };
  } else {
    el.querySelectorAll('button[data-i]').forEach(b => {
      b.classList.toggle('on', parseInt(b.getAttribute('data-i'), 10) === selected);
    });
  }
  if (!items.length) el.innerHTML = '';
}

function setModeUI(mode) {
  cpuMode = mode;
  document.querySelectorAll('#cpuSeg button').forEach(b => {
    b.classList.toggle('on', b.getAttribute('data-mode') === mode);
  });
  document.getElementById('cpuTotalPlot').classList.toggle('hidden', mode === 'logical');
  document.getElementById('cpuLogicalWrap').classList.toggle('hidden', mode !== 'logical');
}

document.getElementById('cpuSeg').addEventListener('click', e => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  const mode = btn.getAttribute('data-mode');
  setModeUI(mode);
  vscodeApi.postMessage({ type: 'cpuMode', mode });
  if (lastMsg) paint(lastMsg);
});

const logicalCanvas = document.getElementById('cpuLogical');
logicalCanvas.addEventListener('mousemove', ev => {
  const i = hitLogicalCore(ev);
  if (i === hoverCore) return;
  hoverCore = i;
  const hint = document.getElementById('logicalHint');
  if (i < 0 || !lastMsg || !lastMsg.live) {
    hint.textContent = 'hover a cell';
  } else {
    const v = lastMsg.live.cpuCores[i];
    hint.textContent = 'CPU ' + i + ' · ' + v + '%';
  }
  if (lastMsg && cpuMode === 'logical') paint(lastMsg);
});
logicalCanvas.addEventListener('mouseleave', () => {
  hoverCore = -1;
  document.getElementById('logicalHint').textContent = 'hover a cell';
  if (lastMsg && cpuMode === 'logical') paint(lastMsg);
});

function paint(msg) {
  const live = msg.live;
  if (msg.cpuMode) setModeUI(msg.cpuMode);
  if (msg.timeWindow) setWinUI(msg.timeWindow);
  const pts = filterWindow(msg.points || [], timeWindow);

  const accent = cssVar('--accent', '#4ea1ff');
  const a2 = cssVar('--accent2', '#73c991');
  const a3 = cssVar('--accent3', '#d7ba7d');
  const a4 = cssVar('--accent4', '#f14c4c');
  const a5 = cssVar('--accent5', '#ce9178');

  if (live) {
    document.getElementById('meta').textContent =
      live.platform + (live.gpuLabel ? ' · ' + live.gpuLabel : '') +
      ' · window ' + timeWindow;
    document.getElementById('hCpu').innerHTML = live.cpuTotal + '%<small>cpu</small>';
    document.getElementById('hMem').innerHTML = live.memPct.toFixed(0) + '%<small>ram</small>';
    document.getElementById('hDisk').innerHTML =
      fmtRate(live.diskReadKBs + live.diskWriteKBs) + '/s<small>disk</small>';
    const gpuHero =
      (live.gpuPct == null ? '—' : live.gpuPct + '%') +
      (live.gpuTemp != null ? ' ' + live.gpuTemp + '°' : '');
    document.getElementById('hGpu').innerHTML = gpuHero + '<small>gpu</small>';

    document.getElementById('cpuVal').textContent =
      live.cpuTotal + '% · ' + (live.cpuCores || []).length + ' logical';
    document.getElementById('memVal').textContent =
      live.memUsedGb.toFixed(1) + ' / ' + live.memTotalGb.toFixed(1) + ' GB';

    const disks = live.disks || [];
    if (selectedDisk >= disks.length) selectedDisk = 0;
    syncSeg(
      'diskSeg',
      disks.map((d, i) => ({
        id: d.id,
        label: disks.length === 1 ? '0' : String(i),
        title: d.name + (d.kind ? ' · ' + d.kind : ''),
      })),
      selectedDisk,
      (i) => { selectedDisk = i; if (lastMsg) paint(lastMsg); },
    );
    const disk = disks[selectedDisk];
    if (disk) {
      document.getElementById('diskMeta').textContent =
        disk.name + (disk.kind ? ' · ' + disk.kind : '') +
        (disk.busyPct != null ? ' · ' + disk.busyPct + '% busy' : '');
      document.getElementById('diskVal').textContent =
        'R ' + fmtRate(disk.readKBs) + '  W ' + fmtRate(disk.writeKBs);
    } else {
      document.getElementById('diskMeta').textContent = '';
      document.getElementById('diskVal').textContent = '—';
    }

    const gpus = live.gpus || [];
    const vramBits = gpus
      .filter(g => g.memUsedMb != null && g.memTotalMb)
      .map(g => fmtVram(g.memUsedMb) + '/' + fmtVram(g.memTotalMb));
    document.getElementById('gpuVal').textContent =
      gpus.length + ' GPU' +
      (live.gpuPct != null ? ' · ' + live.gpuPct + '%' : '') +
      (live.gpuTemp != null ? ' · ' + live.gpuTemp + '°' : '') +
      (vramBits.length ? ' · ' + vramBits[0] + (vramBits.length > 1 ? '…' : '') : '');
    ensureGpuCards(gpus.length);
    gpus.forEach((g, i) => {
      const nameEl = document.getElementById('gpuName' + i);
      const liveEl = document.getElementById('gpuLive' + i);
      if (nameEl) nameEl.textContent = 'GPU ' + i + ' · ' + g.name;
      if (liveEl) {
        const u = g.util == null ? 'n/a' : g.util + '%';
        const t = g.temp == null ? '' : ' · ' + g.temp + '°';
        const m =
          g.memUsedMb != null && g.memTotalMb
            ? ' · ' + fmtVram(g.memUsedMb) + '/' + fmtVram(g.memTotalMb)
            : '';
        liveEl.textContent = u + t + m;
      }
    });

    document.getElementById('netVal').textContent =
      '↓ ' + fmtRate(live.netDownKBs) + '  ↑ ' + fmtRate(live.netUpKBs);
  }

  const nCores = (live && live.cpuCores && live.cpuCores.length)
    || (pts[0] && pts[0].cpuCores && pts[0].cpuCores.length)
    || 0;

  if (cpuMode === 'logical' && nCores) {
    drawLogicalMosaic(
      document.getElementById('cpuLogical'),
      pts,
      (live && live.cpuCores) || [],
      accent,
    );
  } else {
    chart(document.getElementById('cpu'), pts.map(p => p.cpu), 100, accent);
  }

  chart(document.getElementById('mem'), pts.map(p => p.mem), 100, a2);

  const nGpu = (live && live.gpus && live.gpus.length)
    || (pts[0] && pts[0].gpuUtils && pts[0].gpuUtils.length)
    || 0;
  for (let i = 0; i < nGpu; i++) {
    const c = document.getElementById('gpuC' + i);
    if (!c) continue;
    const util = pts.map(p => {
      const v = p.gpuUtils && p.gpuUtils[i];
      return v == null ? 0 : v;
    });
    const memPct = pts.map(p =>
      (p.gpuMemPct && p.gpuMemPct[i] != null) ? p.gpuMemPct[i] : null
    );
    const temp = pts.map(p => (p.gpuTemps && p.gpuTemps[i] != null) ? p.gpuTemps[i] : null);
    gpuChart(c, util, memPct, temp, a3, a2, a4);
  }

  const diskR = pts.map(p => (p.diskReads && p.diskReads[selectedDisk]) || 0);
  const diskW = pts.map(p => (p.diskWrites && p.diskWrites[selectedDisk]) || 0);
  dualChart(document.getElementById('disk'), diskR, diskW, Math.max(1, ...diskR, ...diskW), a5, accent);

  const proc = live && live.process && live.process.alive ? live.process : null;
  const procColor = cssVar('--vscode-charts-purple', '#b180d7');
  if (proc) {
    document.getElementById('procMeta').textContent =
      proc.name + ' · PID ' + proc.pid +
      (proc.readKBs + proc.writeKBs > 0
        ? ' · R ' + fmtRate(proc.readKBs) + ' W ' + fmtRate(proc.writeKBs)
        : '');
    document.getElementById('procVal').textContent =
      proc.cpu.toFixed(1) + '% · ' + proc.memMb.toFixed(0) + ' MB';
    const pCpu = pts.map(p => (p.procCpu == null ? 0 : p.procCpu));
    const pMem = pts.map(p => (p.procMemMb == null ? 0 : p.procMemMb));
    const maxMem = Math.max(64, ...pMem);
    // mem scaled onto same 0–maxCpu axis visually via dualScale: reuse utilTemp style
    const maxCpu = Math.max(100, ...pCpu);
    const memAsCpu = pMem.map(m => (m / maxMem) * maxCpu);
    dualChart(document.getElementById('proc'), pCpu, memAsCpu, maxCpu, procColor, a2);
  } else {
    document.getElementById('procMeta').textContent =
      'Not attached — Attach button / status bar / command palette';
    document.getElementById('procVal').textContent = '—';
    chart(document.getElementById('proc'), [], 100, procColor);
  }

  const down = pts.map(p => p.down);
  const up = pts.map(p => p.up);
  dualChart(document.getElementById('net'), down, up, Math.max(1, ...down, ...up), accent, a4);
}

let lastMsg = null;
window.addEventListener('message', e => {
  if (e.data && e.data.type === 'tick') { lastMsg = e.data; paint(e.data); }
});
window.addEventListener('resize', () => { if (lastMsg) paint(lastMsg); });
</script>
</body>
</html>`;
  }
}
