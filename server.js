const express = require("express");
const crypto = require("crypto");
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

// Edit these to change the bars shown on the main screen and the phone buttons.
const bars = [
  { id: "red", label: "Red Team", color: "#ef4444", count: 0 },
  { id: "blue", label: "Blue Team", color: "#3b82f6", count: 0 },
  { id: "green", label: "Green Team", color: "#22c55e", count: 0 },
  { id: "yellow", label: "Yellow Team", color: "#eab308", count: 0 },
];

// Basic flood protection: max clicks per second from a single phone.
const MAX_CLICKS_PER_SECOND = 15;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1024 });

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

function sendState(target, joinUrl) {
  target.emit("state", { bars, joinUrl, phase, players: io.engine.clientsCount });
}

io.on("connection", (socket) => {
  const joinUrl = joinUrlFor(socket);
  sendState(socket, joinUrl);
  io.emit("players", io.engine.clientsCount);

  let windowStart = Date.now();
  let clicksInWindow = 0;

  socket.on("click", (barId) => {
    if (phase !== "live") return;
    const now = Date.now();
    if (now - windowStart > 1000) {
      windowStart = now;
      clicksInWindow = 0;
    }
    if (++clicksInWindow > MAX_CLICKS_PER_SECOND) return;

    const bar = bars.find((b) => b.id === barId);
    if (!bar) return;
    bar.count++;
    io.emit("update", { id: bar.id, count: bar.count });
  });

  socket.on("reset", (key) => {
    if (key !== ADMIN_KEY) return socket.emit("denied");
    bars.forEach((b) => (b.count = 0));
    io.emit("counts", bars.map(({ id, count }) => ({ id, count })));
  });

  // Host switches between the start screen and the bars screen.
  socket.on("setPhase", ({ key, to } = {}) => {
    if (key !== ADMIN_KEY) return socket.emit("denied");
    if (to !== "lobby" && to !== "live") return;
    phase = to;
    io.emit("phase", phase);
  });

  socket.on("disconnect", () => io.emit("players", io.engine.clientsCount));
});

server.listen(PORT, () => {
  const base = PUBLIC_URL || `http://localhost:${PORT}`;
  console.log(`Main screen:  ${base}/display?key=${ADMIN_KEY}`);
  console.log(`Phones join:  ${PUBLIC_URL || `http://${lanAddress()}:${PORT}`}`);
});
