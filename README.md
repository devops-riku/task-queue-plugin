# Task Queue tracker for AI coding agents

This logs every request you give an AI coding agent as a task in your own [Task Queue](https://github.com/devops-riku/task-queue) queue:

- **When you send the request**, a task is created in your queue and started.
- **When the agent finishes replying**, the task is completed, with its final reply as the completion note.

Admins see these tasks like any other work: who did what, when, and for how long.

**What's in this repo:**

| Path | Agent | What it is |
|------|-------|------------|
| `.claude-plugin/`, `hooks/`, `skills/task-queue/` | Claude Code | A plugin. Its hooks track every request on their own, and its `task-queue` skill handles setup. |
| `agent-rules/AGENTS.md` | Every other agent (Codex, Cursor, Gemini CLI, Copilot, …) | Rules that make the agent open a Task Queue task before doing anything else, and close it when it's done. |
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

This repository is private, so you need read access to it on GitHub, and git has to be signed in to GitHub on your machine (for example with `gh auth login`).

### Set up

Start a new session. The plugin notices it isn't set up yet, and Claude asks you for:

1. your Task Queue API URL, e.g. `http://localhost:8000/api/v1`. The Personal API link from your profile works too.
2. your personal API key.

Then Claude asks which workspace (if you're in several) and which category tracked requests go under.

You can also start setup yourself: say "set up Task Queue tracking", or run `/task-queue:task-queue setup`. To keep the key out of the chat, run the script yourself with `!`:

```
! node "<plugin folder>/skills/task-queue/scripts/tq.mjs" setup --url http://localhost:8000/api/v1 --key tqk_… --category FEATURE
```

### What gets logged

Every request you type is logged, except slash commands. For each one:

| Field | Value |
|-------|-------|
| Title | The first line of your request |
| Description | Your full request, plus the project folder and the session id |
| Category | The one you chose |
| Estimate | 30 minutes, unless you change it. Task Queue needs an estimate before a task can start. A fixed estimate skews the overtime reports, so set one close to how long your requests usually take. |
| Started | When you sent the request (the moment Task Queue queued the task) |
| Completed | When Claude finished replying, with its final reply as the completion note |

Some requests don't end with a reply:

- **You send a new request while the last one is still open** (for example after pressing Esc). The open task is completed first.
- **You quit the session.** Anything still open is completed.

Tracking never blocks you. If Task Queue is down or the key stops working, your request goes through as usual. Claude mentions the problem once, and the details go to `~/.task-queue/tracker.log`.

### Privacy

- **The text of your requests and Claude's final replies goes to Task Queue, where admins can read it.** Don't paste secrets into requests while tracking is on. To send a generic title and no text instead, run `set prompt-text off`.
- **Your settings and key stay on your machine**, in `~/.task-queue/config.json`. Set `TASK_QUEUE_HOME` to keep that folder somewhere else. The key is never printed: `status` shows only its first characters.

### Commands

Ask Claude to run these, or run `node <plugin folder>/skills/task-queue/scripts/tq.mjs <command>` yourself.

| Command | What it does |
|---------|--------------|
| `setup --url <url> --key <key> [--workspace <id>] [--category <VALUE>] [--estimate <minutes>]` | Connects and checks the key |
| `status` | Shows your settings, whether Task Queue answers, open tasks and recent log lines |
| `enable` / `disable` | Turns tracking on or off; your settings are kept |
| `workspaces` | Lists the workspaces you can add tasks to, with their categories |
| `set workspace <id>` / `set category <VALUE>` | Sets where tracked requests go |
| `set estimate <minutes>` | Sets the estimate each request is logged with |
| `set prompt-text on\|off` | Sets whether request text and replies are sent |
| `start "<title>"` / `finish ["<note>"]` | Opens or completes a task by hand |

These environment variables override the saved settings: `TASK_QUEUE_URL`, `TASK_QUEUE_API_KEY`, `TASK_QUEUE_WORKSPACE`, `TASK_QUEUE_CATEGORY` and `TASK_QUEUE_ESTIMATE`.

### Uninstall

1. Run `/plugin uninstall task-queue@task-queue-skill`.
2. Delete the `~/.task-queue` folder.

## Other agents

Agents without Claude Code's hooks can't be tracked automatically, so `agent-rules/AGENTS.md` makes tracking a hard rule instead. Before doing anything else on a request, the agent opens and starts a task. When it's done, it completes the task. If it can't open the task, it stops and asks you.

1. Clone this repository.
2. Run setup once:
   `node <clone>/skills/task-queue/scripts/tq.mjs setup --url <url> --key <key> --category <VALUE>`
3. Copy `agent-rules/AGENTS.md` into your project, under the file name your agent reads. The table at the end of the file lists them.
4. In the copy, replace `<path to task-queue-skill>` with the path to your clone.

Agents that can't run Node can follow the plain-HTTP steps in the same file instead.
