// Starts a free Cloudflare Tunnel + the Hype Bars server so anyone can join from anywhere.
// Usage: npm run live      (needs `cloudflared`: brew install cloudflared)
const { spawn } = require("child_process");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(6).toString("hex");

const tunnel = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${PORT}`], {
  stdio: ["ignore", "pipe", "pipe"],
});
let server;

tunnel.on("error", () => {
  console.error("Couldn't run cloudflared. Install it with: brew install cloudflared");
  process.exit(1);
});

const timeout = setTimeout(() => {
  console.error("Timed out waiting for the Cloudflare tunnel link. Check your internet and try again.");
  shutdown(1);
}, 30000);

function onOutput(chunk) {
  const match = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!match || server) return;
  clearTimeout(timeout);
  const url = match[0];

  server = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, PORT, PUBLIC_URL: url, ADMIN_KEY },
  });
  server.on("exit", (code) => shutdown(code ?? 0));

  console.log("\n🔥 Hype Bars is live!\n");
  console.log(`  Main screen (keep private):  ${url}/display?key=${ADMIN_KEY}`);
  console.log(`  People join at:              ${url}`);
  console.log("\n  The link can take ~10-30 seconds to start working.");
  console.log("  Keep this window open and your Mac awake. Press Ctrl+C to stop.\n");
}
tunnel.stdout.on("data", onOutput);
tunnel.stderr.on("data", onOutput);
tunnel.on("exit", () => {
  if (!shuttingDown) console.error("Cloudflare tunnel stopped.");
  shutdown(1);
});

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  tunnel.kill();
  if (server) server.kill();
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
