---
name: task-queue
description: Set up, check, pause or resume Task Queue tracking, which logs your work for the user as tasks in their Task Queue account (you open a task with your own estimate when new work starts, and mark it done when it's finished) so their admins can see AI coding activity. Use when the tracker plugin says it isn't set up, or when the user wants to connect Task Queue, give their API URL or personal API key, choose the workspace or category, stop sending prompt text, turn tracking off or on, or check that it works.
argument-hint: "[setup | status | enable | disable]"
---

# Task Queue tracking

Once this is set up, you log your own work in the user's Task Queue queue:

- **New work:** before starting a request that is work (a change, a fix, an investigation, a document), you open a task with your honest estimate of the minutes you need and a one- or two-sentence description of the work. Quick questions and thank-yous get no task.
- **Follow-ups on the same work:** these stay on the open task. The user's follow-up prompts are added to it as notes.
- **When the work is finished:** you mark the task done as your last step, which records the end date and time.

Every prompt reminds you whether a task is open, and gives you the exact commands to run. In Claude Code and Codex the plugin approves those tracker commands itself, so they never wait for the user. The plugin also closes tasks you leave open, at the time you last finished replying. That happens when the conversation sits idle past the idle limit (60 minutes), when it ends (exit, `/clear`), or when it's abandoned. Those tasks are noted as not marked done.

Setup and settings use the tracker. In Claude Code, run the bundled copy:

```
node "${CLAUDE_SKILL_DIR}/scripts/tq.mjs" <command>
```

Elsewhere (Codex, Gemini CLI), run `scripts/tq.mjs` next to this file, or the copy the plugin's hooks keep at `~/.task-queue/tq.mjs`. The hooks' setup note gives its full path.

## Setup

Do these in order when tracking isn't set up, or when the user asks to set it up again.

1. **Ask the user for two things in one message:**
   - Their Task Queue API URL, e.g. `http://localhost:8000/api/v1`. The link from Task Queue's Profile → Personal API (`…/api/v1/my/tasks`) works too.
   - Their personal API key, generated in Task Queue under Profile → API keys. It starts with `tqk_`.

   Tell them the key is saved only on this machine, in `~/.task-queue/config.json`. If they'd rather keep it out of the chat, they can run setup themselves by typing:
   `! node "${CLAUDE_SKILL_DIR}/scripts/tq.mjs" setup --url <url> --key <key>`
2. **Run `setup --url <url> --key <key>`.** It checks the key, saves the settings, and puts a copy of the tracker at `~/.task-queue/tq.mjs`, the path your start and done commands use. Never repeat the key back or write it anywhere else.
3. **If setup asks for a workspace**, show the user the workspaces it listed and ask which one. Then run `set workspace <workspace id>`.
4. **Ask which category the tasks go under.** Offer the values setup printed, suggest one that fits coding work (e.g. `FEATURE`), then run `set category <VALUE>`.
5. **Tell the user what gets sent:** each task's title and estimate, their request as its description, their follow-up prompts as notes, and your summary. Admins can read all of it. `set prompt-text off` keeps the request and follow-ups out.
6. **Run `status`** and tell the user tracking is on. If the plugin was installed during this conversation and no Task Queue note came with the user's prompts, its hooks aren't loaded yet: tell the user to type `/reload-plugins` so tracking starts in this session instead of the next one.

If the user says they don't want tracking, run `disable`. That stops the tracking and the setup reminder at the start of each session.

## Other commands

| Command | What it does |
|---------|--------------|
| `status` | Settings (key masked), whether Task Queue answers, open tasks, changes waiting to be sent, recent log lines. Sends waiting changes if Task Queue answers. |
| `enable` / `disable` | Turn tracking on or off; settings are kept |
| `workspaces` | Workspaces the account can add tasks to, with their category values |
| `set workspace <id>` / `set category <VALUE>` | Where tasks go |
| `set idle <minutes>` | How long a conversation may sit idle before its open task is closed (default 60) |
| `set estimate <minutes>` | The estimate used when `start` is given none (default 30, at most 480) |
| `set prompt-text on\|off` | Whether the request and follow-up prompts are sent |
| `set folders on\|off` | Whether tasks are filed in a folder named after the project (default on) |
## Subtasks

When the user says the work is part of an existing Task Queue task (e.g. TASK-000120), add `--parent TASK-000120` to `start`. The new task is filed as a subtask of that task, and `start` says so. Adding subtasks needs *Edit tasks* in that workspace, as in the app. If the task can't go there (no *Edit tasks*, that task is a subtask itself, closed or cancelled, or the Task Queue is older), it's filed on its own and `start` says why. That isn't a failure: carry on.

## When Task Queue can't be reached

`start`, `note` and `done` don't fail when Task Queue is down or the network drops. They print `Saved … on this machine` instead. The tracker keeps the change in `~/.task-queue/outbox` and sends it, with everything else kept, once Task Queue answers again. The hooks check quietly on every prompt and reply. That isn't a failure: don't mention it to the user, don't retry, carry on. `status` shows what's waiting and sends it if Task Queue answers.

## When tracking fails

If `start` or `done` fails, tell the user once, in a sentence, and carry on with their request. Don't retry the tracking by hand. `status` and `~/.task-queue/tracker.log` show what went wrong. These are the usual causes:

| Error | Cause |
|-------|-------|
| `INVALID_API_KEY` | The key was revoked |
| `USER_INACTIVE` | The account was disabled |
| `FORBIDDEN` | The account lost *Take tasks* in that workspace |
| `VALIDATION_ERROR` naming the category | The category was removed |

`status` reports `UNREACHABLE` when Task Queue is down or the URL is wrong. Changes made meanwhile are kept, so check the URL only if it stays that way.
