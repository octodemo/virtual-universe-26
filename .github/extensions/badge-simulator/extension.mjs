// Extension: badge-simulator
// Badge Simulator canvas: runs an app from badge/apps in the badger.github.io
// 3D badge simulator and reloads it whenever its files change. When the canvas is
// opened for an issue it records the whole badge once and adds the GIF to that issue
// as an artifact; the Share button saves the GIF to Downloads. See README.md.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { contactSheet, encodeGif, encodePng } from "./media.mjs";

const extDir = dirname(fileURLToPath(import.meta.url));
const webDir = join(extDir, "web");
const buildInfo = JSON.parse(readFileSync(join(webDir, "BUILD_INFO.json"), "utf8"));
const runtimeBase = `https://raw.githubusercontent.com/badger/badger.github.io/${buildInfo.revision}/public/simulator/`;
const cacheDir = join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "cache", "badge-simulator", buildInfo.revision);

const mime = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".wasm": "application/wasm",
    ".glb": "model/gltf-binary", ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
};
const buttonBits = {
    down: 1, up: 2, select: 4, c: 4, right: 8, b: 8, left: 16, a: 16, home: 32,
    back: 8192, menu: 16384,
};
const ignoredFile = (name) => name === ".DS_Store" || name === "__pycache__" || name.endsWith(".pyc") || name.startsWith(".#");

let session;
const instances = new Map();
// Opened with no app and nothing remembered, the canvas shows this one.
const defaultApp = "universe_congrats";

// ---- GitHub CLI -------------------------------------------------------------------
// Apps get the signed-in user's login as github_login.txt; Share uses gh to upload
// the GIF and create the issue artifact.
const ghCandidates = ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh", "C:\\Program Files\\GitHub CLI\\gh.exe"];
let ghPath;
function gh(args, { input } = {}) {
    const run = (bin) => new Promise((ok, fail) => {
        const child = execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: 120000 }, (error, stdout, stderr) => {
            if (error) { error.stderr = String(stderr || ""); fail(error); } else ok(String(stdout));
        });
        if (input !== undefined) child.stdin.end(input);
    });
    if (ghPath) return run(ghPath);
    return ghCandidates.reduce((prev, bin) => prev.catch((error) => {
        if (error && error.code !== "ENOENT") throw error;
        return run(bin).then((out) => { ghPath = bin; return out; });
    }), Promise.reject(Object.assign(new Error("GitHub CLI (gh) not found"), { code: "ENOENT" })));
}
let loginPromise;
function githubLogin() {
    loginPromise ??= gh(["api", "user", "--jq", ".login"]).then((out) => out.trim() || null, () => null);
    return loginPromise;
}
function ghError(error) {
    if (error?.code === "ENOENT") return "Install the GitHub CLI (gh) and run gh auth login to share.";
    const detail = String(error?.stderr || error?.message || error).trim().split("\n").pop();
    return detail || "The GitHub CLI failed.";
}
const inflight = new Map();

// ---- repository + app discovery ---------------------------------------------
function repoRoot(ctx) {
    const cwd = ctx?.session?.workingDirectory;
    if (cwd && existsSync(join(cwd, "badge", "apps"))) return resolve(cwd);
    return resolve(extDir, "..", "..", "..");
}
const appsDir = (root) => join(root, "badge", "apps");
function listApps(root) {
    try {
        return readdirSync(appsDir(root), { withFileTypes: true })
            .filter((d) => d.isDirectory() && existsSync(join(appsDir(root), d.name, "__init__.py")))
            .map((d) => d.name)
            .sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
}
function appFiles(dir, base = dir, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (ignoredFile(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) appFiles(full, base, out);
        else if (entry.isFile()) out.push({ path: relative(base, full).split(sep).join("/"), data: readFileSync(full).toString("base64") });
    }
    return out;
}

// ---- persisted selection --------------------------------------------------------
const stateFile = () => (session?.workspacePath ? join(session.workspacePath, "files", "badge-simulator.json") : null);
function loadLastApp() {
    try { return JSON.parse(readFileSync(stateFile(), "utf8")).app ?? null; } catch { return null; }
}
function saveLastApp(app) {
    const file = stateFile();
    if (!file) return;
    try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ app }) + "\n"); } catch {}
}

// ---- runtime proxy with disk cache ------------------------------------------------
async function runtimeFile(rel) {
    const file = join(cacheDir, rel);
    if (!file.startsWith(cacheDir + sep)) throw Object.assign(new Error("Bad path"), { status: 400 });
    if (existsSync(file)) return readFileSync(file);
    if (!inflight.has(rel)) {
        inflight.set(rel, (async () => {
            const response = await fetch(runtimeBase + rel.split("/").map(encodeURIComponent).join("/"));
            if (!response.ok) throw Object.assign(new Error(`${response.status} fetching ${rel}`), { status: response.status });
            const bytes = Buffer.from(await response.arrayBuffer());
            mkdirSync(dirname(file), { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            writeFileSync(tmp, bytes);
            renameSync(tmp, file);
            return bytes;
        })().finally(() => inflight.delete(rel)));
    }
    return inflight.get(rel);
}

// ---- per-instance state + server ---------------------------------------------------
function readBody(req) {
    return new Promise((resolveBody, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            try { resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(e); }
        });
        req.on("error", reject);
    });
}
const json = (res, status, body) => { res.writeHead(status, { "Content-Type": mime[".json"], "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };

function readRaw(req, limit) {
    return new Promise((resolveBody, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (c) => { size += c.length; if (size <= limit) chunks.push(c); });
        req.on("end", () => resolveBody(size <= limit ? Buffer.concat(chunks) : null));
        req.on("error", reject);
    });
}
function broadcast(inst, event) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of inst.clients) client.write(data);
}

function watchApp(inst) {
    inst.watcher?.close();
    inst.watcher = null;
    clearTimeout(inst.reloadTimer);
    if (!inst.app) return;
    try {
        inst.watcher = watch(join(appsDir(inst.root), inst.app), { recursive: true }, (_type, name) => {
            if (name && String(name).split(/[\\/]/).some(ignoredFile)) return;
            clearTimeout(inst.reloadTimer);
            inst.reloadTimer = setTimeout(() => {
                inst.revision++;
                broadcast(inst, { type: "reload", app: inst.app, revision: inst.revision });
            }, 300);
        });
        inst.watcher.on("error", () => {});
    } catch (error) {
        session?.log(`badge-simulator: could not watch ${inst.app}: ${error.message}`, { level: "warning" });
    }
}

// ---- console output, waiting and diagnostics -----------------------------------------
// inst.log is a sliding window; cursors are absolute line numbers so callers can
// ask for "output since X" even after older lines are trimmed or an app reloads.
const LOG_LIMIT = 2000;
const cursorOf = (inst) => inst.logBase + inst.log.length;
const linesSince = (inst, cursor) => inst.log.slice(Math.max(0, Number(cursor ?? 0) - inst.logBase));
function clearLog(inst) { inst.logBase += inst.log.length; inst.log = []; inst.fatal = false; }
function notify(inst) { for (const waiter of [...inst.waiters]) waiter(); }
function waitUntil(inst, check, timeoutMs) {
    return new Promise((done) => {
        let timer;
        const waiter = () => { const result = check(); if (result) finish(result); };
        const finish = (result) => { clearTimeout(timer); inst.waiters.delete(waiter); done(result); };
        inst.waiters.add(waiter);
        timer = setTimeout(() => finish(null), timeoutMs);
        waiter();
    });
}
const clampMs = (value, fallback, max = 60000) => Math.max(0, Math.min(max, Number(value ?? fallback) || 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ingestLog(inst, lines) {
    for (const raw of lines) {
        const line = String(raw);
        const marker = /^\[sim-exec:([\w-]+):(begin|ok|error)\]$/.exec(line);
        if (marker) {
            const [, id, kind] = marker;
            if (kind === "begin") inst.execCurrent = { id, lines: [] };
            else {
                const pending = inst.execs.get(id);
                const output = inst.execCurrent?.id === id ? inst.execCurrent.lines : [];
                inst.execCurrent = null;
                if (pending) { inst.execs.delete(id); pending({ ok: kind === "ok", output: output.join("\n") }); }
            }
            continue;
        }
        if (inst.execCurrent) { inst.execCurrent.lines.push(line); continue; }
        // badgeware.fatal_error() prints "- ERROR: ..." and parks on an error screen.
        if (line.startsWith("- ERROR:")) inst.fatal = true;
        if (line.startsWith("[simulator] Running ") || line.startsWith("[simulator] Restarting app")) inst.fatal = false;
        inst.log.push(line);
    }
    if (inst.log.length > LOG_LIMIT) { const drop = inst.log.length - LOG_LIMIT; inst.log.splice(0, drop); inst.logBase += drop; }
    notify(inst);
}

// Turns the latest MicroPython traceback in the current run into repo paths.
function lastError(inst) {
    let start = 0;
    for (let i = inst.log.length - 1; i >= 0; i--) if (inst.log[i].startsWith("[simulator] Running ")) { start = i; break; }
    const run = inst.log.slice(start);
    let tb = -1;
    for (let i = run.length - 1; i >= 0; i--) if (/^(Traceback \(most recent call last\):|- ERROR:)/.test(run[i])) { tb = i; break; }
    if (tb < 0) return null;
    const frames = [];
    let message = "";
    const traceback = [];
    for (const [offset, line] of run.slice(tb).entries()) {
        traceback.push(line);
        const frame = /File "([^"]+)", line (\d+)(?:, in (.+))?/.exec(line);
        if (frame) {
            const [, rawFile, lineNo, fn] = frame;
            const file = rawFile.replace(/^\/+/, "/");
            const repoFile = file.startsWith("/system/") ? `badge/${file.slice("/system/".length)}` : null;
            frames.push({ file, line: Number(lineNo), function: fn ?? null, repo_path: repoFile && existsSync(join(inst.root, repoFile)) ? `${repoFile}:${lineNo}` : null });
        } else if (offset > 0 && !/^\s/.test(line)) { message = line; break; }
        else if (offset === 0 && line.startsWith("- ERROR:")) message = line.slice(8).trim();
    }
    const inApp = [...frames].reverse().find((f) => f.repo_path?.startsWith(`badge/apps/${inst.app}/`)) ?? [...frames].reverse().find((f) => f.repo_path);
    return { message, location: inApp?.repo_path ?? null, frames, traceback: traceback.join("\n") };
}

function snapshot(inst) {
    const stats = inst.stats ?? {};
    const age = inst.statsAt ? Date.now() - inst.statsAt : null;
    return {
        app: inst.app, revision: inst.revision, status: inst.status, state: inst.state,
        crashed: inst.state === "error" || Boolean(inst.fatal),
        running: stats.running ?? null, fps: stats.fps ?? null, frames: stats.frames ?? null,
        resolution: stats.width ? `${stats.width}x${stats.height}` : null,
        paused: stats.paused ?? null, upside_down: stats.rotated ?? null, backlight: stats.backlight ?? null,
        connected: inst.clients.size > 0, stats_age_ms: age,
        error: lastError(inst), cursor: cursorOf(inst),
        ...(stats.paused ? { note: "The canvas is hidden, so the simulator is paused. Ask the user to show the Badge Simulator panel." } : {}),
    };
}

function selectApp(inst, app) {
    if (app && !listApps(inst.root).includes(app)) throw new Error(`Unknown app "${app}". Apps live in badge/apps/<name>/__init__.py.`);
    inst.app = app || null;
    inst.revision++;
    inst.status = inst.app ? `Loading ${inst.app}` : "Choose an app to run";
    inst.state = "";
    clearLog(inst);
    saveLastApp(inst.app);
    watchApp(inst);
    broadcast(inst, { type: "reload", app: inst.app, revision: inst.revision });
}

async function handle(inst, req, res) {
    const url = new URL(req.url, "http://localhost");
    const path = decodeURIComponent(url.pathname);
    try {
        // Only serve this loopback origin: reject DNS-rebinding hosts, foreign origins and
        // POSTs without the page's custom header (which cross-origin callers can't send
        // without a CORS preflight this server never approves).
        const origin = new URL(inst.url).host;
        if (req.headers.host !== origin) return json(res, 403, { error: "Forbidden" });
        if (req.headers.origin && req.headers.origin !== `http://${origin}`) return json(res, 403, { error: "Forbidden" });
        if (req.method === "POST" && req.headers["x-badge-simulator"] !== "1") return json(res, 403, { error: "Forbidden" });
        if (path === "/events") {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
            res.write(": connected\n\n");
            res.clientId = url.searchParams.get("client") ?? "";
            inst.clients.add(res);
            notify(inst);
            const ping = setInterval(() => res.write(": ping\n\n"), 25000);
            req.on("close", () => { clearInterval(ping); inst.clients.delete(res); });
            return;
        }
        if (path === "/api/state") return json(res, 200, { apps: listApps(inst.root), app: inst.app, issue: inst.issue ?? null, auto_share: Boolean(inst.issue) && !inst.autoShared });
        if (path === "/api/app") {
            if (!inst.app) { res.writeHead(204); return res.end(); }
            const dir = join(appsDir(inst.root), inst.app);
            if (!existsSync(join(dir, "__init__.py"))) return json(res, 404, { error: `badge/apps/${inst.app}/__init__.py not found` });
            const files = appFiles(dir);
            const login = await githubLogin();
            if (login) files.push({ path: "github_login.txt", data: Buffer.from(`${login}\n`).toString("base64") });
            return json(res, 200, { app: inst.app, revision: inst.revision, files });
        }
        if (req.method === "POST" && path === "/api/record-frame") {
            const rec = inst.recordings.get(url.searchParams.get("id"));
            const frame = await readRaw(req, 4 * 1024 * 1024);
            const width = Number(url.searchParams.get("w")), height = Number(url.searchParams.get("h"));
            if (rec && frame && frame.length === width * height * 4) {
                if (rec.bytes + frame.length > recordingByteLimit) rec.truncated = true;
                else { rec.bytes += frame.length; rec.frames.push({ t: Number(url.searchParams.get("t")), width, height, data: new Uint8Array(frame) }); }
            }
            return json(res, 200, { ok: true });
        }
        if (req.method === "POST") {
            const body = await readBody(req);
            if (path === "/api/log") { ingestLog(inst, body.lines ?? []); return json(res, 200, { ok: true }); }
            if (path === "/api/status") { inst.status = String(body.status ?? ""); inst.state = String(body.state ?? ""); notify(inst); return json(res, 200, { ok: true }); }
            if (path === "/api/stats") {
                // Several clients (the Copilot panel, a test browser) may be connected; prefer a visible one.
                const now = Date.now();
                inst.statsBy.set(body.client, { ...body, at: now });
                for (const [id, entry] of inst.statsBy) if (now - entry.at > 5000) inst.statsBy.delete(id);
                const entries = [...inst.statsBy.values()];
                const best = entries.filter((e) => !e.paused).sort((x, y) => y.at - x.at)[0] ?? entries.sort((x, y) => y.at - x.at)[0];
                inst.stats = best; inst.statsAt = best.at;
                notify(inst);
                return json(res, 200, { ok: true });
            }
            if (path === "/api/select") { selectApp(inst, body.app); return json(res, 200, { ok: true }); }
            if (path === "/api/screenshot") {
                const pending = inst.screenshots.get(body.id);
                if (pending) { inst.screenshots.delete(body.id); pending(body.screen); }
                return json(res, 200, { ok: true });
            }
            if (path === "/api/share") {
                // auto runs once when the canvas opens for an issue: attach, but don't download.
                if (body.auto) {
                    if (inst.autoShared || !inst.issue) return json(res, 200, { ok: true, skipped: true });
                    inst.autoShared = true;
                }
                try { return json(res, 200, await doShare(inst, { download: body.download ?? !body.auto })); }
                catch (error) {
                    if (body.auto) inst.autoShared = false;
                    return json(res, 200, { ok: false, message: error.message });
                }
            }
            if (path === "/api/record-done") {
                inst.recordings.get(body.id)?.finish?.(body);
                return json(res, 200, { ok: true });
            }
            return json(res, 404, { error: "Not found" });
        }
        if (path.startsWith("/simulator/")) {
            const rel = path.slice("/simulator/".length);
            const bytes = await runtimeFile(rel);
            res.writeHead(200, { "Content-Type": mime[extname(rel)] ?? "application/octet-stream", "Cache-Control": "max-age=86400" });
            return res.end(bytes);
        }
        const file = resolve(webDir, "." + (path === "/" ? "/index.html" : path));
        if (!file.startsWith(webDir + sep) || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: "Not found" });
        res.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
        res.end(readFileSync(file));
    } catch (error) {
        if (!res.headersSent) json(res, error.status ?? 500, { error: error.message });
        else res.end();
    }
}

async function startInstance(ctx) {
    const root = repoRoot(ctx);
    const inst = {
        root, app: null, revision: 0, status: "Starting", state: "", log: [], logBase: 0,
        stats: null, statsAt: 0, waiters: new Set(), execs: new Map(), execCurrent: null,
        clients: new Set(), statsBy: new Map(), screenshots: new Map(), recordings: new Map(), watcher: null, reloadTimer: null, server: null, url: "",
    };
    const remembered = loadLastApp();
    if (remembered && listApps(root).includes(remembered)) inst.app = remembered;
    else if (listApps(root).includes(defaultApp)) inst.app = defaultApp;
    inst.server = createServer((req, res) => void handle(inst, req, res));
    await new Promise((r) => inst.server.listen(0, "127.0.0.1", r));
    inst.url = `http://127.0.0.1:${inst.server.address().port}/`;
    let appsTimer;
    try {
        inst.appsWatcher = watch(appsDir(root), () => {
            clearTimeout(appsTimer);
            appsTimer = setTimeout(() => broadcast(inst, { type: "apps", apps: listApps(root) }), 500);
        });
        inst.appsWatcher.on("error", () => {});
    } catch {}
    watchApp(inst);
    return inst;
}

function instanceFor(ctx) {
    const inst = instances.get(ctx.instanceId);
    if (!inst) throw new Error("The Badge Simulator canvas is not open. Open it with open_canvas first.");
    return inst;
}
async function requireClient(inst, timeoutMs = 15000) {
    if (inst.clients.size) return;
    if (!await waitUntil(inst, () => inst.clients.size > 0, timeoutMs)) {
        throw new Error("The Badge Simulator canvas is not connected. Open it (or re-run open_canvas with the same instanceId) and keep it visible, then try again.");
    }
}
// A hidden panel stops rendering, so the 3D badge can't be recorded. Wait (and say so)
// instead of failing the moment the learner is looking at something else.
function hasVisibleClient(inst) {
    const now = Date.now();
    return [...inst.statsBy.values()].some((e) => !e.paused && now - e.at < 5000);
}
async function requireVisibleClient(inst, timeoutMs = 120000) {
    await requireClient(inst);
    if (hasVisibleClient(inst)) return;
    broadcast(inst, { type: "share-status", text: "Open the Badge Simulator tab so your badge can finish…" });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await sleep(250);
        if (hasVisibleClient(inst)) return;
    }
    throw new Error("The Badge Simulator panel stayed hidden, so the badge never rendered. Bring the panel to the front and try again.");
}

// ---- agent actions ------------------------------------------------------------------
function buttonBit(button) {
    const name = String(button ?? "").toLowerCase().replace(/^button_/, "");
    const bit = buttonBits[name];
    if (!bit) throw new Error(`Unknown button "${button}". Use one of: ${Object.keys(buttonBits).join(", ")}`);
    return { name, bit };
}
async function doPress(inst, input) {
    await requireClient(inst);
    const names = Array.isArray(input?.button) ? input.button : String(input?.button ?? "").split("+");
    const pressed = names.map(buttonBit);
    const ms = Math.max(30, Math.min(10000, Number(input?.duration_ms ?? 120)));
    broadcast(inst, { type: "press", bit: pressed.reduce((mask, b) => mask | b.bit, 0), ms });
    return { pressed: pressed.map((b) => b.name).join("+"), duration_ms: ms };
}
async function doScreenshot(inst, label) {
    await requireClient(inst);
    const id = Math.random().toString(36).slice(2);
    const dataUrl = await new Promise((ok, fail) => {
        const timer = setTimeout(() => { inst.screenshots.delete(id); fail(new Error("Timed out waiting for the canvas")); }, 5000);
        inst.screenshots.set(id, (value) => { clearTimeout(timer); ok(value); });
        broadcast(inst, { type: "screenshot", id });
    });
    const dir = join(session.workspacePath ?? cacheDir, "files", "badge-simulator");
    mkdirSync(dir, { recursive: true });
    const slug = label ? `-${String(label).replace(/[^\w-]+/g, "_").slice(0, 40)}` : "";
    const file = join(dir, `${inst.app ?? "screen"}${slug}-${Date.now()}.png`);
    writeFileSync(file, Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ""), "base64"));
    return { path: file, app: inst.app };
}
// Recordings go to one client (preferring a visible one) so frames aren't duplicated.
function recordingClient(inst) {
    const clients = [...inst.clients];
    const live = clients.filter((c) => { const s = inst.statsBy.get(c.clientId); return s && !s.paused; });
    return live.at(-1) ?? clients.at(-1);
}
const recordingByteLimit = 256 * 1024 * 1024;
async function doRecord(inst, input = {}) {
    if (input.scale !== undefined && (!Number.isInteger(input.scale) || input.scale < 1 || input.scale > 4)) {
        throw new Error("Recording scale must be an integer from 1 to 4.");
    }
    if (inst.recordingActive) throw new Error("A recording is already in progress in this canvas.");
    inst.recordingActive = true;
    try {
        return await recordScreen(inst, input);
    } finally {
        inst.recordingActive = false;
    }
}
// ---- share ---------------------------------------------------------------------------
// Records the whole 3D badge and, when the canvas was opened for an issue, uploads
// the GIF and creates (or updates) a "Your Virtual Universe '26 badge" artifact on it.
const shareArtifactName = "Your Virtual Universe 26 badge";
function parseIssue(value) {
    const text = String(value ?? "").trim();
    const m = text.match(/^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/issues\/)(\d+)\/?$/);
    return m ? { repo: m[1], number: Number(m[2]) } : null;
}
// The badge GIF is tall, so the artifact shows it at a comfortable width, under a
// download link and the hashtag to post it with.
function shareBody(gif, login) {
    const who = login ? `@${login}` : "you";
    const alt = `Astronaut Mona flies across a GitHub Universe badge that says Congratulations ${who}! You finished Virtual Universe '26`;
    const astronaut = "\u{1F9D1}\u{1F3FF}\u200D\u{1F680}";
    return [
        `### \u2B07\uFE0F [Download your badge GIF](${gif})`,
        "",
        `Post it on social with the hashtag **#virtualuniverse26** to connect with the rest of the virtual community ${astronaut}`,
        "",
        `<img src="${gif}" alt="${alt}" width="300">`,
    ].join("\n");
}
// Saves the GIF to the learner's Downloads folder and shows it in their file
// manager, so they can post it anywhere they like.
function saveGif(gifPath) {
    const saved = join(homedir(), "Downloads", "virtual-universe-26-badge.gif");
    try { mkdirSync(dirname(saved), { recursive: true }); copyFileSync(gifPath, saved); } catch { return { saved: gifPath, revealed: false } }
    if (process.platform === "darwin") execFile("open", ["-R", saved], () => {});
    else if (process.platform === "win32") execFile("explorer", [`/select,${saved}`], () => {});
    return { saved, revealed: process.platform === "darwin" || process.platform === "win32" };
}
// gh talks to api.github.com, so a single blip shouldn't lose a recording.
async function withRetry(label, run) {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await sleep(500 * attempt);
        try { return await run(); } catch (error) { last = error; }
    }
    throw new Error(`${label}: ${ghError(last)}`);
}
async function uploadToIssue({ repo, number }, file, alt) {
    const issuePath = `repos/${repo}/issues/${number}`;
    const before = JSON.parse(await gh(["api", issuePath])).body ?? "";
    // gh only uploads attachments while editing an issue, so attach, read the URL, then restore the body.
    await gh(["issue", "edit", String(number), "-R", repo, "--attach", `${file}#${alt}`]);
    const after = JSON.parse(await gh(["api", issuePath])).body ?? "";
    const url = (after.match(/https:\/\/github\.com\/user-attachments\/assets\/[\w-]+/g) ?? []).find((u) => !before.includes(u));
    await gh(["api", "-X", "PATCH", issuePath, "-f", `body=${before}`]);
    if (!url) throw new Error("GitHub didn't return a URL for the uploaded GIF.");
    return url;
}
async function upsertArtifact({ repo, number }, name, body) {
    const base = `repos/${repo}/issues/${number}/artifacts`;
    const existing = JSON.parse(await gh(["api", base])).find((a) => a.name === name);
    const out = existing
        ? await gh(["api", "-X", "PATCH", `${base}/${existing.number}`, "-f", `name=${name}`, "-f", `body=${body}`])
        : await gh(["api", "-X", "POST", base, "-f", "type=generic", "-f", `name=${name}`, "-f", `body=${body}`]);
    return JSON.parse(out).html_url;
}
async function doShare(inst, input = {}) {
    if (!inst.app) throw new Error("Choose an app to share first.");
    const download = input.download ?? input.post ?? true;
    const step = (text) => broadcast(inst, { type: "share-status", text });
    const started = Date.now();
    if (inst.sharing) throw new Error("Your badge is already being shared.");
    inst.sharing = true;
    try {
        step("Making your badge GIF…");
        let rec = await doRecord(inst, { duration_ms: 4000, fps: 12, view: "badge", label: "share", sheet: false });
        // The 3D badge can come up empty on some GPUs; the app screen is a fine stand-in.
        if (!rec.gif) rec = await doRecord(inst, { duration_ms: 2500, fps: 12, view: "screen", label: "share", sheet: false });
        if (!rec.gif) throw new Error(rec.error ?? "Your badge GIF could not be made.");
        inst.lastGif = rec.gif;
        let artifact = null, issueError = null;
        if (inst.issue) {
            try {
                step("Adding your badge GIF to your issue…");
                const gif = await withRetry("upload", () => uploadToIssue(inst.issue, rec.gif, "Your Virtual Universe '26 badge"));
                const login = await githubLogin();
                artifact = await withRetry("artifact", () => upsertArtifact(inst.issue, shareArtifactName, shareBody(gif, login)));
            } catch (error) { issueError = `couldn't add it to ${inst.issue.repo}#${inst.issue.number}: ${ghError(error)}`; }
        }
        const saved = download ? saveGif(rec.gif) : null;
        const parts = [];
        if (artifact) parts.push("Added to your issue's Artifacts");
        if (saved) parts.push(`saved to ${saved.saved}`);
        if (issueError) parts.push(issueError);
        return { ok: !issueError, gif: rec.gif, saved: saved?.saved ?? null, artifact, message: parts.join(" · ") || "Your badge GIF is ready", seconds: (Date.now() - started) / 1000 };
    } finally {
        inst.sharing = false;
    }
}
async function recordScreen(inst, input) {
    await requireClient(inst);
    if (input.view === "badge") await requireVisibleClient(inst);
    if (input.restart) { doReload(inst, false); await waitForRun(inst); }
    const steps = Array.isArray(input.steps) ? input.steps : [];
    const fps = Math.max(1, Math.min(30, Number(input.fps ?? 15) || 15));
    const durationMs = clampMs(input.duration_ms, steps.length ? 0 : 3000);
    const id = Math.random().toString(36).slice(2);
    const client = recordingClient(inst);
    const rec = { frames: [], bytes: 0, truncated: false, finish: null };
    inst.recordings.set(id, rec);
    const send = (event) => client.write(`data: ${JSON.stringify(event)}\n\n`);
    const since = cursorOf(inst);
    const started = Date.now();
    send({ type: "record-start", id, fps, video: Boolean(input.video), scale: input.scale ?? 0, view: input.view === "badge" ? "badge" : "screen" });
    let script, done;
    try {
        if (steps.length) script = await runScript(inst, { steps, stop_on_crash: input.stop_on_crash });
        const remaining = durationMs - (Date.now() - started);
        if (remaining > 0) await sleep(remaining);
    } finally {
        done = await new Promise((ok) => {
            const timer = setTimeout(() => ok({ error: "Timed out waiting for the canvas to finish the recording" }), 30000);
            rec.finish = (body) => { clearTimeout(timer); ok(body); };
            send({ type: "record-stop", id });
        });
        inst.recordings.delete(id);
    }
    const elapsed = Number.isFinite(done.duration_ms) && done.duration_ms >= 0 ? done.duration_ms : Date.now() - started;
    const result = { app: inst.app, sample_fps: fps, duration_ms: elapsed, ...(script ? { steps: script.steps } : {}) };
    if (done.error) result.error = done.error;
    const frames = rec.frames.sort((a, b) => a.t - b.t);
    if (!frames.length) {
        result.error ??= "The badge did not render. Keep the Badge Simulator panel visible (a hidden canvas pauses) and make sure the app is running.";
        return { ...snapshot(inst), ...result, output: linesSince(inst, since).slice(-80).join("\n") };
    }
    const { width, height } = frames[0];
    const usable = frames.filter((f) => f.width === width && f.height === height);
    const end = Math.max(elapsed, usable.at(-1).t + 1000 / fps);
    usable.forEach((f, i) => { f.delayMs = (usable[i + 1]?.t ?? end) - f.t; });
    const scale = input.scale ?? (width >= 320 ? 1 : 2);

    const dir = join(session.workspacePath ?? cacheDir, "files", "badge-simulator");
    mkdirSync(dir, { recursive: true });
    const slug = input.label ? `-${String(input.label).replace(/[^\w-]+/g, "_").slice(0, 40)}` : "";
    const base = join(dir, `${inst.app ?? "screen"}${slug}-${Date.now()}`);

    const sheetCount = input.sheet === false ? 0 : Math.max(1, Math.min(48, Number(input.sheet_frames) || 12));
    const picks = [];
    for (let k = 0; k < sheetCount; k++) {
        const target = sheetCount === 1 ? 0 : (k * (end - 1)) / (sheetCount - 1);
        const frame = usable.findLast((f) => f.t <= target) ?? usable[0];
        if (picks.at(-1) !== frame) picks.push(frame);
    }
    if (picks.length) {
        writeFileSync(`${base}-sheet.png`, contactSheet(width, height, picks, { scale: width >= 320 ? 1 : 2 }));
        result.contact_sheet = `${base}-sheet.png`;
    }
    if (input.gif !== false) { writeFileSync(`${base}.gif`, encodeGif(width, height, usable, scale)); result.gif = `${base}.gif`; }
    if (done.video?.data) {
        const ext = String(done.video.mime).includes("mp4") ? "mp4" : "webm";
        writeFileSync(`${base}.${ext}`, Buffer.from(done.video.data, "base64"));
        result.video = `${base}.${ext}`;
    } else if (input.video) result.video_error = done.video_error ?? "The browser could not record video";
    if (input.save_frames) {
        mkdirSync(`${base}-frames`, { recursive: true });
        usable.forEach((f, i) => writeFileSync(join(`${base}-frames`, `${String(i + 1).padStart(4, "0")}-${Math.round(f.t)}ms.png`), encodePng(width, height, f.data)));
        result.frames_dir = `${base}-frames`;
    }
    const holds = usable.map((f) => f.delayMs);
    Object.assign(result, {
        width, height, scale, distinct_frames: usable.length, rendered_frames: done.rendered_frames,
        longest_static_ms: Math.round(Math.max(...holds)),
        sheet_times_ms: picks.map((f) => Math.round(f.t)),
        ...(usable.length < frames.length ? { skipped_resized_frames: frames.length - usable.length } : {}),
        ...(rec.truncated ? { truncated: "Stopped storing frames after 256 MB; use a lower fps or shorter duration." } : {}),
    });
    return { ...snapshot(inst), ...result, output: linesSince(inst, since).slice(-80).join("\n") };
}
async function doExec(inst, input) {
    await requireClient(inst);
    const code = String(input?.code ?? "");
    if (!code.trim()) throw new Error("Pass MicroPython source in `code`.");
    const id = Math.random().toString(36).slice(2, 10);
    const timeout = clampMs(input?.timeout_ms, 5000);
    const result = await new Promise((done) => {
        const timer = setTimeout(() => { inst.execs.delete(id); done(null); }, timeout);
        inst.execs.set(id, (value) => { clearTimeout(timer); done(value); });
        broadcast(inst, { type: "exec", id, code });
    });
    if (!result) {
        const partial = inst.execCurrent?.id === id ? inst.execCurrent.lines.join("\n") : "";
        return {
            ok: false, timed_out: true, output: partial,
            hint: "No result yet. The code may still be running, the app may be blocking without calling badge.poll(), or the canvas may be hidden (paused). Check get_output.",
            ...snapshot(inst),
        };
    }
    return { ...result, ran_in: inst.state === "stopped" ? "standalone" : "app", app: inst.app, state: inst.state };
}
async function doWaitFor(inst, input) {
    const since = input?.since ?? cursorOf(inst);
    const pattern = input?.pattern ? new RegExp(input.pattern) : null;
    const onCrash = input?.until_crash !== false;
    const minFrames = input?.frames ? Number(input.frames) : null;
    const startFrames = new Map([...inst.statsBy].map(([id, e]) => [id, e.frames]));
    const outcome = await waitUntil(inst, () => {
        if (pattern) {
            const hit = linesSince(inst, since).find((line) => pattern.test(line));
            if (hit !== undefined) return { reason: "match", matched_line: hit };
        }
        if (onCrash && (inst.state === "error" || inst.fatal)) return { reason: "crash" };
        if (minFrames) {
            for (const [id, e] of inst.statsBy) {
                if (!startFrames.has(id)) startFrames.set(id, e.frames);
                else if (!e.paused && e.frames - startFrames.get(id) >= minFrames) return { reason: "frames" };
            }
        }
        return null;
    }, clampMs(input?.timeout_ms, 5000));
    return { ...(outcome ?? { reason: "timeout" }), ...snapshot(inst), output: linesSince(inst, since).slice(-80).join("\n") };
}
function doReload(inst, restartRuntime) {
    inst.revision++;
    inst.state = "";
    clearLog(inst);
    broadcast(inst, restartRuntime ? { type: "restart" } : { type: "reload", app: inst.app, revision: inst.revision });
}
async function waitForRun(inst, timeoutMs = 15000) {
    const since = cursorOf(inst);
    const ok = await waitUntil(inst, () => linesSince(inst, since).some((l) => l.startsWith("[simulator] Running ")) || null, timeoutMs);
    if (!ok) throw new Error("The app did not start within the timeout. Check get_output.");
}

async function runScript(inst, input) {
    await requireClient(inst);
    const steps = Array.isArray(input?.steps) ? input.steps : [];
    const stopOnCrash = input?.stop_on_crash !== false;
    if (input?.restart) { doReload(inst, false); await waitForRun(inst); }
    const since = cursorOf(inst);
    const results = [];
    for (const [index, step] of steps.entries()) {
        let result;
        try {
            if (step.press !== undefined) {
                result = await doPress(inst, { button: step.press, duration_ms: step.duration_ms });
                await sleep(result.duration_ms + 60);
            } else if (step.wait_ms !== undefined) {
                await sleep(clampMs(step.wait_ms, 0));
                result = { waited_ms: clampMs(step.wait_ms, 0) };
            } else if (step.screenshot !== undefined) {
                result = await doScreenshot(inst, typeof step.screenshot === "string" ? step.screenshot : `step${index + 1}`);
            } else if (step.exec !== undefined) {
                result = await doExec(inst, { code: step.exec, timeout_ms: step.timeout_ms });
            } else if (step.wait_for !== undefined) {
                const options = typeof step.wait_for === "object" && step.wait_for ? step.wait_for : { pattern: String(step.wait_for) };
                const waited = await doWaitFor(inst, { timeout_ms: step.timeout_ms, since: step.since_start ? since : undefined, ...options });
                result = { reason: waited.reason, matched_line: waited.matched_line };
            } else if (step.rotate !== undefined) {
                broadcast(inst, { type: "rotate", value: step.rotate === "toggle" ? undefined : Boolean(step.rotate) });
                await sleep(300);
                result = { rotated: step.rotate };
            } else throw new Error(`Unknown step ${JSON.stringify(step)}. Use press, wait_ms, screenshot, exec, wait_for or rotate.`);
            results.push({ step: index + 1, ...step, result });
        } catch (error) {
            results.push({ step: index + 1, ...step, error: error.message });
            break;
        }
        if (stopOnCrash && (inst.state === "error" || inst.fatal)) { results.push({ step: index + 1, stopped: "app crashed" }); break; }
    }
    return { steps: results, ...snapshot(inst), output: linesSince(inst, since).slice(-120).join("\n") };
}

// Static checks that mirror the repo's PR validation and common porting mistakes.
const legacyPatterns = [
    [/^\s*(import badge\b|from badge import)/m, "Imports `badge`; on 2026 firmware `badge` is a runtime global, do not import it."],
    [/from badgeware import [^\n]*\b(io|brushes|shapes|screen|PixelFont|run)\b/, "Imports 2025 badgeware APIs (io/brushes/shapes/screen/PixelFont/run); 2026 apps use the runtime globals."],
    [/\bio\.(BUTTON_\w+|pressed|held|released|ticks)/, "Uses 2025 `io.*` input/timing; use badge.pressed()/held()/released() and badge.ticks."],
    [/\bbrushes\.|\bshapes\.[a-z]/, "Uses 2025 `brushes`/`shapes`; use color.rgb(), screen.pen and shape.*."],
    [/\bscreen\.draw\(/, "Uses 2025 `screen.draw()`; use screen.shape()."],
];
function pngSize(file) {
    const b = readFileSync(file);
    if (b.length < 24 || b.toString("ascii", 1, 4) !== "PNG") return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
function readmeDescription(text) {
    const skip = ["#", ">", "|", "-", "*", "!", "[!", "```", "<"];
    const paragraph = [];
    for (const line of text.split(/\r?\n/)) {
        const s = line.trim();
        if (!s) { if (paragraph.length) break; continue; }
        if (skip.some((p) => s.startsWith(p))) { if (paragraph.length) break; continue; }
        paragraph.push(s);
    }
    const joined = paragraph.join(" ");
    const m = /^(.+?[.!?])(?=\s|$)/.exec(joined);
    return (m ? m[1] : joined).trim();
}
function checkApp(inst, app) {
    app = app || inst.app;
    if (!app) throw new Error("No app selected.");
    const dir = join(appsDir(inst.root), app);
    if (!existsSync(dir)) throw new Error(`badge/apps/${app} does not exist.`);
    const errors = [], warnings = [];
    if (!existsSync(join(dir, "__init__.py"))) errors.push("Missing __init__.py.");
    const icon = join(dir, "icon.png");
    if (!existsSync(icon)) errors.push("Missing 24x24 icon.png.");
    else { const size = pngSize(icon); if (!size) errors.push("icon.png is not a PNG."); else if (size.width !== 24 || size.height !== 24) warnings.push(`icon.png is ${size.width}x${size.height}; the menu expects 24x24.`); }
    const readme = ["README.md", "readme.md"].map((n) => join(dir, n)).find(existsSync);
    if (!readme) errors.push("Missing README.md (the Validate app READMEs check will fail).");
    else {
        const sentence = readmeDescription(readFileSync(readme, "utf8"));
        if (!sentence) errors.push("README.md has no description paragraph after the title.");
        else if (sentence.length < 10) errors.push("README description is too short (minimum 10 characters).");
        else if (sentence.length > 200) errors.push(`README first sentence is too long (${sentence.length} > 200 characters).`);
        else if (!".!?".includes(sentence.at(-1))) errors.push("README first sentence must end with punctuation.");
    }
    const files = appFiles(dir).map((f) => f.path);
    for (const rel of files.filter((f) => f.endsWith(".py"))) {
        const text = readFileSync(join(dir, rel), "utf8");
        for (const [re, message] of legacyPatterns) {
            const m = re.exec(text);
            if (m) warnings.push(`badge/apps/${app}/${rel}:${text.slice(0, m.index).split("\n").length}: ${message}`);
        }
    }
    if (existsSync(join(appsDir(inst.root), "..", "secrets.py")) && readFileSync(join(appsDir(inst.root), "..", "secrets.py"), "utf8").match(/^\s*(WIFI_SSID|WIFI_PASSWORD|GITHUB_USERNAME|GITHUB_TOKEN)\s*=\s*["'][^"']+["']/m))
        warnings.push("badge/secrets.py contains values; keep it empty in source control.");
    return { app, ok: errors.length === 0, errors, warnings, files };
}

session = await joinSession({
    canvases: [
        createCanvas({
            id: "badge-simulator",
            displayName: "Badge Simulator",
            description:
                "Runs a Universe 2026 badge app from badge/apps/<app> in the 3D badge simulator. The canvas reloads automatically whenever the app's files change, mirrors the app theme, records GIFs and screenshots, and has a Share button that saves the whole badge as a GIF. Open it with input {app: \"<folder name>\"} while building or testing an app, plus {issue: \"owner/repo#number\"} to record the badge automatically and add the GIF to that issue as an artifact.",
            inputSchema: {
                type: "object",
                properties: {
                    app: { type: "string", description: "Folder name under badge/apps to run, e.g. flappy_mona" },
                    issue: { type: "string", description: "Issue to add the badge GIF artifact to automatically, as owner/repo#number" },
                },
            },
            actions: [
                {
                    name: "load_app",
                    description: "Switch the simulator to another app in badge/apps.",
                    inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
                    handler: (ctx) => { const inst = instanceFor(ctx); selectApp(inst, ctx.input?.app); return { app: inst.app }; },
                },
                {
                    name: "reload",
                    description: "Reload the current app from disk (normally automatic when files change). Pass {restart_runtime:true} to also reboot the MicroPython runtime, and {wait:true} to wait until it is running again.",
                    inputSchema: { type: "object", properties: { restart_runtime: { type: "boolean" }, wait: { type: "boolean" } } },
                    handler: async (ctx) => {
                        const inst = instanceFor(ctx);
                        doReload(inst, ctx.input?.restart_runtime);
                        if (ctx.input?.wait) await waitForRun(inst);
                        return { app: inst.app, revision: inst.revision, cursor: cursorOf(inst) };
                    },
                },
                {
                    name: "get_output",
                    description: "Return simulator status (running/crashed, fps, resolution, paused, orientation), the latest traceback mapped to a repo file:line, and recent MicroPython console output. Pass `since` (a cursor from a previous call) to get only new lines.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            lines: { type: "number", description: "Number of recent lines (default 80)" },
                            since: { type: "number", description: "Only return lines after this cursor" },
                        },
                    },
                    handler: (ctx) => {
                        const inst = instanceFor(ctx);
                        const lines = ctx.input?.since !== undefined ? linesSince(inst, ctx.input.since) : inst.log;
                        return { ...snapshot(inst), output: lines.slice(-(ctx.input?.lines ?? 80)).join("\n") };
                    },
                },
                {
                    name: "press",
                    description: "Press badge buttons in the simulator. button: up, down, left, right, select, home, back, menu (or a, b, c); combine with \"a+b\" or an array.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            button: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
                            duration_ms: { type: "number", description: "Hold time (default 120, max 10000)" },
                        },
                        required: ["button"],
                    },
                    handler: (ctx) => doPress(instanceFor(ctx), ctx.input),
                },
                {
                    name: "screenshot",
                    description: "Capture the simulated badge screen at its native resolution as a PNG and return its file path (view it with the view tool).",
                    inputSchema: { type: "object", properties: { label: { type: "string" } } },
                    handler: (ctx) => doScreenshot(instanceFor(ctx), ctx.input?.label),
                },
                {
                    name: "exec",
                    description: "Run MicroPython in the simulator, like the badge REPL, and return its output or traceback. While the app runs, code executes between frames inside the app module's globals, so you can inspect or change live state (expressions print their repr). If the app has crashed or stopped, it runs as a standalone program instead (reload to restart the app). Useful for checking APIs, files under /state, and app variables.",
                    inputSchema: {
                        type: "object",
                        properties: { code: { type: "string" }, timeout_ms: { type: "number", description: "Default 5000" } },
                        required: ["code"],
                    },
                    handler: (ctx) => doExec(instanceFor(ctx), ctx.input),
                },
                {
                    name: "wait_for",
                    description: "Wait until console output matches a regex `pattern`, the app crashes, a number of `frames` render, or `timeout_ms` passes (default 5000). Returns the reason, status and new output. Pass `since` (a cursor) to include output already printed.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            pattern: { type: "string" }, frames: { type: "number" }, timeout_ms: { type: "number" },
                            since: { type: "number" }, until_crash: { type: "boolean", description: "Also stop on crash (default true)" },
                        },
                    },
                    handler: (ctx) => doWaitFor(instanceFor(ctx), ctx.input),
                },
                {
                    name: "run_script",
                    description: "Run a scripted test: a list of steps executed in order, returning per-step results, screenshot paths, final status and output. Steps: {press:\"a\", duration_ms}, {wait_ms}, {screenshot:\"label\"}, {exec:\"code\"}, {wait_for:\"regex\" or {pattern, frames, until_crash}, timeout_ms}, {rotate:true|false|\"toggle\"}. Set restart:true to reload the app first. Stops on crash unless stop_on_crash:false.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            steps: { type: "array", items: { type: "object" } },
                            restart: { type: "boolean" },
                            stop_on_crash: { type: "boolean" },
                        },
                        required: ["steps"],
                    },
                    handler: (ctx) => runScript(instanceFor(ctx), ctx.input),
                },
                {
                    name: "record",
                    description: "Record the simulated badge screen as an animated GIF plus a labelled contact-sheet PNG (view it with the view tool to check motion), optionally MP4/WebM video and per-frame PNGs. Records for duration_ms (default 3000, or until `steps` finish), and `steps` (run_script steps) drive input while recording. Only frames that change are kept; returns distinct_frames, longest_static_ms and file paths.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            duration_ms: { type: "number", description: "Minimum length; default 3000 (0 with steps), max 60000" },
                            fps: { type: "number", description: "Sampling rate, 1-30 (default 15)" },
                            steps: { type: "array", items: { type: "object" }, description: "run_script steps to perform while recording" },
                            restart: { type: "boolean", description: "Reload the app before recording" },
                            stop_on_crash: { type: "boolean" },
                            label: { type: "string" },
                            scale: { type: "integer", minimum: 1, maximum: 4, description: "GIF/video upscale 1-4 (default 2 for 160x120, 1 for 320x240)" },
                            gif: { type: "boolean", description: "Write an animated GIF (default true)" },
                            view: { type: "string", enum: ["screen", "badge"], description: "screen (default) records the 320x240 display; badge records the whole 3D badge as shown" },
                            sheet: { type: "boolean", description: "Write the contact sheet (default true)" },
                            video: { type: "boolean", description: "Also record MP4 (or WebM) video with the browser's MediaRecorder" },
                            sheet_frames: { type: "number", description: "Frames in the contact sheet (default 12)" },
                            save_frames: { type: "boolean", description: "Also write every distinct frame as a PNG" },
                        },
                    },
                    handler: (ctx) => doRecord(instanceFor(ctx), ctx.input ?? {}),
                },
                {
                    name: "share",
                    description: "Same as the Share button: record the whole 3D badge for 4 seconds as a GIF and, if the canvas was opened with {issue}, upload it and add a \"Your Virtual Universe 26 badge\" artifact (the GIF, a download link and the hashtag to post it with) to that issue, then save the GIF to the learner's Downloads folder. The canvas already does this automatically when it opens for an issue. Returns the GIF path and artifact URL.",
                    inputSchema: { type: "object", properties: { download: { type: "boolean", description: "Save the GIF to Downloads and reveal it (default true)" } } },
                    handler: async (ctx) => {
                        const inst = instanceFor(ctx);
                        const result = await doShare(inst, ctx.input ?? {});
                        broadcast(inst, { type: "share-status", text: result.message, done: true });
                        return result;
                    },
                },
                {
                    name: "rotate",
                    description: "Turn the simulated badge upside down or back (same as the Rotate button). Pass upside_down true/false, or omit to toggle.",
                    inputSchema: { type: "object", properties: { upside_down: { type: "boolean" } } },
                    handler: async (ctx) => {
                        const inst = instanceFor(ctx);
                        await requireClient(inst);
                        broadcast(inst, { type: "rotate", value: ctx.input?.upside_down });
                        await sleep(1200);
                        return { upside_down: inst.stats?.rotated ?? null };
                    },
                },
                {
                    name: "check_app",
                    description: "Static pre-flight checks for an app (default: the current one): __init__.py, 24x24 icon.png, README description rules from the PR check, and 2025-era API usage that breaks on 2026 firmware.",
                    inputSchema: { type: "object", properties: { app: { type: "string" } } },
                    handler: (ctx) => checkApp(instanceFor(ctx), ctx.input?.app),
                },
            ],
            open: async (ctx) => {
                let inst = instances.get(ctx.instanceId);
                if (!inst) {
                    inst = await startInstance(ctx);
                    instances.set(ctx.instanceId, inst);
                }
                const app = ctx.input && typeof ctx.input === "object" ? ctx.input.app : undefined;
                if (app && app !== inst.app) selectApp(inst, app);
                const issue = parseIssue(ctx.input?.issue);
                if (issue) { inst.issue = issue; broadcast(inst, { type: "issue", issue }); }
                return { title: inst.app ? `Badge Simulator · ${inst.app}` : "Badge Simulator", url: inst.url };
            },
            onClose: async (ctx) => {
                const inst = instances.get(ctx.instanceId);
                if (!inst) return;
                instances.delete(ctx.instanceId);
                inst.watcher?.close();
                inst.appsWatcher?.close();
                clearTimeout(inst.reloadTimer);
                for (const client of inst.clients) client.end();
                await new Promise((r) => inst.server.close(() => r()));
            },
        }),
    ],
});
