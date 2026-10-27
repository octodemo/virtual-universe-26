# Universe workshop

## Opening the welcome canvas

When the user asks to open the Universe welcome canvas, open canvasId
`universe-welcome` with instanceId `universe-welcome`. Do this before reading
tutorial files or checking prerequisites. After a successful open, briefly
direct the user to read the canvas and use its guide buttons, then stop.
Do not list the parts, show a chat menu, ask what to try, or begin an exercise.
If the canvas is unavailable, explain that this repository must be trusted and
its extension loaded. Suggest the panel's + menu once the extension is available;
do not claim it opened or silently replace it with a chat walkthrough.

These startup rules apply only to opening the guide. Continue helping normally
when the user sends an exercise or asks a question.

## Working through the guides

- Let learners start in the event repository. Reading guides, finding the skill,
  asking questions, and using the public documentation connector need no fork.
  Do not check account/fork status just to open or browse a guide.
- Keep the current session and canvas. Never offer an "Open in Copilot app" or
  "Switch to your fork" loop, create another session, or navigate away as setup.
- Introduce a fork only at the Skills guide's "Ready to make changes?" step.
  Inspect the checkout, branch, status, and remotes. With approval, reuse or
  create the learner's fork using `gh repo fork octodemo/virtual-universe-26
  --clone=false --default-branch-only`. Verify its parent and the learner's
  access; enable issues with approval. Stop on policy or access errors.
- Keep the current checkout and its existing history and origin. If necessary,
  propose adding a named `workshop-fork` remote for the verified fork; remote
  configuration is shared with other worktrees, so ask before changing it.
  Never overwrite an existing remote without checking its destination. Do not
  clone or reopen an old fork just to continue the exercise.
- Before edits or resource creation, confirm the exact fork target and working
  branch. Target GitHub CLI operations explicitly with `GH_REPO=<owner/repo>` or
  `-R <owner/repo>`, and push explicitly to the verified fork remote. Origin may
  still be the event repository: never push there or infer the target from it.
- A factory is bound to the app project, not merely a Git remote. Before factory
  creation, verify that its resolved project is the learner's fork. If this
  session is still app-bound to the event repository, explain the distinction
  and leave this as a plan for later. Do not silently switch sessions or create
  a factory for the event repository.
- Ask which issue to use when its number is not supplied. Remember the exact
  issue and resulting pull request within this session. Verify them before acting.
- When the learner asks to open the skill, open the existing
  `.github/skills/issue-to-pr/SKILL.md` from this checkout in the editor.
  Do not send them through file-browser menus or create a duplicate skill.
  If it is missing or cannot be opened, explain the actual blocker.
- Explain and obtain approval before installing or connecting a tool, creating
  an issue or pull request, committing/pushing, or creating/enabling a factory.
  Keep initial factory creation paused. Never merge on the learner's behalf.
- Connector discovery is not installation or authorization. Use the learner's
  explicit choice; never install a search result automatically. The core Tools
  exercise uses the public Microsoft Learn MCP server at
  `https://learn.microsoft.com/api/mcp`, which needs no account or API key.
  Send only the public documentation query, not repository files or private data.
  If unavailable, explain the blocker; a web search is not a successful MCP test.
- Check connector tools in the current session after installation. If a restart
  is required, explain it and obtain consent; do not silently start a new session.
- Use synthetic examples. Do not request secrets, assume private-service access,
  discard unrelated changes, or use destructive cleanup commands.

## Section 3 cheat sheet issue

When the learner asks to create the "My GitHub Universe '26 cheat sheet" issue
in their fork, that request is their approval for every step below. These rules
override the fork and issue rules above for this exercise only. Do not ask
questions or confirmations; run the steps. Never open a second session for it —
the whole exercise stays in the session the learner is already in.

1. The learner usually has only the event repository locally, and `origin`
   points at it, so never infer the fork from the checkout. Run
   `gh api user --jq .login`, then find their fork with
   `gh api 'repos/octodemo/virtual-universe-26/forks?per_page=100' --paginate
   --jq '.[] | select(.owner.login=="<login>") | .full_name'`. This also finds
   renamed forks. Do not use `gh repo list`, which can fail on SAML-protected
   organizations.
2. If there is no fork, create one with `gh repo fork
   octodemo/virtual-universe-26 --clone=false --default-branch-only` and use
   the `owner/repo` it reports. Do not clone it or add remotes.
3. If `gh repo view <fork> --json hasIssuesEnabled` is false, run
   `gh repo edit <fork> --enable-issues`.
4. Create the issue with `gh issue create -R <fork> --title "My GitHub Universe
   '26 cheat sheet" --body "<text>" --attach
   "github-virtual-universe-highlights/attach-a-cheat-sheet-artifact/astronaut.png#Copilot astronaut"`,
   where `<text>` is `Run /cheatsheet-artifact in the session where you opened
   the guide.` followed by a line saying Copilot attaches the cheat sheet and
   its working notes as Artifacts and opens the Badge Simulator, which records
   the badge and adds the GIF as a third artifact, and a closing line pointing
   anyone who missed Virtual Universe '26 at
   [octodemo/virtual-universe-26](https://github.com/octodemo/virtual-universe-26).
   Then read the uploaded image URL
   with `gh issue view <n> -R <fork> --json body -q .body`, take the
   `https://github.com/user-attachments/assets/...` link, and rewrite the body
   with `gh api -X PATCH repos/<fork>/issues/<n> -f body=...` so it starts with
   `<img src="<that URL>" alt="Copilot astronaut" width="120" align="right">`, a
   blank line, then `<text>`. Never link the PNG from a branch — it only renders
   once uploaded. If `--attach` is unsupported, keep the text-only body rather
   than a broken image. Never create the issue in `octodemo/virtual-universe-26`.
5. Record the issue so the `/cheatsheet-artifact` skill can find it: write
   `{"fork": "<fork>", "number": <n>, "issueUrl": "<url>"}` to
   `${COPILOT_HOME:-$HOME/.copilot}/cache/universe-cheatsheet-artifact/issue.json`.
6. Reply with the issue URL and tell the learner to run `/cheatsheet-artifact`
   right here. Stop only on access or policy errors, and explain them.
