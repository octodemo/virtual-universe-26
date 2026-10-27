import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import vm from "node:vm";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const extensionURL = new URL(".github/extensions/universe-cheatsheet-artifact/extension.mjs", root);
const source = await readFile(extensionURL, "utf8");

// Replaces the GitHub CLI with a fake repository so the canvas can be driven end to end.
function fakeGh({ login = "learner", forks = ["learner/virtual-universe-26"], issues = true, openIssues = [], attach = true } = {}) {
    const calls = [];
    const bodies = new Map();
    const execFile = (cmd, args, options, done) => {
        calls.push(args);
        const joined = args.join(" ");
        let out = null;
        if (joined.startsWith("api user")) out = login;
        else if (joined.includes("/forks?")) out = forks.join("\n");
        else if (/^api repos\/[^/]+\/virtual-universe-26 /.test(joined)) out = "";
        else if (/^api repos\/.* .has_issues$/.test(joined)) out = String(issues);
        else if (joined.startsWith("api -X PATCH")) {
            bodies.set(42, args[args.indexOf("-f") + 1].replace(/^body=/, ""));
            out = "";
        } else if (joined.startsWith("repo edit")) { issues = true; out = ""; }
        else if (joined.startsWith("repo fork")) { forks = [`${login}/virtual-universe-26`]; out = ""; }
        else if (joined.startsWith("issue list")) out = JSON.stringify(openIssues);
        else if (joined.startsWith("issue view")) out = bodies.get(Number(args[2])) ?? "";
        else if (joined.startsWith("issue create")) {
            // Old GitHub CLI builds have no --attach, so that call fails.
            if (args.includes("--attach") && !attach) out = null;
            else {
                const number = 42;
                openIssues.push({ number, title: args[args.indexOf("--title") + 1] });
                const body = args[args.indexOf("--body") + 1];
                bodies.set(number, args.includes("--attach")
                    ? `${body}\n\n![Copilot astronaut](https://github.com/user-attachments/assets/abc-123)`
                    : body);
                out = `https://github.com/${forks[0]}/issues/${number}`;
            }
        }
        setImmediate(() => done(out === null ? new Error("unknown") : null, out ?? ""));
    };
    return { execFile, calls, bodies };
}

async function harness(gh = fakeGh(), home = mkdtempSync(join(tmpdir(), "cheatsheet-"))) {
    let registration;
    const script = source.replace(/^import .*;\n/gm, "").replaceAll("import.meta.url", JSON.stringify(extensionURL.href));
    await vm.runInNewContext(`(async()=>{${script}})()`, {
        createServer, readFile, writeFile, mkdir, URL, URLSearchParams, setTimeout, JSON, Date, Number, String, Boolean, console, fileURLToPath,
        homedir: () => home, join, process: { env: { COPILOT_HOME: home } },
        execFile: gh.execFile,
        joinSession: async (options) => { registration = options; return {}; },
        createCanvas: (options) => options,
    });
    return { gh, home, canvas: registration.canvases[0] };
}

test("the guide page points at /create-issue-artifact and serves its images", async () => {
    const { canvas } = await harness();
    const { url } = await canvas.open({ instanceId: "t" });
    try {
        const page = await (await fetch(url)).text();
        assert.match(page, /\/create-issue-artifact follow github-virtual-universe-highlights\/attach-a-cheat-sheet-artifact\/instructions\.md/);
        for (const name of ["preview.png", "astronaut.png"]) {
            const img = await fetch(new URL(name, url));
            assert.equal(img.status, 200, name);
            assert.equal(img.headers.get("content-type"), "image/png");
        }
        assert.equal((await fetch(new URL("nope", url))).status, 404);
    } finally {
        await canvas.onClose({ instanceId: "t" });
    }
});

test("start creates the issue in the fork and returns a session link carrying it", async () => {
    const { canvas, gh } = await harness();
    const { url } = await canvas.open({ instanceId: "t" });
    try {
        const res = await fetch(new URL("start", url), { method: "POST" });
        const data = await res.json();
        assert.equal(data.error, undefined);
        assert.equal(data.fork, "learner/virtual-universe-26");
        assert.equal(data.number, 42);

        const link = new URL(data.link);
        assert.equal(link.protocol, "ghapp:");
        assert.equal(link.searchParams.get("repo"), "learner/virtual-universe-26");
        assert.equal(link.searchParams.get("issue"), "42");
        // The new session opens this guide itself, and the prompt is what makes
        // the session real so the issue actually attaches.
        assert.equal(link.searchParams.get("canvas"), null, "the host refuses canvas alongside issue");
        assert.match(link.searchParams.get("prompt"), /universe-cheatsheet-artifact/);
        assert.match(link.searchParams.get("prompt"), /do not run `\/create-issue-artifact`/);

        const create = gh.calls.find((a) => a[0] === "issue" && a[1] === "create");
        assert.equal(create[create.indexOf("-R") + 1], "learner/virtual-universe-26");
        assert.equal(create[create.indexOf("--title") + 1], "My GitHub Universe '26 cheat sheet");
        assert.match(create[create.indexOf("--attach") + 1], /astronaut\.png#Copilot astronaut$/);
        assert.match(create[create.indexOf("--body") + 1], /Badge Simulator/);
        assert.match(create[create.indexOf("--body") + 1], /\/create-issue-artifact/);
        // Readers who skipped Virtual Universe get pointed at the workshop.
        assert.match(create[create.indexOf("--body") + 1], /https:\/\/github\.com\/octodemo\/virtual-universe-26/);

        // The astronaut ends up hosted by GitHub, not linked from a branch.
        const body = gh.bodies.get(42);
        assert.match(body, /^<img src="https:\/\/github\.com\/user-attachments\/assets\/abc-123" alt="Copilot astronaut" width="120" align="right">/);
        assert.doesNotMatch(body, /raw\.githubusercontent\.com/);
    } finally {
        await canvas.onClose({ instanceId: "t" });
    }
});

test("the session the deep link opens starts at the skill step, the launching one does not", async () => {
    const home = mkdtempSync(join(tmpdir(), "cheatsheet-"));
    const first = await harness(fakeGh(), home);
    const launcher = await first.canvas.open({ instanceId: "a", sessionId: "session-1" });
    try {
        // Before the issue exists, every copy of the guide shows step 1.
        assert.equal(new URL(launcher.url).searchParams.get("ready"), null);
        await (await fetch(new URL("start", launcher.url), { method: "POST" })).json();

        // The session that made the issue keeps step 1; it is not linked to it.
        const again = await first.canvas.open({ instanceId: "b", sessionId: "session-1" });
        assert.equal(new URL(again.url).searchParams.get("ready"), null);
        await first.canvas.onClose({ instanceId: "b" });

        // The session the deep link opened is linked to the issue, so step 1 goes.
        const second = await harness(fakeGh(), home);
        const opened = await second.canvas.open({ instanceId: "c", sessionId: "session-2" });
        const params = new URL(opened.url).searchParams;
        assert.equal(params.get("ready"), "1");
        assert.equal(params.get("issue"), "learner/virtual-universe-26#42");
        assert.equal(params.get("url"), "https://github.com/learner/virtual-universe-26/issues/42");
        await second.canvas.onClose({ instanceId: "c" });
    } finally {
        await first.canvas.onClose({ instanceId: "a" });
    }
});

test("an old GitHub CLI without --attach still gets a readable issue", async () => {
    const gh = fakeGh({ attach: false });
    const { canvas } = await harness(gh);
    const { url } = await canvas.open({ instanceId: "t" });
    try {
        const data = await (await fetch(new URL("start", url), { method: "POST" })).json();
        assert.equal(data.number, 42);
        const body = gh.bodies.get(42);
        assert.doesNotMatch(body, /<img/);
        assert.match(body, /\/create-issue-artifact/);
    } finally {
        await canvas.onClose({ instanceId: "t" });
    }
});

test("start forks for a learner who has none, and reuses an existing issue", async () => {
    const gh = fakeGh({ forks: [], issues: false });
    const { canvas } = await harness(gh);
    const { url } = await canvas.open({ instanceId: "t" });
    try {
        const first = await (await fetch(new URL("start", url), { method: "POST" })).json();
        assert.equal(first.fork, "learner/virtual-universe-26");
        assert.ok(gh.calls.some((a) => a[0] === "repo" && a[1] === "fork"));
        assert.ok(gh.calls.some((a) => a[0] === "repo" && a[1] === "edit"));

        const second = await (await fetch(new URL("start", url), { method: "POST" })).json();
        assert.equal(second.number, first.number);
        assert.equal(gh.calls.filter((a) => a[0] === "issue" && a[1] === "create").length, 1);
    } finally {
        await canvas.onClose({ instanceId: "t" });
    }
});

test("start explains itself when the learner is not signed in", async () => {
    const { canvas } = await harness(fakeGh({ login: null }));
    const { url } = await canvas.open({ instanceId: "t" });
    try {
        const data = await (await fetch(new URL("start", url), { method: "POST" })).json();
        assert.match(data.error, /gh auth login/);
        assert.equal(data.link, undefined);
    } finally {
        await canvas.onClose({ instanceId: "t" });
    }
});
