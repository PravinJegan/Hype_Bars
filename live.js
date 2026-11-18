// Starts a free Cloudflare Tunnel + the Hype Bars server so anyone can join from anywhere,
// then points your fixed Vercel link at the tunnel by updating vercel.json and pushing it
// to GitHub (Vercel redeploys automatically on push).
//
// Usage: npm run live
//   needs `cloudflared` (brew install cloudflared) and git push access to this repo.
//   NO_VERCEL=1 npm run live   -> skip Vercel, just use the Cloudflare link.
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");

// Your fixed Vercel link. Change this if your Vercel project's address changes.
const VERCEL_URL = (process.env.VERCEL_URL || "https://sch200-leaders.vercel.app").replace(/\/$/, "");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(6).toString("hex");
const USE_VERCEL = !process.env.NO_VERCEL;

let tunnel, server, shuttingDown = false;

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"] });
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

// Updates vercel.json's redirect to the tunnel, then commits and pushes just that file.
async function pushRedirect(tunnelUrl) {
  // Get any edits made on github.com first, so the push isn't rejected.
  const pull = await run("git", ["pull", "--rebase", "--autostash", "-q"]);
  if (pull.code !== 0) return "git pull failed:\n" + pull.out;

  const configPath = path.join(__dirname, "vercel.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.redirects[0].destination = `${tunnelUrl}/$1`;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const commit = await run("git", ["commit", "-q", "-m", `Point Vercel at ${tunnelUrl}`, "--", "vercel.json"]);
  if (commit.code !== 0) return "git commit failed:\n" + commit.out;
  const push = await run("git", ["push", "-q"]);
  if (push.code !== 0) return "git push failed:\n" + push.out;
  return null;
}

// Asks Vercel where it currently redirects to (without following the redirect).
function vercelTarget() {
  return new Promise((resolve) => {
    const req = https.request(VERCEL_URL + "/", { method: "HEAD", timeout: 8000 }, (res) => {
      res.resume();
      resolve(res.headers.location || "");
    });
    req.on("error", () => resolve(""));
    req.on("timeout", () => req.destroy());
    req.end();
  });
}

async function waitForVercel(tunnelUrl, maxSeconds = 120) {
  const start = Date.now();
  while (Date.now() - start < maxSeconds * 1000) {
    if ((await vercelTarget()).startsWith(tunnelUrl)) return true;
    await new Promise((r) => setTimeout(r, 4000));
  }
  return false;
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

function printLinks(publicUrl, tunnelUrl) {
  console.log("\nHype Bars is live!\n");
  console.log(`  Main screen (keep private):  ${publicUrl}/display?key=${ADMIN_KEY}`);
  console.log(`  People join at:              ${publicUrl}`);
  if (publicUrl !== tunnelUrl) console.log(`  (forwards to:                ${tunnelUrl})`);
  console.log("\n  Keep this window open and your Mac awake. Press Ctrl+C to stop.\n");
}

(async () => {
  let tunnelUrl;
  try {
    tunnelUrl = await startTunnel();
  } catch (e) {
    console.error(e.message);
    return shutdown(1);
  }

  if (!USE_VERCEL) {
    startServer(tunnelUrl);
    return printLinks(tunnelUrl, tunnelUrl);
  }

  // Start the server right away (QR shows the Vercel link), then update Vercel.
  startServer(VERCEL_URL);
  console.log(`Tunnel ready: ${tunnelUrl}`);
  console.log("Pushing the new link to GitHub so Vercel forwards to it…");
  const err = await pushRedirect(tunnelUrl);
  if (err) {
    console.error("\n⚠️  Couldn't update Vercel automatically:\n   " + err.trim().split("\n").join("\n   "));
    console.error(`\n   Use the Cloudflare link directly for now: ${tunnelUrl}`);
    console.error("   (Restart with NO_VERCEL=1 npm run live so the QR code shows that link.)\n");
    return;
  }

  console.log("Waiting for Vercel to redeploy (usually 20-60s)…");
  if (await waitForVercel(tunnelUrl)) {
    printLinks(VERCEL_URL, tunnelUrl);
  } else {
    console.error("\n⚠️  Vercel hasn't picked up the new link yet. Check the Deployments tab on vercel.com.");
    console.error(`   Meanwhile the Cloudflare link works directly: ${tunnelUrl}`);
    printLinks(VERCEL_URL, tunnelUrl);
  }
})();
