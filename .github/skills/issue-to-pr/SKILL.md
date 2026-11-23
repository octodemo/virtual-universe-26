---
name: issue-to-pr
description: Read an open issue, propose a fix, and open a draft pull request for review. Use when asked to turn an issue into a suggested fix or pull request.
---

# Issue to PR

Turn one open issue into a suggested fix that a person reviews. These are the
same `gh` commands you ran by hand in Section 1.

1. Confirm the learner's fork target and push remote established in this
   session. Inspect `git remote -v`, verify the selected destination with
   `gh repo view <fork-url> --json nameWithOwner,parent`, and confirm ownership or
   write access. Origin may still be the event repository. Use
   `GH_REPO=<verified-owner/repo>` for every GitHub CLI operation and push only to
   the explicitly verified fork remote, never implicitly to origin.
   - If no fork destination is ready, stop before edits or resource creation.
     Offer to prepare it in this same checkout with approval, preserving origin,
     other remotes, and local work. Do not open or switch sessions.
2. Pick the issue. Use the number you were given, or list open issues and ask:
   `gh issue list --state open`
3. Read the issue and the code it mentions: `gh issue view <n>`
4. Create a branch: `git switch -c fix/issue-<n>`
5. Make the smallest change that fixes the issue, and run the project's tests
   if it has any.
6. Run the built-in `/security-review` skill on the issue changes. Fix any HIGH
   or CRITICAL findings, then repeat the review to verify the fixes. Include
   any remaining lower-severity findings in the pull request body. If HIGH or
   CRITICAL findings remain, or the review cannot run, stop before committing
   or opening the pull request and report the blocker.
7. Commit only the files you changed for this issue, push the branch to the
   fork, and open a draft pull request that closes the issue:
   `gh pr create --draft --title "Fix #<n>: <issue title>" --body "<body>"`
   Start the body with "Closes #<n>", then add a short summary, a "How to test"
   section with the exact commands a reviewer can run, and any lower-severity
   security findings.
8. Ask before commenting on the issue with what changed and how to test it.
   Report the exact issue, PR, and branch. Leave this PR branch checked out so
   the learner can review it in the same session; do not switch branches.

## Rules

- Never merge, approve, or close anything. A person reviews the pull request.
- If the fix is unclear, comment on the issue with your questions instead of guessing.
- Stage only the files you changed for this issue.
- When a fix needs current library or API documentation, use the Context7 MCP
  connector: resolve the library ID, then query the relevant documentation.
  Send only public documentation questions; do not send repository code, private
  paths, credentials, or other private project details.
- Cite the relevant documentation URLs in the draft pull request body. If
  Context7 is unavailable or the lookup fails, report that plainly and do not
  claim the documentation was checked. If the lookup is needed to determine the
  fix, pause rather than guessing or silently substituting another source.
