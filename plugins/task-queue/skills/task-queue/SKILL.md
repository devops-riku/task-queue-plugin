---
name: task-queue
description: Set up, check, pause or resume Task Queue tracking, which logs your work for the user as tasks in their Task Queue account (you open a task with your own estimate when new work starts, and mark it done when it's finished) so their admins can see AI coding activity. Use when the tracker plugin says it isn't set up, or when the user wants to connect Task Queue, give their API URL or personal API key, choose the workspace or category, stop sending prompt text, turn tracking off or on, or check that it works.
argument-hint: "[login | setup | status | enable | disable]"
---

# Task Queue tracking

Once this is set up, you log your own work in the user's Task Queue queue:

- **New work:** before starting a request that is work (a change, a fix, an investigation, a document), you open a task with your honest estimate of the minutes you need and a one- or two-sentence description of the work. Quick questions and thank-yous get no task.
- **Follow-ups on the same work:** these stay on the open task. The user's follow-up prompts are added to it as notes, and each one resumes the task if it was paused in Task Queue.
- **When the work is finished:** you mark the task done as your last step, which records the end date and time.

Every prompt reminds you whether a task is open, and gives you the exact commands to run. In Claude Code and Codex the plugin approves those tracker commands itself, so they never wait for the user. The plugin also closes tasks you leave open, at the time you last finished replying. That happens when the conversation sits idle past the idle limit (60 minutes), when it ends (exit, `/clear`), or when it's abandoned. Those tasks are noted as not marked done.

Setup and settings use the tracker. In Claude Code, run the bundled copy:

```
node "${CLAUDE_SKILL_DIR}/scripts/tq.mjs" <command>
```

Elsewhere (Codex, Gemini CLI), run `scripts/tq.mjs` next to this file, or the copy the plugin's hooks keep at `~/.task-queue/tq.mjs`. The hooks' setup note gives its full path.

## Setup

Do these in order when tracking isn't set up, or when the user asks to set it up again.

1. **Ask the user for their Task Queue address**, e.g. `https://tasks.example.com` (the API path is added for you; the link from Profile → Connect → Personal API, `…/api/v1/my/tasks`, works too).
2. **Sign in through the browser: run `login --url <address>`.** It prints a code and a link and opens Task Queue in the browser. Tell the user to check that the page shows the same code, pick the workspace their tasks should go to, and approve. The command waits for that (up to 10 minutes; in Claude Code give the command a 10-minute timeout, or run it in the background), then saves an API key of its own on this machine, in `~/.task-queue/config.json`, and puts a copy of the tracker at `~/.task-queue/tq.mjs`, the path your start and done commands use. The key shows under Profile → Connect → API keys, where the user can revoke it. With no browser on this machine, pass `--no-browser` and give the user the printed link to open on another device.

   **With a key instead:** if the user already has a personal API key (Profile → Connect → API keys, made for the workspace their tasks should go to; it starts with `tqk_`), or their Task Queue is too old for `login` (it says so), run `setup --url <address> --key <key>`. If they'd rather keep the key out of the chat, they can type `! node "${CLAUDE_SKILL_DIR}/scripts/tq.mjs" setup --url <url> --key <key>` themselves. Never repeat a key back or write it anywhere else.
3. **If login or setup asks for a workspace** (only an older key, made before keys had a workspace, covers several), show the user the workspaces it listed and ask which one. Then run `set workspace <workspace id>`.
4. **Ask which category the tasks go under.** Offer the values login or setup printed, suggest one that fits coding work (e.g. `FEATURE`), then run `set category <VALUE>`.

To switch to another API key, run `setup --key <new key>` (and `--url` if Task Queue moved). The tasks the old key has open, in every conversation, are closed under the old key first, at the agent's last reply, since the new key can't see them; setup names any it couldn't close. A key changed any other way (by hand, or in an environment variable) leaves those tasks as they are: the agent opens new ones and nothing is sent for the old ones. Pass on any tasks setup says it couldn't close.
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
| `pause` / `resume` | Pauses the open task (its worked time stops while nobody works on it) or resumes it. Run `pause --session <id>` when the user says they're stepping away or asks to pause. Their next prompt resumes it on its own. Needs a Task Queue that can pause tasks; an older one says so. |
| `move [<task number>] "<column>" [--folder "<project>"] [--reason "<why>"]` | Moves a task (the open one when none is named) to a board column by name, as on the board: In Progress starts or resumes it, Blocked needs `--reason`, Done completes it (the reason is the completion note), or one of the project board's own columns. It also moves back: `"In Queue"` puts a task in progress (or in a later column like For QA) back in its assignee's queue, not started (the time so far stays); the pool needs `--reason`. `--folder` files it in another project. Only when the user asks. If it's refused, tell the user the reason it printed (it lists the board's columns for an unknown one). |
| `assign [<task number>] <email\|me\|none> [--reason "<why>"]` | Assigns a task to a member by email, to the user (`me`), or back to the Task Pool (`none`). Only when the user asks. Needs *Assign tasks* in Task Queue, except handing back the user's own task. |
| `show <task number or id>` | Prints a task with its description, comments and files. Run it before working on an existing task the user names. When the task was reassigned to the user it says who had it, who moved it and why: read its comments first, since they say what was done and found before the hand-off. |
| `delete <task number or id>` | Deletes a task in Task Queue, with its notes and files. See below. |

## Deleting a task

Run `delete <task number>` (e.g. `delete TASK-000120`) only when the user asks for that task to be deleted. It can't be undone, so the plugin doesn't approve it: the agent's own permission rules decide, as for any other command. By number, only tasks assigned to the user are found; for anyone else's, give the task's id. Deleting needs *Delete tasks* in the task's workspace, which members don't have by default. When it's refused, tell the user the reason `delete` printed and don't try another way.

## Projects and subprojects

Tasks are filed in a project named after the repository. When the user says the work belongs somewhere else, add `--folder` to `start`: `--folder "<project name>"` for another project, or `--folder "<project name> / <subproject name>"` for a subproject, e.g. `--folder "Platform / API"`. Use the names the user gives: they match ignoring case, and a level that doesn't exist yet is made, so a misspelled one becomes a new project. A single name is always a top-level project, even when a subproject has that name, so give a subproject's whole path. If the path can't be used (more than 4 levels, say), the task is added without it and `start` says why. That isn't a failure: tell the user and carry on.

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
