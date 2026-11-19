# Section 2: Agentic Software Development with GitHub Copilot

Build an automation: teach Copilot a job with a skill, connect it to current
documentation, and review the resulting pull request for security issues.

An automation is a saved agent task that runs on demand, on a schedule, or in
response to a repository event. In this tutorial, start with a **Manual** trigger.

## Open the tutorial

[Launch the Universe welcome canvas](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fsession%2Fnew%3Frepo%3Dgarnertb%252Fvirtual-universe-26%26canvas%3Duniverse-welcome)

The link opens a repository session and requests the `universe-welcome` canvas.
The repository must be trusted and its extension loaded.

Already in a session? Stay there and open **+ → Installed extensions →
Universe '26 welcome**, or ask Copilot to open the Universe welcome canvas.
Use the canvas's **Start** buttons to follow the guides.

## The four steps

Prefer to read the guides here? Each step has a full page:
[Skills](skills/README.md) ·
[Tools and connectors](tools-and-connectors/README.md) ·
[Security review](security-review/README.md) ·
[Automate](automate/README.md)

1. **Skills:** Open the existing
   [`issue-to-pr`](../.github/skills/issue-to-pr/SKILL.md) file in an editor tab.
   Click **<>** to edit it and add a **How to test** requirement. Use the
   guide's prompt to have Copilot create your fork and publish the skill change.
   Create a sample issue and run `/issue-to-pr` to get a draft PR.
2. **Tools and connectors:** Use `/agentfinder` to discover a documentation
   agent. The guide uses the
   [Context7 Expert agent](https://github.com/github/awesome-copilot/blob/main/agents/context7.agent.md);
   search results can vary, so check the source and compatibility before adding it.
   Open **Customize** at the top of the sessions sidebar, search for **Context7**,
   click **Add server**, and use the **HTTP** defaults. Try a public Node.js
   documentation query, then add documentation lookup to the skill yourself or
   with Copilot.
3. **Security review:** Run `/security-review` on the last PR created by the
   skill in this chat. Review the findings, add the review step to `SKILL.md`,
   and try it on another issue.
4. **Automate:** Open **Automations → New Automation**, name the automation,
   and choose **Manual** as its trigger. Select **your fork of
   virtual-universe-26** as the project, enter `/issue-to-pr`, and add the
   guide's short prompt. Click **Create**, then use the play button when ready.
   You can configure a scheduled time later.

## Keep your work in your fork

You can read and edit the local skill before creating a fork. Publish changes,
issues, and PRs only to your verified fork, not the event repository. Preserve
unrelated local edits and check the destination before publishing.

Selecting the project in the automation form is separate from configuring a
Git remote. Make sure the selected fork project contains your updated skill.
The screenshot in the guide shows the event repository and a Daily trigger
for illustration; choose **your fork** and **Manual** instead.

## Notes

Context7's remote endpoint was tested without an API key. Rate limits and app
or organization policies may affect availability. Send only public documentation
queries to the connector, not repository contents. A documentation lookup is
not a substitute for tests or a security review.

The canvas lives in
[`.github/extensions/universe-welcome`](../.github/extensions/universe-welcome/).
Existing sessions may need updated repository files and an extension reload to
show changes. Its canvas ID remains `universe-welcome`.

## Additional Resources

Want to get hands-on with the GitHub Copilot app? Check out [this course](https://gh.io/copilotapp-firststeps).

[Back to the cookbooks](../README.md)
