# Task Queue tracker for AI coding agents

Your AI coding agent logs its own work as tasks in your Task Queue queue:

- **New work:** the agent opens a task with its own estimate of how long it needs, before it starts.
- **Follow-up prompts on the same work:** these stay on that task as notes, instead of creating new tasks.
- **When the work is finished:** the agent marks the task done, which records the end date and time.

Admins see these tasks like any other work: what was done, when it was done, and how the time compared with the estimate. Overtime reports add up those estimates, so it's how much work there was that counts, not how many prompts were sent.

**What's in this repo:**

| Path | For | What it is |
|------|-----|------------|
| `.claude-plugin/`, `hooks/`, `skills/task-queue/` | Claude Code | A plugin. Its hooks brief Claude on every prompt and close anything left open; its `task-queue` skill handles setup. |
| `agent-rules/AGENTS.md` | Every other agent (Codex, Cursor, Gemini CLI, Copilot, …) | Rules that make the agent open a task before doing anything else, and mark it done when the work is finished. |
| `skills/task-queue/scripts/tq.mjs` | Both | The tracker itself. Node 18 or later, no dependencies. |

## Before you start

You need three things:

- **A Task Queue server with `POST /my/tasks`.** That's the personal API's "Add a task" endpoint. Your Task Queue's **API docs** page (`/docs`) lists it if it's there.
- **The Take tasks (or Create tasks) permission** in the workspace your tasks should go to. Members have Take tasks by default.
- **A personal API key**, from Task Queue → Profile → API keys.

## Claude Code

### Install

Inside Claude Code:

```
/plugin marketplace add devops-riku/task-queue-skill
/plugin install task-queue@task-queue-skill
```

### Set up

Start a new session. The plugin notices it isn't set up yet, and Claude asks you for:

1. your Task Queue API URL, e.g. `http://localhost:8000/api/v1`. The Personal API link from your profile works too.
2. your personal API key.

Then Claude asks:

- which workspace to use, if you're in several;
- which category the tasks go under.

That's the only time it asks. Once the plugin is enabled, Claude never stops to ask permission for the tracker: the plugin approves its own commands. It approves exactly one run of the tracker, with nothing chained, piped or substituted. Any other command goes through Claude Code's normal permission check.

You can also start setup yourself: say "set up Task Queue tracking", or run `/task-queue:task-queue setup`. To keep the key out of the chat, run the script yourself with `!`:

```
! node "<plugin folder>/skills/task-queue/scripts/tq.mjs" setup --url http://localhost:8000/api/v1 --key tqk_… --category FEATURE
```

### How it works

Every prompt you send comes with a short note for Claude. It says whether a task is open, and gives the exact commands to run.

| When | What happens in Task Queue |
|------|----------------------------|
| You ask for new work | Claude runs `start` with a title and its estimate. A task is created in your queue and started. Your request is its description. |
| You follow up on the same work | Your follow-up is added to the open task as a note |
| You ask for something unrelated | Claude runs `start` for the new work. The previous task is closed at the time Claude last finished replying. |
| Claude finishes the work | Claude runs `done` with a one-line summary. The task is completed with the end date and time. |
| You ask a quick question or say thanks | Nothing |

Claude might not mark a task done. The plugin closes it anyway, at the time Claude last finished replying, and notes that it wasn't marked done. That happens in three cases:

- the conversation sits idle for 60 minutes;
- the conversation ends (exit or `/clear`);
- the terminal was closed and the conversation never ended. The next session you start cleans these up after 12 hours.

Tracking never blocks you. If Task Queue is down or the key stops working, Claude tells you once and carries on. The details go to `~/.task-queue/tracker.log`.

### Privacy

- **Your request and your follow-up prompts go to Task Queue, where admins can read them,** along with Claude's titles and summaries. Don't paste secrets into requests while tracking is on. Run `set prompt-text off` to keep your prompts out; titles and summaries are still sent.
- **Your settings and key stay on your machine,** in `~/.task-queue/config.json`. Set `TASK_QUEUE_HOME` to keep that folder somewhere else. The key is never printed: `status` shows only its first characters.

### Commands

Ask Claude to run these, or run `node ~/.task-queue/tq.mjs <command>` yourself (in PowerShell, write `$HOME` instead of `~`).

| Command | What it does |
|---------|--------------|
| `setup --url <url> --key <key> [--workspace <id>] [--category <VALUE>]` | Connects and checks the key |
| `status` | Shows your settings, whether Task Queue answers, open tasks and recent log lines |
| `enable` / `disable` | Turns tracking on or off; your settings are kept |
| `workspaces` | Lists the workspaces you can add tasks to, with their categories |
| `set workspace <id>` / `set category <VALUE>` | Sets where tasks go |
| `set idle <minutes>` | Sets how long a conversation may sit idle before its open task is closed (default 60) |
| `set estimate <minutes>` | Sets the estimate used when `start` is given none (default 30) |
| `set prompt-text on\|off` | Sets whether your prompts are sent |
| `start --estimate <minutes> "<title>"` / `note "<text>"` / `done "<summary>"` | Opens, notes on or completes a task by hand |

These environment variables override the saved settings: `TASK_QUEUE_URL`, `TASK_QUEUE_API_KEY`, `TASK_QUEUE_WORKSPACE` and `TASK_QUEUE_CATEGORY`.

### Uninstall

1. Run `/plugin uninstall task-queue@task-queue-skill`.
2. Delete the `~/.task-queue` folder.

## Other agents

Agents without Claude Code's hooks follow `agent-rules/AGENTS.md`. Before doing anything else on new work, the agent opens a task with its estimate. It marks the task done when the work is finished. If it can't open a task, it stops and asks you.

1. Clone this repository.
2. Run setup once:
   `node <clone>/skills/task-queue/scripts/tq.mjs setup --url <url> --key <key> --category <VALUE>`
   This also installs the tracker at `~/.task-queue/tq.mjs`, the path the rules use.
3. Copy `agent-rules/AGENTS.md` into your project, under the file name your agent reads. The table at the end of the file lists them.

Agents that can't run Node can follow the plain-HTTP steps in the same file instead.
