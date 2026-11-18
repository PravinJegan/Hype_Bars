const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;

// Public address people use to join, e.g. https://hype-bars.onrender.com
// If unset, it's worked out from the address the main screen was opened on.
const PUBLIC_URL = process.env.PUBLIC_URL;

// Secret needed to reset the bars. Open the main screen as /display?key=<ADMIN_KEY>.
// If unset, a random one is generated and printed in the server logs.
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(6).toString("hex");

// Default bars. The host can change the title and bar names/colors on the start
// screen; those are saved to bars.json and used instead of these on the next start.
const DEFAULT_BARS = [
  { label: "Red Team", color: "#ef4444" },
  { label: "Blue Team", color: "#3b82f6" },
  { label: "Green Team", color: "#22c55e" },
  { label: "Yellow Team", color: "#eab308" },
];
const BARS_FILE = process.env.BARS_FILE || path.join(__dirname, "bars.json");
const MAX_BARS = 8;
const MAX_LABEL = 24;

// Cleans up bar settings from the host (or bars.json). Returns null if unusable.
function cleanBars(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_BARS) return null;
  const out = [];
  for (const b of list) {
    const label = String((b && b.label) || "").trim().slice(0, MAX_LABEL);
    const color = String((b && b.color) || "").toLowerCase();
    if (!label || !/^#[0-9a-f]{6}$/.test(color)) return null;
    out.push({ id: `bar${out.length + 1}`, label, color, count: 0 });
  }
  return out;
}

const DEFAULT_TITLE = "Hype Bars";
const MAX_TITLE = 40;

function cleanTitle(t) {
  const title = String(t || "").trim().slice(0, MAX_TITLE);
  return title || null;
}

// bars.json holds { title, bars: [{label, color}] } (older files are just the bars array).
function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(BARS_FILE, "utf8"));
    const list = Array.isArray(saved) ? saved : saved.bars;
    return {
      bars: cleanBars(list) || cleanBars(DEFAULT_BARS),
      title: (!Array.isArray(saved) && cleanTitle(saved.title)) || DEFAULT_TITLE,
    };
  } catch {
    return { bars: cleanBars(DEFAULT_BARS), title: DEFAULT_TITLE };
  }
}

function saveSettings() {
  try {
    const data = { title, bars: bars.map(({ label, color }) => ({ label, color })) };
    fs.writeFileSync(BARS_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch (e) {
    console.error("Couldn't save bars.json:", e.message);
  }
}

let { bars, title } = loadSettings();

// Flood protection per phone: a steady TAPS_PER_SECOND, with short bursts up to TAP_BURST.
const TAPS_PER_SECOND = 20;
const TAP_BURST = 25;

// Taps are bundled and sent to screens at most this often, so spam-clicking
// gives smooth bar movement instead of hundreds of tiny updates.
const BROADCAST_MS = 50;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 4096 });

app.use(express.static(path.join(__dirname, "public")));
app.get("/display", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "display.html"))
);

function lanAddress() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "localhost";
}

// Join URL as seen by this client: PUBLIC_URL, else the host it connected to
// (works behind hosting proxies), else the LAN address when opened on localhost.
function joinUrlFor(socket) {
  if (PUBLIC_URL) return PUBLIC_URL.replace(/\/$/, "");
  const h = socket.handshake.headers;
  const host = (h["x-forwarded-host"] || h.host || "").split(",")[0].trim();
  const proto = (h["x-forwarded-proto"] || "http").split(",")[0].trim();
  if (!host || /^(localhost|127\.0\.0\.1)(:|$)/.test(host)) {
    return `http://${lanAddress()}:${PORT}`;
  }
  return `${proto}://${host}`;
}

// "lobby" = start screen, taps ignored. "live" = bars showing, taps count.
let phase = "lobby";

// Bars whose count changed since the last broadcast.
const dirty = new Set();
setInterval(() => {
  if (!dirty.size) return;
  const changed = bars.filter((b) => dirty.has(b.id)).map(({ id, count }) => ({ id, count }));
  dirty.clear();
  io.emit("counts", changed);
}, BROADCAST_MS);

function sendState(target, joinUrl) {
  target.emit("state", { bars, title, joinUrl, phase, players: io.engine.clientsCount });
}

io.on("connection", (socket) => {
  const joinUrl = joinUrlFor(socket);
  sendState(socket, joinUrl);
  io.emit("players", io.engine.clientsCount);

  // Token bucket: refills smoothly, so fast tapping isn't cut off in jumps.
  let tokens = TAP_BURST;
  let lastRefill = Date.now();

  socket.on("click", (barId) => {
    if (phase !== "live") return;
    const now = Date.now();
    tokens = Math.min(TAP_BURST, tokens + ((now - lastRefill) / 1000) * TAPS_PER_SECOND);
    lastRefill = now;
    if (tokens < 1) return;
    tokens -= 1;

    const bar = bars.find((b) => b.id === barId);
    if (!bar) return;
    bar.count++;
    dirty.add(bar.id);
  });

  socket.on("reset", (key) => {
    if (key !== ADMIN_KEY) return socket.emit("denied");
    bars.forEach((b) => (b.count = 0));
    dirty.clear();
    io.emit("counts", bars.map(({ id, count }) => ({ id, count })));
  });

  // Host switches between the start screen and the bars screen.
  socket.on("setPhase", ({ key, to } = {}) => {
    if (key !== ADMIN_KEY) return socket.emit("denied");
    if (to !== "lobby" && to !== "live") return;
    phase = to;
    io.emit("phase", phase);
  });

  // Host changes bar names/colors from the start screen. Resets counts.
  socket.on("setBars", ({ key, bars: list } = {}) => {
    if (key !== ADMIN_KEY) return socket.emit("denied");
    if (phase !== "lobby") return socket.emit("barsError", "Go back to the start screen to change bars.");
    const cleaned = cleanBars(list);
    if (!cleaned) return socket.emit("barsError", `Each bar needs a name, and you can have 1–${MAX_BARS} bars.`);
    bars = cleaned;
    dirty.clear();
    saveSettings();
    io.emit("bars", bars);
    socket.emit("barsSaved");
  });

  // Host changes the title. Allowed any time; doesn't touch the counts.
  socket.on("setTitle", ({ key, title: t } = {}) => {
    if (key !== ADMIN_KEY) return socket.emit("denied");
    const cleaned = cleanTitle(t);
    if (!cleaned) return socket.emit("barsError", "The title can't be empty.");
    title = cleaned;
    saveSettings();
    io.emit("title", title);
    socket.emit("barsSaved");
  });

  socket.on("disconnect", () => io.emit("players", io.engine.clientsCount));
});

server.listen(PORT, () => {
  const base = PUBLIC_URL || `http://localhost:${PORT}`;
  console.log(`Main screen:  ${base}/display?key=${ADMIN_KEY}`);
  console.log(`Phones join:  ${PUBLIC_URL || `http://${lanAddress()}:${PORT}`}`);
});
