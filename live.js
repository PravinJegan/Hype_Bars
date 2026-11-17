// Starts a free Cloudflare Tunnel + the Hype Bars server so anyone can join from anywhere,
// then points a fixed Vercel link (e.g. https://hype-bars.vercel.app) at the tunnel.
//
// Usage: npm run live
//   needs `cloudflared` (brew install cloudflared)
//   and, for the fixed Vercel link, `vercel` logged in (vercel login).
//   Set NO_VERCEL=1 to skip Vercel and just use the Cloudflare link.
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(6).toString("hex");
const VERCEL_PROJECT = process.env.VERCEL_PROJECT || "hype-bars";
const REDIRECT_DIR = path.join(__dirname, "vercel-redirect");

let tunnel, server, shuttingDown = false;

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => resolve({ code: -1, out: String(e) }));
    p.on("exit", (code) => resolve({ code, out }));
  });
}

function startTunnel() {
  return new Promise((resolve, reject) => {
    tunnel = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${PORT}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => reject(new Error("Timed out waiting for the Cloudflare link.")), 30000);
    const onData = (chunk) => {
      const m = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    tunnel.stdout.on("data", onData);
    tunnel.stderr.on("data", onData);
    tunnel.on("error", () => reject(new Error("Couldn't run cloudflared. Install it with: brew install cloudflared")));
    tunnel.on("exit", () => {
      if (!shuttingDown) { console.error("Cloudflare tunnel stopped."); shutdown(1); }
    });
  });
}

// Deploys a tiny Vercel project whose only job is to redirect every path to the tunnel.
// Returns the fixed production URL, or null if Vercel isn't available.
async function pointVercelAt(tunnelUrl) {
  fs.mkdirSync(path.join(REDIRECT_DIR, "public"), { recursive: true });
  fs.writeFileSync(
    path.join(REDIRECT_DIR, "vercel.json"),
    JSON.stringify(
      {
        redirects: [{ source: "/(.*)", destination: `${tunnelUrl}/$1`, permanent: false }],
        headers: [{ source: "/(.*)", headers: [{ key: "Cache-Control", value: "no-store" }] }],
      },
      null,
      2
    ) + "\n"
  );
  fs.writeFileSync(path.join(REDIRECT_DIR, "public", "index.html"), "<!doctype html><title>Hype Bars</title><p>Hype Bars isn't live right now.</p>\n");

  if (!fs.existsSync(path.join(REDIRECT_DIR, ".vercel", "project.json"))) {
    const link = await run("vercel", ["link", "--yes", "--project", VERCEL_PROJECT], { cwd: REDIRECT_DIR });
    if (link.code !== 0) return { error: link.out };
  }
  const dep = await run("vercel", ["deploy", "--prod", "--yes"], { cwd: REDIRECT_DIR });
  if (dep.code !== 0) return { error: dep.out };

  // Prefer the alias Vercel reports (e.g. https://hype-bars.vercel.app) over the one-off deployment URL.
  const aliased = dep.out.match(/Aliased:?\s*(https:\/\/[^\s\]]+)/i);
  const anyUrl = dep.out.match(/https:\/\/[a-z0-9.-]+\.vercel\.app/gi) || [];
  const shortest = anyUrl.sort((a, b) => a.length - b.length)[0];
  return { url: (aliased && aliased[1]) || shortest || null };
}

function startServer(publicUrl) {
  server = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, PORT, PUBLIC_URL: publicUrl, ADMIN_KEY },
  });
  server.on("exit", (code) => shutdown(code ?? 0));
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (tunnel) tunnel.kill();
  if (server) server.kill();
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

(async () => {
  let tunnelUrl;
  try {
    tunnelUrl = await startTunnel();
  } catch (e) {
    console.error(e.message);
    return shutdown(1);
  }

  // PUBLIC_URL set = you manage the Vercel redirect yourself; just show that link.
  let publicUrl = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, "") : tunnelUrl;
  if (!process.env.NO_VERCEL && !process.env.PUBLIC_URL) {
    console.log("Pointing your Vercel link at the tunnel (takes ~20-40s)…");
    const v = await pointVercelAt(tunnelUrl);
    if (v.url) {
      publicUrl = v.url;
    } else {
      console.error("\n⚠️  Couldn't update the Vercel link, so using the Cloudflare link instead.");
      console.error("   If you're not logged in, run: vercel login");
      if (v.error) console.error("   Vercel said: " + v.error.trim().split("\n").slice(-3).join("\n   "));
    }
  }

  startServer(publicUrl);

  console.log("\n🔥 Hype Bars is live!\n");
  console.log(`  Main screen (keep private):  ${publicUrl}/display?key=${ADMIN_KEY}`);
  console.log(`  People join at:              ${publicUrl}`);
  if (publicUrl !== tunnelUrl) console.log(`  (forwards to:                ${tunnelUrl})`);
  console.log("\n  The link can take ~10-30 seconds to start working.");
  console.log("  Keep this window open and your Mac awake. Press Ctrl+C to stop.\n");
})();
