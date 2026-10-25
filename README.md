# Task Queue tracker for AI coding agents

Your AI coding agent logs its own work as tasks in your Task Queue queue:

- **New work:** the agent opens a task with its own estimate of how long it needs, before it starts.
- **Follow-up prompts on the same work:** these stay on that task as notes, instead of creating new tasks.
- **When the work is finished:** the agent marks the task done, which records the end date and time.

Admins see these tasks like any other work: what was done, when it was done, and how the time compared with the estimate. Overtime reports count the time each task was in progress, from the start the agent records to the end it records at its last reply, so it's the time the work took that counts, not how many prompts were sent. Sessions running at the same time count once.

It installs as a plugin in **Claude Code** and **Codex**, and as an extension in **Gemini CLI**, all from this repository. Other agents follow a rules file.

**What's in this repo:**

| Path | For | What it is |
|------|-----|------------|
| `plugins/task-queue/` | Claude Code, Codex | The plugin: a manifest for each (`.claude-plugin/`, `.codex-plugin/`), their hooks (`hooks/hooks.json`, `hooks/codex-hooks.json`) and the `task-queue` skill, which handles setup. |
| `gemini-extension.json`, `hooks/hooks.json` | Gemini CLI | The extension, at the repository root as Gemini CLI requires. Its hooks run the same tracker. |
| `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json` | Claude Code, Codex | The marketplaces that list the plugin. |
| `plugins/task-queue/skills/task-queue/scripts/tq.mjs` | All | The tracker itself. Node 18 or later, no dependencies. |
| `agent-rules/AGENTS.md` | Other agents (Cursor, Copilot, …) | Rules that make the agent open a task before doing anything else, and mark it done when the work is finished. |

## Before you start

You need four things:

- **A Task Queue server with `POST /my/tasks`.** That's the personal API's "Add a task" endpoint. Your Task Queue's **API docs** page (`/docs`) lists it if it's there.
- **The Take tasks (or Create tasks) permission** in the workspace your tasks should go to. Members have Take tasks by default.
- **A personal API key**, from Task Queue → Profile → API keys.
- **Node 18 or later** on the machine the agent runs on.

## Install

### Claude Code

Inside Claude Code:

```
/plugin marketplace add devops-riku/task-queue-plugin
/plugin install task-queue@task-queue-plugin
```

Installing from the `/plugin` panel loads the plugin into the current session when you close the panel. If you installed it with `claude plugin install` in a terminal, type `/reload-plugins` in your session (or start a new one) to load its hooks.

### Codex

```
codex plugin marketplace add devops-riku/task-queue-plugin
codex plugin add task-queue@task-queue-plugin
```

Then start a new session and open `/hooks`. **Codex skips a plugin's hooks until you review and trust them.** Check that each Task Queue hook runs `tq.mjs ... --host codex` from the plugin folder, then trust them. Codex asks again whenever an update changes them.

### Gemini CLI

```
gemini extensions install https://github.com/devops-riku/task-queue-plugin
```

Then start a new session. **Gemini CLI doesn't let an extension approve commands,** so Gemini asks you before each tracker command (`start`, `done`). Approve them one by one. An "allow always" choice or a policy rule can cover more than the tracker, so check exactly what it allows before using one.

## Set up

Send your next prompt. The tracker notices it isn't set up yet, and the agent asks you for:

1. your Task Queue API URL, e.g. `http://localhost:8000/api/v1`. The Personal API link from your profile works too.
2. your personal API key.

Then it asks:

- which workspace to use, if you're in several;
- which category the tasks go under.

That's the only time it asks. In Claude Code and Codex, the agent never stops to ask permission for the tracker: the plugin approves its own commands. It approves exactly one run of the tracker, with nothing chained, piped or substituted. Any other command goes through the agent's normal permission check.

To keep the key out of the chat, run setup yourself in a terminal. The plugin's hooks keep a copy of the tracker at `~/.task-queue/tq.mjs` (in PowerShell, write `$HOME` instead of `~`):

```
node ~/.task-queue/tq.mjs setup --url http://localhost:8000/api/v1 --key tqk_… --category FEATURE
```

In Claude Code you can also say "set up Task Queue tracking", or run `/task-queue:task-queue setup`.

## How it works

Every prompt you send comes with a short note for the agent. It says whether a task is open, and gives the exact commands to run.

| When | What happens in Task Queue |
|------|----------------------------|
| You ask for new work | The agent runs `start` with a title, a one- or two-sentence description of the work and its estimate. A task is created in your queue and started, in a folder named after your project. Its description is the agent's, followed by your request (unless prompt text is off). |
| You say the work is part of an existing task | The agent adds `--parent <task number>` to `start`, and the new task is filed as a subtask of that task. Adding subtasks needs *Edit tasks* in that workspace, as in the app. When the task can't go there (no *Edit tasks*, that task is a subtask itself or closed, or an older Task Queue), it's filed on its own and `start` says why. |
| You follow up on the same work | Your follow-up is added to the open task as a note |
| You ask for something unrelated | The agent runs `start` for the new work. The previous task is closed at the time the agent last finished replying. |
| The agent finishes the work | The agent runs `done` with a one-line summary. The task is completed with the end date and time. |
| You ask a quick question or say thanks | Nothing |

The agent might not mark a task done. The tracker closes it anyway, at the time the agent last finished replying, and notes that it wasn't marked done. That happens in three cases:

- the conversation sits idle for 60 minutes;
- the conversation ends (exit or `/clear`);
- the terminal was closed and the conversation never ended. The next session you start cleans these up after 12 hours.

Tracking never blocks you, and a lost connection loses nothing. Task Queue might be down, the network might drop, or its proxy might answer 502, 503 or 504. The tracker then keeps the agent's tasks, notes and completions on your machine, in `~/.task-queue/outbox`, and the agent carries on without mentioning it. Each prompt, reply and new session quietly checks whether Task Queue answers again, at most every 30 seconds. Once it does, everything kept is sent in the order it happened. `status` checks at once.

What Task Queue records depends on when the task was opened:

- **Opened before the connection dropped:** notes and the completion arrive later, with their real times.
- **Opened while Task Queue couldn't be reached:** Task Queue can't start a task before it receives it, so the task starts when it arrives. Its real start and end times are written in its notes.

If the key stops working, the agent tells you once and carries on. Changes kept by then wait until the key is fixed. A kept change that Task Queue refuses for good, such as one for a category that was removed, is dropped. The details go to `~/.task-queue/tracker.log`.

## Privacy

- **Your project's name goes to Task Queue** as the folder each task is filed in: the name of the git repository the agent works in, or else of its working folder (never your home folder). Working in `D:\Stars PH`, tasks go to the folder Stars PH, made the first time it's needed. The agent can pass `--folder "<name>"` to file a task elsewhere. Run `set folders off` to keep project names out; tasks then go to the default folder.
- **Your request and your follow-up prompts go to Task Queue, where admins can read them,** along with the agent's titles and summaries. Don't paste secrets into requests while tracking is on. Run `set prompt-text off` to keep your prompts out; titles and summaries are still sent.
- **The tracker checks in with Task Queue** at the start of each session, and when you turn tracking off or on. A check-in says which agent it runs in, the plugin version, whether tracking is on and the workspace it logs to; never prompts or project names. Admins see on the audit log when tracking is connected, paused or resumed, and when a tracker stops checking in for several days (removed, blocked, or simply not used).
- **What Task Queue couldn't receive waits on your machine,** in `~/.task-queue/outbox`, until it's sent. It's the same text that would have been sent.
- **Your settings and key stay on your machine,** in `~/.task-queue/config.json`. Set `TASK_QUEUE_HOME` to keep that folder somewhere else. The key is never printed: `status` shows only its first characters.

## Commands

Ask the agent to run these, or run `node ~/.task-queue/tq.mjs <command>` yourself (in PowerShell, write `$HOME` instead of `~`).

| Command | What it does |
|---------|--------------|
| `setup --url <url> --key <key> [--workspace <id>] [--category <VALUE>]` | Connects and checks the key |
| `status` | Shows your settings, whether Task Queue answers, open tasks, changes waiting to be sent and recent log lines. It sends waiting changes if Task Queue answers. |
| `enable` / `disable` | Turns tracking on or off; your settings are kept |
| `workspaces` | Lists the workspaces you can add tasks to, with their categories |
| `set workspace <id>` / `set category <VALUE>` | Sets where tasks go |
| `set idle <minutes>` | Sets how long a conversation may sit idle before its open task is closed (default 60) |
| `set estimate <minutes>` | Sets the estimate used when `start` is given none (default 30, at most 480) |
| `set prompt-text on\|off` | Sets whether your prompts are sent |
| `set folders on\|off` | Sets whether tasks are filed in a folder named after the project (default on) |
| `start --estimate <minutes> --description "<text>" [--folder "<name>"] [--parent <task number>] "<title>"` / `note "<text>"` / `done "<summary>"` | Opens, notes on or completes a task by hand. Estimates go up to 480 minutes; split longer work into several tasks. `--parent` files the new task as a subtask of an existing task. |

These environment variables override the saved settings: `TASK_QUEUE_URL`, `TASK_QUEUE_API_KEY`, `TASK_QUEUE_WORKSPACE` and `TASK_QUEUE_CATEGORY`.

## Uninstall

1. Remove it from your agent:
   - Claude Code: `/plugin uninstall task-queue@task-queue-plugin`
   - Codex: `codex plugin remove task-queue@task-queue-plugin`
   - Gemini CLI: `gemini extensions uninstall task-queue`
2. Delete the `~/.task-queue` folder.

## Other agents

Agents without these hooks follow `agent-rules/AGENTS.md`. Before doing anything else on new work, the agent opens a task with its estimate. It marks the task done when the work is finished. If it can't open a task, it stops and asks you.

1. Clone this repository.
2. Run setup once:
   `node <clone>/plugins/task-queue/skills/task-queue/scripts/tq.mjs setup --url <url> --key <key> --category <VALUE>`
   This also installs the tracker at `~/.task-queue/tq.mjs`, the path the rules use.
3. Copy `agent-rules/AGENTS.md` into your project, under the file name your agent reads. The table at the end of the file lists them.

Agents that can't run Node can follow the plain-HTTP steps in the same file instead.

## Development

`node tests/hooks.test.mjs` runs the hook tests: the input each agent sends, what each one accepts back, and check-ins against a fake Task Queue. No dependencies. Keep `VERSION` in `tq.mjs` the same as the four manifests (`plugins/task-queue/.claude-plugin/plugin.json`, `plugins/task-queue/.codex-plugin/plugin.json`, `gemini-extension.json` and the marketplace entry in `.claude-plugin/marketplace.json`).
