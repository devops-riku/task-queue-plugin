---
name: task-queue
description: Set up, check, pause or resume Task Queue tracking, which logs every request the user sends as a task in their own Task Queue account (started when they send it, completed when you finish replying) so their admins can see AI coding activity. Use when the tracker plugin says it isn't set up, or when the user wants to connect Task Queue, give their API URL or personal API key, choose the workspace or category for tracked requests, change the estimate, stop sending prompt text, turn tracking off or on, or check that it works.
argument-hint: "[setup | status | enable | disable]"
---

# Task Queue tracking

Once this is set up, the plugin's hooks do the tracking on their own, with no action from you:

- **When the user sends a request**, a task is created in their own Task Queue queue and started at that moment. The task's title is the request's first line, and its description is the full request.
- **When you finish replying**, the task is completed, with your last message as the completion note.
- Slash commands aren't tracked. A request that arrives while the previous one is still open closes the previous one first.

This skill sets the tracking up and manages it. Every command runs the bundled tracker:

```
node "${CLAUDE_SKILL_DIR}/scripts/tq.mjs" <command>
```

## Setup

Follow these steps in order when tracking isn't set up, or when the user asks to set it up again.

1. **Ask the user for two things in one message:**
   - **Their Task Queue API URL**, e.g. `http://localhost:8000/api/v1`. The link from Task Queue's Profile → Personal API (`…/api/v1/my/tasks`) works too.
   - **Their personal API key.** They generate it in Task Queue under Profile → API keys, and it starts with `tqk_`.

   Tell them the key is saved only on this machine, in `~/.task-queue/config.json`. If they'd rather keep it out of the chat, they can run setup themselves by typing:
   `! node "${CLAUDE_SKILL_DIR}/scripts/tq.mjs" setup --url <url> --key <key>`
2. **Run `setup --url <url> --key <key>`.** It checks the key against Task Queue, saves it, and says what's still missing. Never repeat the key back, and never write it anywhere else.
3. **If setup asks for a workspace**, show the user the workspaces it listed and ask which one, then run `set workspace <workspace id>`.
4. **Ask which category tracked requests go under.** Offer the category values setup printed for that workspace, and suggest one that fits coding work, such as `FEATURE`. Then run `set category <VALUE>`.
5. **Mention the two defaults**, and change them only if the user asks:
   - **Estimate:** each request is logged with a 30-minute estimate (`set estimate <minutes>`). Task Queue needs an estimate to start a task. A fixed one skews the overtime reports, so the user should pick a typical length for their requests.
   - **Prompt text:** the request's text and your final reply are sent to Task Queue, where admins can read them. `set prompt-text off` sends a generic title and no text instead.
6. **Run `status`** and tell the user tracking is on. Their next request will show up in their Task Queue queue.

If the user says they don't want tracking, run `disable`. That stops both the tracking and the setup reminder at the start of each session.

## Other commands

| Command | What it does |
|---------|--------------|
| `status` | Settings (the key masked), whether Task Queue answers, open tasks, recent log lines |
| `enable` / `disable` | Turn tracking on or off; settings are kept |
| `workspaces` | Workspaces the account can add tasks to, with their category values |
| `set workspace <id>` / `set category <VALUE>` | Where tracked requests go |
| `set estimate <minutes>` | The estimate each tracked request is logged with |
| `set prompt-text on\|off` | Whether the request text and your final reply are sent |

## When tracking fails

If a hook says it couldn't log a request, tell the user once, in a sentence, and run `status` if they want to look into it. The full log is `~/.task-queue/tracker.log`. These are the usual causes:

| Error | Cause |
|-------|-------|
| `INVALID_API_KEY` | The key was revoked |
| `UNREACHABLE` | The Task Queue server is down or the URL is wrong |
| `FORBIDDEN` | The account lost *Take tasks* in that workspace |
| `VALIDATION_ERROR` naming the category | The category was removed |

Don't retry the tracking by hand, and don't let it stop you from doing the user's request.
