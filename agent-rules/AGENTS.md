# Task Queue: log your work before you do anything else

These rules are mandatory for every request the user gives you in this project. They come before every other instruction about how to start working.

## The rule

1. **New work gets a task before anything else.** When a request is work (a change, a fix, an investigation, a document), open a Task Queue task for it before you read a file, run a command, plan or write code. Give it your honest estimate of the minutes you need to finish.
2. **Follow-ups stay on the open task.** If the next request continues the same work, don't open a new task. You may add a note to the open one.
3. **New, unrelated work gets a new task.** Opening it closes the previous one.
4. **Mark the task done when the work is finished.** Do it as your last step: it records the end date and time. Don't mark it done when you're only stopping to ask the user something.
5. **Quick questions and thank-yous get no task.**
6. **If you can't open a task, stop.** Show the user the error and ask how to proceed. Don't start the work untracked. With the tracker script, a task saved on this machine because Task Queue can't be reached counts as opened.

Use a short, plain summary of the work as the title. Never put secrets or pasted credentials in a title or note.

## How: the tracker script (recommended)

You need Node 18 or later. The user sets it up once, outside the agent, from a clone of the `task-queue-plugin` repository:

```
node <clone>/plugins/task-queue/skills/task-queue/scripts/tq.mjs setup --url <Task Queue API URL> --key <personal API key> --category <VALUE>
```

Setup puts the tracker at `~/.task-queue/tq.mjs`. To switch to another API key, run setup again with it. The tasks the old key has open, in every conversation, are closed under the old key first, at the agent's last reply, since the new key can't see them; setup names any it couldn't close. A key changed any other way (by hand, or in an environment variable) leaves those tasks as they are: the agent opens new ones and nothing is sent for the old ones.

After that, these are your commands:

| When | Run |
|------|-----|
| New work, before anything else | `node ~/.task-queue/tq.mjs start --estimate <minutes> --description "<what the work is, in one or two sentences>" --folder "<project name>" "<short title>"` |
| New work that's part of an existing task | Add `--parent <its task number>` to `start`, e.g. `--parent TASK-000120`, to file it as a subtask of that task |
| A note on the open task (optional) | `node ~/.task-queue/tq.mjs note "<text>"` |
| The work is finished, as your last step | `node ~/.task-queue/tq.mjs done "<one-line summary of what you did>"` |
| The user asks you to delete a task | `node ~/.task-queue/tq.mjs delete <task number>`. Only then: it can't be undone, and it needs *Delete tasks* in that workspace |

In Windows PowerShell, write `$HOME` instead of `~`, e.g. `node $HOME/.task-queue/tq.mjs start --estimate 20 --description "Sign-in sends people back to the home page instead of the page they asked for." "Fix the login redirect"`.

`start` prints the task number, e.g. `Started TASK-000123: Fix the login redirect (estimate 20 minutes).` `done` prints when the task ended and how long it took against your estimate.

With `--parent`, `start` says whose subtask the task is. Adding subtasks needs *Edit tasks* in that workspace. If the task can't go under that one, it's filed on its own and `start` says why; that still counts as opened.

If Task Queue can't be reached, `start`, `note` and `done` print `Saved … on this machine` instead. The tracker keeps the change and sends it once Task Queue answers again; your next tracker command checks. That counts as done: carry on without mentioning it.

## How: plain HTTP (no script)

This uses the same API the script calls. It needs these environment variables:

| Variable | Value |
|----------|-------|
| `TASK_QUEUE_URL` | The Task Queue API base, e.g. `http://localhost:8000/api/v1` |
| `TASK_QUEUE_API_KEY` | A personal API key (Task Queue → Profile → API keys), made for the workspace your tasks go to |
| `TASK_QUEUE_CATEGORY` | A category value, e.g. `FEATURE` |
| `TASK_QUEUE_WORKSPACE` | A workspace id. Only needed with an older key, made before keys had a workspace, when you belong to more than one. |

Send `Authorization: Bearer $TASK_QUEUE_API_KEY` and `Content-Type: application/json` on every call.

1. **Open the task.** `POST $TASK_QUEUE_URL/my/tasks` with this body:
   ```json
   {"title": "<short title>", "description": "<what the work is, in one or two sentences>", "folder": "<project name>", "category": "<TASK_QUEUE_CATEGORY>", "estimate_minutes": <your estimate>, "workspace_id": "<TASK_QUEUE_WORKSPACE, if set>"}
   ```
   To file it as a subtask of an existing task, add `"parent": "<its task number, e.g. TASK-000120>"`. That needs *Edit tasks* in the workspace; if it's refused (403, 404, or 409 `SUBTASK_DEPTH`, `TASK_CLOSED`, `INVALID_TRANSITION`, or 422 `TOO_MANY_SUBTASKS`), send it again without `parent`.

   From the response, keep:
   - the task id, the last segment of `link.url`;
   - `task.queue_entered_at`.
2. **Start it.** `POST $TASK_QUEUE_URL/my/tasks/<id>` with:
   ```json
   {"started_at": "<task.queue_entered_at>"}
   ```
3. **Optional note.** `POST $TASK_QUEUE_URL/my/tasks/<id>` with:
   ```json
   {"comment": "<text>"}
   ```
4. **Mark it done.** `POST $TASK_QUEUE_URL/my/tasks/<id>` with:
   ```json
   {"ended_at": "<now, ISO 8601 with a UTC offset>", "completion_note": "<what you did>"}
   ```

Only when the user asks you to delete a task: `DELETE $TASK_QUEUE_URL/my/tasks/<id>`. It answers 204, and can't be undone. It needs *Delete tasks* in the task's workspace (403 otherwise).

In PowerShell, use `Invoke-RestMethod` or `curl.exe`, never plain `curl`. Every error comes back as JSON with a `code` and a `message`, and the message says what to fix. Your Task Queue's **API docs** page (`/docs`) lists every endpoint.

## Using this file with your agent

Claude Code, Codex and Gemini CLI don't need this file: install the plugin or extension from this repository instead (see the README). Its hooks do the same, and close tasks the agent leaves open.

| Agent | Where the file goes |
|-------|---------------------|
| Cursor, Amp, Jules and other agents that read `AGENTS.md` | `AGENTS.md` in the project root |
| GitHub Copilot | `.github/copilot-instructions.md` |
| Cursor (rules) | `.cursor/rules/task-queue.mdc` |
| Windsurf | `.windsurfrules` |
