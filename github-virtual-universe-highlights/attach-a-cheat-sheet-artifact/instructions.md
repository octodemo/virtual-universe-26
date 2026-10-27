# Cheat sheet artifact instructions

Copilot follows this page when a learner runs `/create-issue-artifact` in a
session opened from their cheat sheet issue. Keep it fast: no scripts, no
rendering, no uploads, and no extra reading. Do only these steps.

## Steps

1. Use the issue linked to this session as `<owner/repo>#<number>`. Stop and
   explain if no issue is linked or the repository is
   `octodemo/virtual-universe-26` (the learner needs their own fork).

2. Do this first, so the badge records while you work: open the Badge Simulator
   canvas (`canvasId` `badge-simulator`, `instanceId` `universe-badge`) with
   input `{"app": "universe_congrats", "issue": "<owner/repo>#<number>"}`. It
   records the badge and adds the third artifact itself — don't wait for it,
   check it, or record anything yourself.

3. Create a `generic` issue artifact named `GitHub Universe 2026 cheat sheet`
   whose body is only:

   ```markdown
   ![GitHub Universe 2026 cheat sheet](https://raw.githubusercontent.com/octodemo/virtual-universe-26/main/github-virtual-universe-highlights/attach-a-cheat-sheet-artifact/cheatsheet-preview.png)
   ```

4. Create a `generic` issue artifact named `How Copilot built this` with your
   working notes from this session as short Markdown: the request you were
   given, the steps you took, and what you checked. Keep it under 15 lines.

5. Reply in two sentences: the two artifacts are on the issue, and the Badge
   Simulator is recording their badge right now to add as a third artifact, so
   they should keep its panel in front (**Share** saves the GIF to Downloads).

## Rules

- Work only on the issue linked to this session. Create only these two artifacts;
  the Badge Simulator adds the third one on its own.
- Do not run shell commands, read other files, or edit, commit, or push anything.
- Never close, label, or delete anything.
