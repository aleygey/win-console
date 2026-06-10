/**
 * serial-plugin — a DEMO opencode-style plugin that plugs into win-host with no
 * host rebuild. It is a standalone Node process that:
 *
 *   1. serves its own UI (a serial monitor) + tool endpoints over HTTP,
 *   2. self-registers a manifest with win-host (config form + iframe panel +
 *      two MCP tools the agent can call),
 *   3. drives a MOCK serial device (echo + periodic ticks). Swapping the mock
 *      for the real `serialport` package is a ~3-line change (see openPort()).
 *
 * Run win-host first (the daemon on :8799), then:  node plugin.mjs
 * Open the win console → a 「串口」item appears in the rail, live.
 *
 * Requires Node 18+ (global fetch). No dependencies (mock mode).
 */
import http from "node:http"
import { createWinhostPlugin } from "./winhost-plugin.mjs"

const PLUGIN_PORT = Number(process.env.SERIAL_PLUGIN_PORT || 54110)
const HOST = process.env.WINHOST_URL || "http://127.0.0.1:8799"

// ── live config — driven by the 管理 page, delivered via the heartbeat ─────────
let cfg = { port: "COM3", baud: "115200", autoOpen: true }
let enabled = true

// ── the (mock) serial device ───────────────────────────────────────────────────
const lines = [] // ring buffer of { dir: "rx"|"tx"|"sys", text, at }
let opened = false
let tickTimer = null
let tick = 0

function pushLine(dir, text) {
  lines.push({ dir, text, at: Date.now() })
  if (lines.length > 300) lines.shift()
}

function openPort() {
  if (opened) return
  // ┌─ REAL SERIAL ───────────────────────────────────────────────────────────┐
  // │  import { SerialPort } from "serialport"   // npm i serialport            │
  // │  port = new SerialPort({ path: cfg.port, baudRate: Number(cfg.baud) })    │
  // │  port.on("data", (d) => pushLine("rx", d.toString()))                     │
  // └──────────────────────────────────────────────────────────────────────────┘
  opened = true
  pushLine("sys", `打开 ${cfg.port} @ ${cfg.baud}`)
  tickTimer = setInterval(() => opened && pushLine("rx", `tick #${++tick} (mock device)`), 4000)
  tickTimer.unref?.()
  void plugin.notify("串口已打开", `${cfg.port} @ ${cfg.baud}`, "info")
  void plugin.emit("opened", { port: cfg.port, baud: cfg.baud }) // structured event onto the host bus
}

function closePort() {
  if (!opened) return
  opened = false
  if (tickTimer) clearInterval(tickTimer)
  pushLine("sys", `关闭 ${cfg.port}`)
  void plugin.emit("closed", { port: cfg.port })
}

function writeSerial(data) {
  pushLine("tx", data)
  // REAL SERIAL:  port.write(data + "\n")
  const reply = `ACK: ${data}` // mock device echoes back an ACK
  pushLine("rx", reply)
  return reply
}

// ── HTTP: panel page + panel routes + proxied MCP tool endpoints ────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x")
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" })
    res.end(JSON.stringify(obj))
  }
  const readBody = () =>
    new Promise((resolve) => {
      let b = ""
      req.on("data", (c) => (b += c))
      req.on("end", () => {
        try {
          resolve(JSON.parse(b || "{}"))
        } catch {
          resolve({})
        }
      })
    })

  // The panel UI (served at the plugin's own origin → relative fetches just work).
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(PANEL_HTML)
    return
  }

  // Panel data + controls (the iframe polls /monitor, posts /send /open /close).
  if (req.method === "GET" && url.pathname === "/monitor")
    return json(200, { ok: true, opened, cfg, enabled, lines: lines.slice(-120) })
  if (req.method === "POST" && url.pathname === "/send") {
    const b = await readBody()
    if (!opened) return json(200, { ok: false, error: "串口未打开" })
    return json(200, { ok: true, reply: writeSerial(String(b.data ?? "")) })
  }
  if (req.method === "POST" && url.pathname === "/open") {
    openPort()
    return json(200, { ok: true, opened })
  }
  if (req.method === "POST" && url.pathname === "/close") {
    closePort()
    return json(200, { ok: true, opened })
  }

  // MCP tool endpoints — win-host proxies agent calls here as POST /tools/<name>
  // with body { arguments: {...} }, expecting { text, isError? } back.
  if (req.method === "POST" && url.pathname === "/tools/serial_send") {
    const b = await readBody()
    const data = String(b.arguments?.data ?? "")
    if (!opened) return json(200, { text: `串口未打开(${cfg.port}),请先在面板点「打开」`, isError: true })
    return json(200, { text: `已向 ${cfg.port} 发送「${data}」,设备回应:${writeSerial(data)}` })
  }
  if (req.method === "POST" && url.pathname === "/tools/serial_status") {
    const recent = lines.slice(-3).map((l) => l.text).join(" | ") || "(无)"
    return json(200, { text: `串口 ${cfg.port} @ ${cfg.baud} — ${opened ? "已打开" : "未打开"};最近:${recent}` })
  }

  json(404, { ok: false, error: "not found" })
})

// ── the manifest: everything win-host needs to surface this plugin ──────────────
const manifest = {
  id: "serial",
  title: "串口",
  icon: "plug", // a Lucide icon name (the console renders it in the rail)
  description: "串口监视器示例:自注册到 win-host,提供配置表单、面板与 agent 工具。",
  apiBaseUrl: `http://127.0.0.1:${PLUGIN_PORT}`,
  panel: { url: `http://127.0.0.1:${PLUGIN_PORT}/` },
  configSchema: {
    fields: [
      { key: "port", label: "串口号", type: "string", default: "COM3", placeholder: "COM3 / /dev/ttyUSB0", help: "Windows 为 COMx;Linux 为 /dev/ttyUSBx" },
      { key: "baud", label: "波特率", type: "select", options: ["9600", "19200", "38400", "57600", "115200"], default: "115200" },
      { key: "autoOpen", label: "启动时自动打开", type: "boolean", default: true },
    ],
  },
  tools: [
    {
      name: "serial_send",
      description: "向串口设备发送一行数据并返回设备回应(agent 可用)。",
      inputSchema: { type: "object", properties: { data: { type: "string", description: "要发送的数据" } }, required: ["data"] },
    },
    {
      name: "serial_status",
      description: "查询串口连接状态与最近收发记录。",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  events: ["serial:opened", "serial:closed"], // pushed via plugin.emit()
  ttlSeconds: 60,
}

const plugin = createWinhostPlugin({
  host: HOST,
  manifest,
  // Called on register + every heartbeat → react to the user's 管理 edits live.
  onConfig: (next, isEnabled) => {
    const portChanged = next.port !== cfg.port || String(next.baud) !== String(cfg.baud)
    cfg = {
      port: next.port ?? cfg.port,
      baud: String(next.baud ?? cfg.baud),
      autoOpen: next.autoOpen !== false,
    }
    enabled = isEnabled
    if (!enabled) return closePort() // toggled off in 管理 → release the port
    if (portChanged && opened) {
      closePort()
      openPort() // re-open on COM/baud change
    } else if (cfg.autoOpen && !opened) {
      openPort()
    }
  },
})

server.listen(PLUGIN_PORT, async () => {
  console.log(`[serial-demo] serving http://127.0.0.1:${PLUGIN_PORT}`)
  try {
    // Short heartbeat = fast config delivery (管理 edits reach us within ~5s).
    await plugin.start({ heartbeatMs: 5_000 })
    console.log(`[serial-demo] ✓ registered with ${HOST} — 打开 win 控制台,侧栏出现「串口」`)
  } catch (e) {
    console.error(`[serial-demo] ✗ 注册失败(win-host 在 ${HOST} 运行吗?):`, e.message)
  }
})

async function shutdown() {
  console.log("\n[serial-demo] 注销并退出…")
  closePort()
  await plugin.stop()
  server.close()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

// ── the panel UI (a self-contained serial monitor) ──────────────────────────────
const PANEL_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>串口监视器</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif;
         color: #1b1b1a; background: #f6f6f5; height: 100vh; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid #e6e6e3; background: #fff; }
  header h1 { font-size: 14px; margin: 0; font-weight: 600; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #c2c2bd; }
  .dot.on { background: #3fae6b; box-shadow: 0 0 0 3px rgba(63,174,107,.18); }
  .meta { color: #777; margin-left: auto; font-variant-numeric: tabular-nums; }
  .bar { display: flex; gap: 8px; padding: 10px 16px; border-bottom: 1px solid #eee; background: #fafaf8; flex-wrap: wrap; align-items: center; }
  button { font: inherit; border: 1px solid #d8d8d3; background: #fff; color: #1b1b1a; padding: 6px 12px; border-radius: 7px; cursor: pointer; }
  button:hover { background: #f0f0ec; }
  button.primary { background: #2f6f4f; border-color: #2f6f4f; color: #fff; }
  button.primary:hover { filter: brightness(1.05); }
  input { font: inherit; border: 1px solid #d8d8d3; border-radius: 7px; padding: 6px 10px; background: #fff; color: #1b1b1a; }
  input.send { flex: 1 1 180px; }
  .log { flex: 1 1 auto; overflow: auto; padding: 10px 16px; margin: 0;
         font-family: "Cascadia Code", "Consolas", ui-monospace, monospace; font-size: 12px; }
  .ln { display: flex; gap: 8px; padding: 1px 0; }
  .ln .t { color: #aaa; flex: 0 0 64px; }
  .ln .d { flex: 0 0 30px; font-weight: 600; }
  .rx .d { color: #2f6f4f; } .tx .d { color: #2a5db0; } .sys .d { color: #999; }
  .rx .m { color: #1b1b1a; } .tx .m { color: #2a5db0; } .sys .m { color: #999; font-style: italic; }
  .hint { color:#999; padding: 6px 16px; border-top:1px solid #eee; }
</style></head>
<body>
  <header>
    <span class="dot" id="dot"></span>
    <h1>串口监视器</h1>
    <span class="meta" id="meta">—</span>
  </header>
  <div class="bar">
    <button id="toggle" class="primary">打开</button>
    <button id="clear">清屏</button>
    <input class="send" id="data" placeholder="输入要发送的数据,回车发送" />
    <button id="send">发送</button>
  </div>
  <pre class="log" id="log"></pre>
  <div class="hint" id="hint">这是示例(mock)设备:发送会收到 ACK,每 4 秒一条 tick。配置在「管理 → 串口」里改,约 5 秒(下次心跳)内生效。</div>
<script>
  const $ = (id) => document.getElementById(id);
  const fmt = (t) => new Date(t).toLocaleTimeString("zh", { hour12: false });
  const DIRS = { rx: "RX", tx: "TX", sys: "··" };
  let opened = false;
  async function poll() {
    try {
      const r = await fetch("/monitor").then((x) => x.json());
      opened = r.opened;
      $("dot").className = "dot" + (opened ? " on" : "");
      $("toggle").textContent = opened ? "关闭" : "打开";
      $("meta").textContent = (r.cfg?.port || "?") + " @ " + (r.cfg?.baud || "?") + (r.enabled ? "" : " · 已停用");
      $("log").innerHTML = (r.lines || []).map((l) =>
        '<div class="ln ' + l.dir + '"><span class="t">' + fmt(l.at) + '</span><span class="d">' +
        (DIRS[l.dir] || "") + '</span><span class="m"></span></div>').join("");
      // set text safely (avoid HTML injection from device data)
      const els = $("log").querySelectorAll(".ln .m");
      (r.lines || []).forEach((l, i) => { if (els[i]) els[i].textContent = l.text; });
      $("log").scrollTop = $("log").scrollHeight;
    } catch {}
  }
  $("toggle").onclick = async () => { await fetch(opened ? "/close" : "/open", { method: "POST" }); poll(); };
  $("clear").onclick = () => { $("log").innerHTML = ""; };
  async function doSend() {
    const v = $("data").value.trim(); if (!v) return;
    await fetch("/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: v }) });
    $("data").value = ""; poll();
  }
  $("send").onclick = doSend;
  $("data").addEventListener("keydown", (e) => { if (e.key === "Enter") doSend(); });
  poll(); setInterval(poll, 1000);
</script>
</body></html>`
