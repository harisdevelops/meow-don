#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, "index.html");
const WORKSPACES_FILE = path.join(__dirname, "workspaces.json");
const WORKTREES_ROOT = path.join(os.homedir(), ".pi", "worktrees");

// Parse our own flags; forward everything else to `pi --mode rpc`
const rawArgs = process.argv.slice(2);
let requestedPort = 3456;
let autoOpen = true;
const piExtraArgs = [];

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === "--port" && rawArgs[i + 1]) {
    requestedPort = Number.parseInt(rawArgs[++i], 10) || 3456;
  } else if (arg.startsWith("--port=")) {
    requestedPort = Number.parseInt(arg.slice(7), 10) || 3456;
  } else if (arg === "--no-open") {
    autoOpen = false;
  } else if (arg === "--help" || arg === "-h") {
    console.log(`meow-don — Browser workspace & worktree chat UI for Pi

Usage:
  meow-don [options] [pi options...]

Options:
  --port <n>    Port to listen on (default: 3456)
  --no-open     Do not automatically open the browser
  -h, --help    Show this help

Run from anywhere. Add projects and create git worktrees directly in the sidebar.
All other flags (e.g. --model, --provider, --no-session) are passed to \`pi --mode rpc\`.`);
    process.exit(0);
  } else {
    piExtraArgs.push(arg);
  }
}

const LAUNCH_CWD = process.cwd();
const PI_BIN = process.env.PI_BIN || "pi";

// ===== Helpers =====
function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || stdout || err.message || "").trim();
        reject(new Error(msg));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function expandPath(p) {
  if (!p) return "";
  let s = String(p).trim();
  if (s === "~") s = os.homedir();
  else if (s.startsWith("~/")) s = path.join(os.homedir(), s.slice(2));
  else s = path.resolve(s);
  try {
    return fs.realpathSync(s);
  } catch {
    return s;
  }
}

// ===== Workspace persistence =====
function loadSavedWorkspaces() {
  try {
    if (fs.existsSync(WORKSPACES_FILE)) {
      const data = JSON.parse(fs.readFileSync(WORKSPACES_FILE, "utf8"));
      if (Array.isArray(data.repos)) {
        return data.repos.filter((r) => r && typeof r.path === "string" && fs.existsSync(r.path));
      }
    }
  } catch {}
  return [];
}

function saveWorkspaces(repos) {
  fs.mkdirSync(path.dirname(WORKSPACES_FILE), { recursive: true });
  fs.writeFileSync(WORKSPACES_FILE, JSON.stringify({ repos }, null, 2), "utf8");
}

let savedRepos = loadSavedWorkspaces();

// If launched from a specific project folder (not $HOME or /), auto-add it if not present
async function maybeRegisterLaunchCwd() {
  const home = os.homedir();
  if (LAUNCH_CWD === home || LAUNCH_CWD === "/") return null;
  const resolved = await resolveRepoRoot(LAUNCH_CWD);
  const existing = savedRepos.find((r) => r.path === resolved);
  if (!existing) {
    savedRepos.unshift({
      id: crypto.randomUUID(),
      path: resolved,
      name: path.basename(resolved) || resolved,
    });
    saveWorkspaces(savedRepos);
  }
  return LAUNCH_CWD;
}

async function resolveRepoRoot(dirPath) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dirPath, "rev-parse", "--show-toplevel"]);
    const top = stdout.trim();
    if (top) return top;
  } catch {}
  return dirPath;
}

async function isGitRepo(dirPath) {
  try {
    await execFileAsync("git", ["-C", dirPath, "rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

async function listWorktreesForRepo(repoPath) {
  const git = await isGitRepo(repoPath);
  if (!git) {
    const sess = sessions.get(repoPath);
    return {
      isGit: false,
      worktrees: [
        {
          path: repoPath,
          branch: null,
          isMain: true,
          running: Boolean(sess?.proc),
          isStreaming: Boolean(sess?.isStreaming),
        },
      ],
    };
  }

  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "worktree", "list", "--porcelain"]);
    const blocks = stdout.trim().split(/\n\n+/);
    const worktrees = [];
    blocks.forEach((block, idx) => {
      const lines = block.split("\n");
      let wtPath = "";
      let branch = "";
      let detached = false;
      let head = "";
      for (const line of lines) {
        if (line.startsWith("worktree ")) wtPath = line.slice(9).trim();
        else if (line.startsWith("HEAD ")) head = line.slice(5).trim().slice(0, 7);
        else if (line.startsWith("branch ")) branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
        else if (line === "detached") detached = true;
      }
      if (!wtPath) return;
      const sess = sessions.get(wtPath);
      worktrees.push({
        path: wtPath,
        branch: branch || (detached ? `detached@${head}` : head || "HEAD"),
        isMain: idx === 0,
        running: Boolean(sess?.proc),
        isStreaming: Boolean(sess?.isStreaming),
      });
    });

    return { isGit: true, worktrees };
  } catch {
    const sess = sessions.get(repoPath);
    return {
      isGit: true,
      worktrees: [
        {
          path: repoPath,
          branch: "HEAD",
          isMain: true,
          running: Boolean(sess?.proc),
          isStreaming: Boolean(sess?.isStreaming),
        },
      ],
    };
  }
}

// ===== SSE Broadcast =====
const sseClients = new Set();

function broadcast(eventName, payload) {
  const data = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch {
      sseClients.delete(res);
    }
  }
}

// ===== Multi-session Pi RPC Manager =====
// Keyed by cwd (worktree / folder path)
const sessions = new Map();

class PiSession {
  constructor(cwd) {
    this.cwd = cwd;
    this.proc = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.pendingCommands = new Map();
    this.isStreaming = false;
  }

  start() {
    if (this.proc) return;
    if (!fs.existsSync(this.cwd)) {
      throw new Error(`Directory does not exist: ${this.cwd}`);
    }

    this.stdoutBuffer = Buffer.alloc(0);
    const args = ["--mode", "rpc", ...piExtraArgs];
    this.proc = spawn(PI_BIN, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.emitStatus();

    // Strict LF-only framing per docs/rpc.md
    this.proc.stdout.on("data", (chunk) => {
      this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
      let nlIndex;
      while ((nlIndex = this.stdoutBuffer.indexOf(0x0a)) !== -1) {
        let lineBuf = this.stdoutBuffer.subarray(0, nlIndex);
        this.stdoutBuffer = this.stdoutBuffer.subarray(nlIndex + 1);
        if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d) {
          lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
        }
        const lineStr = lineBuf.toString("utf8").trim();
        if (!lineStr) continue;
        try {
          const record = JSON.parse(lineStr);
          this.handleRecord(record);
        } catch (err) {
          console.error(`[pi-web:${path.basename(this.cwd)}] JSONL parse error:`, err.message);
        }
      }
    });

    this.proc.stderr.on("data", (chunk) => {
      process.stderr.write(chunk.toString("utf8"));
    });

    this.proc.on("error", (err) => {
      this.failPending(err);
      this.proc = null;
      this.isStreaming = false;
      this.emitStatus(err.message);
    });

    this.proc.on("exit", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      this.failPending(new Error(`Pi exited (${reason})`));
      this.proc = null;
      this.isStreaming = false;
      this.emitStatus();
    });
  }

  emitStatus(error) {
    broadcast("session_status", {
      cwd: this.cwd,
      running: Boolean(this.proc),
      isStreaming: this.isStreaming,
      pid: this.proc?.pid ?? null,
      ...(error ? { error } : {}),
    });
  }

  failPending(err) {
    for (const [, p] of this.pendingCommands) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pendingCommands.clear();
  }

  handleRecord(record) {
    if (record.type === "response" && record.id && this.pendingCommands.has(record.id)) {
      const p = this.pendingCommands.get(record.id);
      this.pendingCommands.delete(record.id);
      clearTimeout(p.timer);
      p.resolve(record);
      return;
    }

    if (record.type === "extension_ui_request") {
      broadcast("extension_ui", { cwd: this.cwd, request: record });
      return;
    }

    if (record.type === "agent_start") {
      this.isStreaming = true;
      this.emitStatus();
    } else if (record.type === "agent_settled") {
      this.isStreaming = false;
      this.emitStatus();
    }

    broadcast("pi_event", { cwd: this.cwd, event: record });
  }

  write(obj) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      this.start();
    }
    this.proc.stdin.write(JSON.stringify(obj) + "\n", "utf8");
  }

  sendCommand(cmdObj, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.proc) {
        try {
          this.start();
        } catch (err) {
          reject(err);
          return;
        }
      }
      const id = `web-${crypto.randomUUID()}`;
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`RPC command "${cmdObj.type}" timed out`));
      }, timeoutMs);

      this.pendingCommands.set(id, { resolve, reject, timer });
      try {
        this.write({ ...cmdObj, id });
      } catch (err) {
        clearTimeout(timer);
        this.pendingCommands.delete(id);
        reject(err);
      }
    });
  }

  stop() {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    this.isStreaming = false;
    try {
      if (p.stdin && !p.stdin.destroyed) p.stdin.end();
    } catch {}
    setTimeout(() => {
      try {
        if (!p.killed) p.kill("SIGTERM");
      } catch {}
    }, 1000).unref();
    this.emitStatus();
  }
}

function getOrCreateSession(cwd) {
  const resolved = expandPath(cwd);
  let sess = sessions.get(resolved);
  if (!sess) {
    sess = new PiSession(resolved);
    sessions.set(resolved, sess);
  }
  return sess;
}

// ===== HTTP Helpers =====
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX_BODY = 25 * 1024 * 1024;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

async function buildWorkspacesPayload() {
  const result = [];
  for (const repo of savedRepos) {
    if (!fs.existsSync(repo.path)) continue;
    const info = await listWorktreesForRepo(repo.path);
    result.push({
      id: repo.id,
      name: repo.name,
      path: repo.path,
      isGit: info.isGit,
      worktrees: info.worktrees,
    });
  }
  return result;
}

// Real-time kernel CPU usage via os.cpus() tick deltas (matches Activity Monitor)
let prevCpuSample = null;
function sampleCpuPercent() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  const now = { idle, total };
  if (!prevCpuSample) {
    prevCpuSample = now;
    return null;
  }
  const dIdle = now.idle - prevCpuSample.idle;
  const dTotal = now.total - prevCpuSample.total;
  prevCpuSample = now;
  if (dTotal <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round(((1 - dIdle / dTotal) * 100) * 10) / 10));
}
// Prime baseline sample on startup
sampleCpuPercent();

async function collectResources() {
  const totalBytes = os.totalmem();
  const cores = os.cpus().length || 1;
  const load1 = os.loadavg()[0] || 0;

  // 1. Collect all processes in one fast `ps` call
  const pidInfo = new Map(); // pid -> { rssKb, cpu, comm }
  const appTotals = new Map(); // friendlyName -> { ramKb, cpu }
  let psCpuSum = 0;

  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,rss=,%cpu=,comm="]);
    for (const line of stdout.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const rssKb = Number(m[2]);
      const cpu = Number(m[3]);
      const comm = m[4].trim();
      pidInfo.set(pid, { rssKb, cpu, comm });
      psCpuSum += cpu;

      // Friendly app grouping
      let appName = path.basename(comm);
      const appMatch = comm.match(/\/([^/]+)\.app\//);
      if (appMatch) appName = appMatch[1];
      else if (comm.includes("Virtualization.VirtualMachine")) appName = "Docker / VM";
      const prev = appTotals.get(appName) || { ramKb: 0, cpu: 0 };
      prev.ramKb += rssKb;
      prev.cpu += cpu;
      appTotals.set(appName, prev);
    }
  } catch {}

  // 2. macOS exact Activity Monitor Memory Used formula:
  //    App Memory (Anonymous - Purgeable) + Wired + Compressed
  let usedBytes = totalBytes - os.freemem();
  let cachedBytes = 0;
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("vm_stat", []);
      const pageMatch = stdout.match(/page size of (\d+) bytes/);
      const pageSize = pageMatch ? Number(pageMatch[1]) : 4096;
      const getPages = (label) => {
        const rx = new RegExp(`${label}:\\s+(\\d+)`);
        const mm = stdout.match(rx);
        return mm ? Number(mm[1]) : 0;
      };
      const anon = getPages("Anonymous pages");
      const purgeable = getPages("Pages purgeable");
      const wired = getPages("Pages wired down");
      const compressed = getPages("Pages occupied by compressor");
      const fileBacked = getPages("File-backed pages");
      if (anon + wired > 0) {
        const appPages = Math.max(0, anon - purgeable);
        usedBytes = (appPages + wired + compressed) * pageSize;
        cachedBytes = (fileBacked + purgeable) * pageSize;
      }
    } catch {}
  }

  // 3. Battery (macOS)
  let battery = null;
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("pmset", ["-g", "batt"]);
      const bm = stdout.match(/(\d+)%;\s*([^;]+)/);
      if (bm) {
        battery = { percent: Number(bm[1]), state: bm[2].trim() };
      }
    } catch {}
  }

  // 4. Meow-Don server + active Pi sessions
  const selfStats = pidInfo.get(process.pid);
  const serverMb = selfStats ? selfStats.rssKb / 1024 : process.memoryUsage().rss / (1024 * 1024);
  const serverCpu = selfStats ? selfStats.cpu : 0;

  const activeSessions = [];
  let piTotalMb = 0;
  for (const [cwd, sess] of sessions.entries()) {
    if (!sess.proc || !sess.proc.pid) continue;
    const st = pidInfo.get(sess.proc.pid);
    const ramMb = st ? st.rssKb / 1024 : 0;
    const cpu = st ? st.cpu : 0;
    piTotalMb += ramMb;
    activeSessions.push({
      cwd,
      name: path.basename(cwd) || cwd,
      pid: sess.proc.pid,
      ramMb: Math.round(ramMb * 10) / 10,
      cpu: Math.round(cpu * 10) / 10,
      isStreaming: Boolean(sess.isStreaming),
    });
  }

  const topApps = Array.from(appTotals.entries())
    .map(([name, v]) => ({
      name,
      ramMb: Math.round(v.ramKb / 1024),
      cpu: Math.round(v.cpu * 10) / 10,
    }))
    .sort((a, b) => b.ramMb - a.ramMb)
    .slice(0, 6);

  const totalRamGb = totalBytes / (1024 ** 3);
  const usedRamGb = Math.min(totalRamGb, usedBytes / (1024 ** 3));
  const cachedRamGb = cachedBytes / (1024 ** 3);
  const deltaCpu = sampleCpuPercent();
  const cpuPercent = deltaCpu !== null ? deltaCpu : Math.min(100, Math.round((psCpuSum / cores) * 10) / 10);

  return {
    meowDon: {
      serverMb: Math.round(serverMb * 10) / 10,
      serverCpu: Math.round(serverCpu * 10) / 10,
      totalMb: Math.round((serverMb + piTotalMb) * 10) / 10,
      sessions: activeSessions,
    },
    system: {
      totalRamGb: Math.round(totalRamGb * 10) / 10,
      usedRamGb: Math.round(usedRamGb * 10) / 10,
      cachedRamGb: Math.round(cachedRamGb * 10) / 10,
      ramPercent: Math.round((usedRamGb / totalRamGb) * 100),
      cpuPercent,
      load1: Math.round(load1 * 100) / 100,
      cores,
      battery,
      topApps,
    },
  };
}

// ===== HTTP Server =====
let initialActiveCwd = null;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    try {
      const html = fs.readFileSync(HTML_PATH, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/oneko.gif") {
    try {
      const gif = fs.readFileSync(path.join(__dirname, "oneko.gif"));
      res.writeHead(200, {
        "Content-Type": "image/gif",
        "Cache-Control": "public, max-age=86400",
      });
      res.end(gif);
    } catch (err) {
      sendJson(res, 404, { error: "oneko.gif not found" });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/oneko.js") {
    try {
      const js = fs.readFileSync(path.join(__dirname, "oneko.js"), "utf8");
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
      });
      res.end(js);
    } catch (err) {
      sendJson(res, 404, { error: "oneko.js not found" });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    sseClients.add(res);

    const keepAlive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(keepAlive);
        sseClients.delete(res);
      }
    }, 20000);

    req.on("close", () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/workspaces") {
    try {
      const workspaces = await buildWorkspacesPayload();
      sendJson(res, 200, {
        success: true,
        launchCwd: initialActiveCwd,
        homeDir: os.homedir(),
        platform: process.platform,
        workspaces,
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/workspaces/pick") {
    if (process.platform !== "darwin") {
      sendJson(res, 400, { success: false, error: "Native picker is only available on macOS" });
      return;
    }
    try {
      const { stdout } = await execFileAsync("osascript", [
        "-e",
        'POSIX path of (choose folder with prompt "Choose a project folder for Pi")',
      ]);
      const picked = stdout.trim().replace(/\/+$/, "") || "/";
      const rootPath = await resolveRepoRoot(picked);
      let repo = savedRepos.find((r) => r.path === rootPath);
      if (!repo) {
        repo = { id: crypto.randomUUID(), path: rootPath, name: path.basename(rootPath) || rootPath };
        savedRepos.unshift(repo);
        saveWorkspaces(savedRepos);
      }
      const workspaces = await buildWorkspacesPayload();
      sendJson(res, 200, { success: true, selectedPath: picked, repo, workspaces });
    } catch (err) {
      // User cancelled osascript dialog
      const cancelled = /User canceled|-128/i.test(err.message);
      sendJson(res, 200, { success: false, cancelled, error: cancelled ? "Cancelled" : err.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/workspaces/add") {
    try {
      const body = await readJsonBody(req);
      const target = expandPath(body.path);
      if (!target || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
        sendJson(res, 400, { success: false, error: `Folder not found: ${body.path || ""}` });
        return;
      }
      const rootPath = await resolveRepoRoot(target);
      let repo = savedRepos.find((r) => r.path === rootPath);
      if (!repo) {
        repo = { id: crypto.randomUUID(), path: rootPath, name: path.basename(rootPath) || rootPath };
        savedRepos.unshift(repo);
        saveWorkspaces(savedRepos);
      }
      const workspaces = await buildWorkspacesPayload();
      sendJson(res, 200, { success: true, selectedPath: target, repo, workspaces });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/workspaces/remove") {
    try {
      const body = await readJsonBody(req);
      const repoPath = expandPath(body.path);
      savedRepos = savedRepos.filter((r) => r.path !== repoPath);
      saveWorkspaces(savedRepos);
      const workspaces = await buildWorkspacesPayload();
      sendJson(res, 200, { success: true, workspaces });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/worktrees/create") {
    try {
      const body = await readJsonBody(req);
      const repoPath = expandPath(body.repoPath);
      const branch = String(body.branch || "").trim();
      const baseBranch = String(body.baseBranch || "").trim();

      if (!repoPath || !branch) {
        sendJson(res, 400, { success: false, error: "Repository path and branch name are required" });
        return;
      }

      const repoName = path.basename(repoPath) || "repo";
      const safeBranch = branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
      const wtDir = path.join(WORKTREES_ROOT, repoName, safeBranch);
      fs.mkdirSync(path.dirname(wtDir), { recursive: true });

      // Check if branch already exists locally
      let branchExists = false;
      try {
        await execFileAsync("git", ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
        branchExists = true;
      } catch {}

      const gitArgs = branchExists
        ? ["-C", repoPath, "worktree", "add", wtDir, branch]
        : ["-C", repoPath, "worktree", "add", "-b", branch, wtDir, ...(baseBranch ? [baseBranch] : [])];

      await execFileAsync("git", gitArgs);
      const workspaces = await buildWorkspacesPayload();
      sendJson(res, 200, { success: true, worktreePath: wtDir, branch, workspaces });
    } catch (err) {
      sendJson(res, 400, { success: false, error: err.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/worktrees/remove") {
    try {
      const body = await readJsonBody(req);
      const repoPath = expandPath(body.repoPath);
      const worktreePath = expandPath(body.worktreePath);
      const force = Boolean(body.force);

      const sess = sessions.get(worktreePath);
      if (sess) {
        sess.stop();
        sessions.delete(worktreePath);
      }

      const gitArgs = ["-C", repoPath, "worktree", "remove", ...(force ? ["--force"] : []), worktreePath];
      await execFileAsync("git", gitArgs);
      const workspaces = await buildWorkspacesPayload();
      sendJson(res, 200, { success: true, workspaces });
    } catch (err) {
      sendJson(res, 400, { success: false, error: err.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/command") {
    try {
      const body = await readJsonBody(req);
      const cwd = body.cwd || initialActiveCwd || os.homedir();
      const command = body.command || body;
      if (!command || typeof command.type !== "string") {
        sendJson(res, 400, { success: false, error: "Missing command type" });
        return;
      }
      const sess = getOrCreateSession(cwd);
      const timeoutMs = command.type === "abort" ? 60000 : 30000;
      const response = await sess.sendCommand(command, timeoutMs);
      sendJson(res, 200, response);
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/extension-ui-response") {
    try {
      const body = await readJsonBody(req);
      const cwd = body.cwd;
      const payload = body.response || body;
      const sess = sessions.get(expandPath(cwd));
      if (!sess) {
        sendJson(res, 404, { success: false, error: "Session not found" });
        return;
      }
      sess.write({ type: "extension_ui_response", ...payload });
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/resources") {
    try {
      const data = await collectResources();
      sendJson(res, 200, { success: true, ...data });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session/stop") {
    try {
      const body = await readJsonBody(req);
      const key = expandPath(body.cwd || "");
      const sess = sessions.get(key);
      if (sess) {
        sess.stop();
        sessions.delete(key);
      }
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session/restart") {
    try {
      const body = await readJsonBody(req);
      const sess = getOrCreateSession(body.cwd || os.homedir());
      sess.stop();
      sess.start();
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
  } catch {}
}

function listenWithFallback(port, attemptsLeft = 20) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
      listenWithFallback(port + 1, attemptsLeft - 1);
    } else {
      console.error("[pi-web] Server error:", err.message);
      process.exit(1);
    }
  });

  server.listen(port, "127.0.0.1", async () => {
    initialActiveCwd = await maybeRegisterLaunchCwd();
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n  🐱 Meow-Don running at ${url}`);
    console.log(`  Open projects & create worktrees directly from the sidebar.`);
    console.log(`  Press Ctrl+C to stop.\n`);
    if (autoOpen) {
      openBrowser(url);
    }
  });
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  console.log("\n  Shutting down Pi Web UI...");
  for (const res of sseClients) {
    try { res.end(); } catch {}
  }
  sseClients.clear();
  server.close();
  for (const sess of sessions.values()) {
    sess.stop();
  }
  setTimeout(() => process.exit(0), 600).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

listenWithFallback(requestedPort);
