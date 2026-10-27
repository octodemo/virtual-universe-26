// Section 3 final exercise: "Attach a cheat sheet artifact".
//
// The canvas does the setup itself so the learner never waits on a chat turn.
// Opening it runs the GitHub CLI here in the extension to find or create the
// learner's fork, turn issues on, and open the cheat sheet issue. It records
// the issue in a state file that the /cheatsheet-artifact skill reads, so the
// learner runs that skill in this same session.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const UPSTREAM = "octodemo/virtual-universe-26";
const TITLE = "My GitHub Universe '26 cheat sheet";
const BODY = `Run \`/cheatsheet-artifact\` in the session where you opened the guide.

Copilot attaches your Universe '26 cheat sheet and its working notes here as
**Artifacts**. It also opens the **Badge Simulator**, which records your
Universe badge and adds the GIF as a third artifact. \u2728

Didn't make it to GitHub Virtual Universe '26? Work through the whole workshop
at [${UPSTREAM}](https://github.com/${UPSTREAM}).`;
const astronautImg = (url) => `<img src="${url}" alt="Copilot astronaut" width="120" align="right">`;
// Issue artifacts have a REST API, so nothing here needs a session linked to the
// issue: the /cheatsheet-artifact skill reads this state file and posts to
// repos/<fork>/issues/<n>/artifacts. That keeps the whole exercise in the one
// session the learner already approved - no deep link, no second session, and
// the guide stays in front the whole time.
const CANVAS_ID = "universe-cheatsheet-artifact";
const STATE = join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "cache", "universe-cheatsheet-artifact", "issue.json");

async function readState() {
    try {
        return JSON.parse(await readFile(STATE, "utf8"));
    } catch {
        return null;
    }
}

async function writeState(state) {
    try {
        await mkdir(join(STATE, ".."), { recursive: true });
        await writeFile(STATE, JSON.stringify(state));
    } catch {
        // A guide that can't remember the issue just shows step 1 again.
    }
}

const tutorial = "../../../github-virtual-universe-highlights/attach-a-cheat-sheet-artifact/";
const files = {
    "/": ["cheatsheet.html", "text/html; charset=utf-8"],
    "/preview.png": [`${tutorial}cheatsheet-preview.png`, "image/png"],
    "/astronaut.png": [`${tutorial}astronaut.png`, "image/png"],
};
const servers = new Map();
let session;

function gh(args, timeout = 20000) {
    return new Promise((resolve) => {
        execFile("gh", args, { timeout }, (err, stdout) => resolve(err ? null : stdout.trim()));
    });
}

async function findFork(login) {
    const forks = await gh(["api", `repos/${UPSTREAM}/forks?per_page=100`, "--paginate", "-q", `.[] | select(.owner.login == "${login}") | .full_name`]);
    if (forks) return forks.split("\n")[0];
    // Covers a fork that was renamed away from the upstream name.
    return (await gh(["api", `repos/${login}/virtual-universe-26`, "-q", "select(.fork) | .full_name"])) || null;
}

// Reuses an open issue with the same title so repeat clicks don't pile up issues.
async function findIssue(fork) {
    const list = await gh(["issue", "list", "-R", fork, "--state", "open", "--limit", "30", "--json", "number,title"]);
    if (!list) return null;
    try {
        return JSON.parse(list).find((i) => i.title === TITLE)?.number ?? null;
    } catch {
        return null;
    }
}

// Uploads the astronaut with the issue so the image is hosted by GitHub rather
// than linked from a branch, then rewrites the body to place it beside the text.
// Falls back to a plain text body rather than leaving a broken image behind.
async function createIssue(fork) {
    const astronaut = fileURLToPath(new URL(`${tutorial}astronaut.png`, import.meta.url));
    const create = ["issue", "create", "-R", fork, "--title", TITLE, "--body", BODY];
    let url = await gh([...create, "--attach", `${astronaut}#Copilot astronaut`], 60000);
    let attached = Boolean(url);
    if (!url) url = await gh(create, 30000);
    const number = url ? Number(url.split("/").pop()) : null;
    if (!number) return null;

    if (attached) {
        const body = await gh(["issue", "view", String(number), "-R", fork, "--json", "body", "-q", ".body"]);
        const hosted = body?.match(/https:\/\/github\.com\/user-attachments\/assets\/[\w-]+/)?.[0];
        if (hosted) await gh(["api", "-X", "PATCH", `repos/${fork}/issues/${number}`, "-f", `body=${astronautImg(hosted)}\n\n${BODY}`]);
    }
    return number;
}

let starting = null;
function start() {
    starting ??= (async () => {
        const login = await gh(["api", "user", "-q", ".login"]);
        if (!login) return { error: "Sign in to the GitHub CLI with gh auth login, then try again." };

        let fork = await findFork(login);
        if (!fork) {
            await gh(["repo", "fork", UPSTREAM, "--clone=false", "--default-branch-only"], 60000);
            for (let i = 0; i < 15 && !fork; i++) {
                await new Promise((r) => setTimeout(r, 2000));
                fork = await findFork(login);
            }
            if (!fork) return { error: "GitHub didn't create your fork. Fork octodemo/virtual-universe-26 on GitHub, then try again." };
        }
        if (fork === UPSTREAM) return { error: "That's the workshop repository, not a fork. Fork octodemo/virtual-universe-26 first." };

        if ((await gh(["api", `repos/${fork}`, "-q", ".has_issues"])) !== "true") {
            await gh(["repo", "edit", fork, "--enable-issues"]);
        }

        let number = await findIssue(fork);
        if (!number) {
            number = await createIssue(fork);
            if (!number) return { error: `Couldn't create the issue in ${fork}. Check that issues are enabled there.` };
        }
        const result = { fork, number, issueUrl: `https://github.com/${fork}/issues/${number}` };
        await writeState(result);
        return result;
    })().finally(() => { starting = null; });
    return starting;
}

async function startServer() {
    const server = createServer(async (req, res) => {
        if (req.method === "POST" && req.url === "/start") {
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            try {
                return res.end(JSON.stringify(await start()));
            } catch (error) {
                console.error("Could not set up the cheat sheet issue:", error);
                res.statusCode = 500;
                return res.end(JSON.stringify({ error: "Something went wrong setting up the issue. Try again." }));
            }
        }
        const entry = files[req.url.split("?")[0]];
        if (!entry) {
            res.statusCode = 404;
            return res.end();
        }
        res.setHeader("Content-Type", entry[1]);
        res.end(await readFile(new URL(`./${entry[0]}`, import.meta.url)));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

session = await joinSession({
    canvases: [
        createCanvas({
            id: CANVAS_ID,
            displayName: "Universe '26 cheat sheet artifact",
            description: "Short Section 3 guide: your cheat sheet issue is created in your fork, then you run the /cheatsheet-artifact skill to attach the cheat sheet and Copilot's notes, and Share a surprise badge GIF from the Badge Simulator.",
            inputSchema: { type: "object", properties: {} },
            actions: [],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer();
                    servers.set(ctx.instanceId, entry);
                }
                // A session that already made the issue reopens straight on it,
                // so the learner never repeats setup.
                const state = await readState();
                const q = state ? `?issue=${encodeURIComponent(`${state.fork}#${state.number}`)}&url=${encodeURIComponent(state.issueUrl)}` : "";
                return { title: "Attach a cheat sheet artifact", url: `${entry.url}${q}` };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});
