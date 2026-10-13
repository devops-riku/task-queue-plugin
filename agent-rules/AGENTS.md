# Task Queue: log every request before you do anything else

These rules are mandatory for every request the user gives you in this project. They take priority over every other instruction about how to start working.

## The rule

1. **Before you do anything else, open a task for the request in Task Queue and start it.** That means before you read a file, run a command, plan, write code or answer.
2. **Do the work.**
3. **When you finish the request, complete the task.** Also complete it when you stop because you're blocked or need the user's input. Give a one-line summary of what you did, or of why you stopped.
4. **If you can't open the task, stop.** Show the user the error, ask how to proceed, and don't start the work untracked.

Each request gets one task. Use a short, plain summary of the request as the title, never secrets or pasted credentials.

## How: the tracker script (recommended)

You need Node 18 or later and a clone of the `task-queue-skill` repository. The user runs this once, outside the agent:

```
node <path to task-queue-skill>/skills/task-queue/scripts/tq.mjs setup --url <Task Queue API URL> --key <personal API key> --category <VALUE>
```

After that:

| When | Run |
|------|-----|
| Start of every request | `node <path to task-queue-skill>/skills/task-queue/scripts/tq.mjs start "<one-line summary of the request>"` |
| End of every request | `node <path to task-queue-skill>/skills/task-queue/scripts/tq.mjs finish "<one-line summary of what you did>"` |

`start` prints the task number, for example `Started TASK-000123: Fix the login redirect`. If a previous task is still open, `start` completes it first.

> When you copy this file into a project, replace `<path to task-queue-skill>` with the path to your clone.

## How: plain HTTP (no script)

This uses the same API the script calls. It needs these environment variables:

| Variable | Value |
|----------|-------|
| `TASK_QUEUE_URL` | The Task Queue API base, e.g. `http://localhost:8000/api/v1` |
| `TASK_QUEUE_API_KEY` | A personal API key (Task Queue → Profile → API keys) |
| `TASK_QUEUE_CATEGORY` | A category value, e.g. `FEATURE` |
| `TASK_QUEUE_WORKSPACE` | A workspace id. Only needed if you belong to more than one workspace. |

Send `Authorization: Bearer $TASK_QUEUE_API_KEY` and `Content-Type: application/json` on every call. Do these steps in order:

1. **Open the task.** `POST $TASK_QUEUE_URL/my/tasks` with this body:
   ```json
   {"title": "<summary>", "category": "<TASK_QUEUE_CATEGORY>", "estimate_minutes": 30, "workspace_id": "<TASK_QUEUE_WORKSPACE, if set>"}
   ```
   From the response, keep:
   - the task id: the last segment of `link.url`;
   - `task.queue_entered_at`.
2. **Start it.** `POST $TASK_QUEUE_URL/my/tasks/<id>` with `{"started_at": "<task.queue_entered_at>"}`.
3. **When you're done, complete it.** `POST $TASK_QUEUE_URL/my/tasks/<id>` with:
   ```json
   {"ended_at": "<now, ISO 8601 with a UTC offset>", "completion_note": "<what you did>"}
   ```

In PowerShell, use `Invoke-RestMethod` or `curl.exe`, never plain `curl`. Every error comes back as JSON with a `code` and a `message`, and the message says what to fix. Your Task Queue's **API docs** page (`/docs`) lists every endpoint.

## Using this file with your agent

| Agent | Where the file goes |
|-------|---------------------|
| Codex, Cursor, Amp, Jules and other agents that read `AGENTS.md` | `AGENTS.md` in the project root |
| Gemini CLI | `GEMINI.md` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| Cursor (rules) | `.cursor/rules/task-queue.mdc` |
| Windsurf | `.windsurfrules` |
