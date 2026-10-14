#!/usr/bin/env node
/**
 * Task Queue tracker: the AI coding agent logs its own work as tasks in your Task Queue queue, so admins
 * can see it. When a request is new work, the agent opens a task with its own estimate of how long it
 * needs (`start`), and when the work is finished it completes the task with the end date and time
 * (`done`). Follow-up prompts on the same work are added to the open task as notes.
 *
 * In Claude Code the plugin's hooks keep the agent informed (every prompt says whether a task is open and
 * what to run) and close what it leaves open: a conversation idle past the idle limit, one that ends
 * (exit, /clear), or one abandoned without ending, at the time the agent last finished replying.
 *
 *   setup --url <api url> --key <api key> [--workspace <id>] [--category <VALUE>]
 *   set <workspace|category|estimate|idle|prompt-text> <value>
 *   workspaces | status | enable | disable
 *   start [--session <id>] --estimate <minutes> "<title>"   Open and start a task.
 *   note [--session <id>] "<text>"                           Add a note to the open task.
 *   done [--session <id>] "<summary>"                        Complete it now (alias: finish).
 *   hook <prompt|stop|session-start|session-end|approve>     Hook entry points: JSON on stdin, never fail.
 *
 * Once the plugin is enabled the agent never has to ask before running the tracker: a PreToolUse hook
 * approves exactly one run of it, with nothing chained, piped, redirected or substituted.
 *
 * Settings live in ~/.task-queue/config.json (TASK_QUEUE_HOME moves the folder), with a copy of this script
 * at ~/.task-queue/tq.mjs so the commands have a stable path. The environment variables TASK_QUEUE_URL,
 * TASK_QUEUE_API_KEY, TASK_QUEUE_WORKSPACE and TASK_QUEUE_CATEGORY override the settings. No dependencies:
 * Node 18 or later.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = process.env.TASK_QUEUE_HOME || path.join(os.homedir(), '.task-queue');
const CONFIG = path.join(HOME, 'config.json');
const SESSIONS = path.join(HOME, 'sessions');
const LOG = path.join(HOME, 'tracker.log');
const STABLE = path.join(HOME, 'tq.mjs');
const TIMEOUT_MS = 5000;
// Used when `start` is given no estimate.
const DEFAULT_ESTIMATE = 30;
// The longest estimate the tracker sends (8 hours); longer work is split into several tasks. This only guards
// against casually inflated estimates: the Task Queue server must enforce its own limit.
const MAX_ESTIMATE = 8 * 60;
// Minutes a conversation may sit idle with a task open; the next prompt after that closes it.
const DEFAULT_IDLE = 60;
// Conversations that never ended properly (a closed terminal) are closed by the next session after this.
const ABANDONED_MS = 12 * 60 * 60 * 1000;
const TITLE_MAX = 200;
const PROMPT_MAX = 19000; // the description takes 20,000 characters; the rest is the footer
const COMMENT_MAX = 5000;
const NOTE_MAX = 4000;
const MANUAL = 'manual';

/** How the agent runs this tracker: the stable copy, quoted only when the path needs it. */
const STABLE_POSIX = STABLE.replace(/\\/g, '/');
const COMMAND = /\s/.test(STABLE_POSIX) ? `node "${STABLE_POSIX}"` : `node ${STABLE_POSIX}`;

// ------------------------------------------------------------------ files

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data, { secret = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: secret ? 0o600 : 0o644 });
  if (secret) {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows keeps files in the user profile private already.
    }
  }
}

function log(event, message) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 256 * 1024) {
      fs.writeFileSync(LOG, fs.readFileSync(LOG, 'utf8').slice(-128 * 1024));
    }
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${event} ${message}\n`);
  } catch {
    // Logging must never break the agent.
  }
}

/** Keeps ~/.task-queue/tq.mjs the same as this script, so the agent's commands survive plugin updates. */
function syncStableCopy() {
  try {
    const self = fileURLToPath(import.meta.url);
    if (path.resolve(self) === path.resolve(STABLE)) return;
    const code = fs.readFileSync(self);
    if (fs.existsSync(STABLE) && fs.readFileSync(STABLE).equals(code)) return;
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(STABLE, code);
  } catch (err) {
    log('sync', `failed: ${err.message}`);
  }
}

/** This tracker's paths, as compared: the stable copy and the plugin's own (setup and status run from it). */
const TRACKERS = [STABLE, fileURLToPath(import.meta.url)].map((p) => path.resolve(p).replace(/\\/g, '/').toLowerCase());

/** Whether a shell command (Bash or PowerShell) is exactly one run of this tracker: `node <tracker> <args>`,
 * with nothing chained, piped, redirected, substituted or escaped, so approving it can't approve anything else.
 * Anything doubtful returns false and goes through Claude Code's normal permission check instead. */
function isTrackerCommand(command) {
  const tokens = [];
  let token = null;
  let quote = null;
  for (const ch of String(command ?? '').trim()) {
    // Never inside or outside quotes: newlines, escapes, and $ or backtick substitution (both shells).
    if ('\r\n\\`$'.includes(ch)) return false;
    if (quote) {
      if (ch === quote) quote = null;
      else token += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      token ??= '';
    } else if (/\s/.test(ch)) {
      if (token !== null) tokens.push(token);
      token = null;
    } else if (';&|<>(){}'.includes(ch)) {
      return false; // chaining, pipes, redirects, subshells and PowerShell's (…) arguments
    } else {
      token = (token ?? '') + ch;
    }
  }
  if (quote) return false;
  if (token !== null) tokens.push(token);
  if (!/^node(\.exe)?$/i.test(tokens[0] ?? '') || !tokens[1]) return false;
  const target = path.resolve(tokens[1].replace(/^~(?=\/)/, os.homedir())).replace(/\\/g, '/').toLowerCase();
  return TRACKERS.includes(target);
}

const stateFile = (session) => path.join(SESSIONS, `${String(session).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);

/** One conversation's state: its open task (if any), its pending prompt, and when it was last active. */
const readState = (session) => readJson(stateFile(session)) ?? {};
const writeState = (session, state) => writeJson(stateFile(session), state);

// ------------------------------------------------------------------ settings

/** The API base (…/api/v1) from whatever the user pasted: the base, the /my/tasks link, or the bare server. */
function normalizeUrl(raw) {
  let url = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) throw new Error(`"${raw}" isn't a URL. It should look like http://localhost:8000/api/v1.`);
  url = url.replace(/\/my\/tasks(\/.*)?$/i, '');
  const at = url.toLowerCase().indexOf('/api/v1');
  return at >= 0 ? url.slice(0, at + '/api/v1'.length) : `${url}/api/v1`;
}

function loadSettings() {
  const file = readJson(CONFIG) ?? {};
  const env = process.env;
  return {
    file,
    url: env.TASK_QUEUE_URL ? normalizeUrl(env.TASK_QUEUE_URL) : file.url,
    key: env.TASK_QUEUE_API_KEY || file.key,
    workspace: env.TASK_QUEUE_WORKSPACE || file.workspace || null,
    category: env.TASK_QUEUE_CATEGORY || file.category || null,
    estimate: Math.min(Number(file.estimate || DEFAULT_ESTIMATE), MAX_ESTIMATE),
    idle: Number(file.idle || DEFAULT_IDLE),
    promptText: file.promptText ?? true,
    // Off only when the user turned it off; environment-only setups count as on.
    enabled: file.enabled ?? true,
  };
}

const connected = (s) => Boolean(s.url && s.key);
const ready = (s) => connected(s) && Boolean(s.category);
const maskKey = (key) => (key ? `${key.slice(0, 8)}…` : 'not set');

function saveSettings(changes) {
  const next = { ...(readJson(CONFIG) ?? {}), ...changes };
  for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
  writeJson(CONFIG, next, { secret: true });
  return loadSettings();
}

// ------------------------------------------------------------------ the API

class ApiError extends Error {
  constructor(status, code, message, serverTime) {
    super(message);
    this.status = status;
    this.code = code;
    this.serverTime = serverTime;
  }
}

async function api(s, method, route, body) {
  let res;
  try {
    res = await fetch(s.url + route, {
      method,
      headers: { Authorization: `Bearer ${s.key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiError(0, 'UNREACHABLE', `Task Queue at ${s.url} didn't answer (${err.cause?.code ?? err.name}).`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: reported below.
  }
  if (!res.ok) {
    const details = Array.isArray(data?.details)
      ? `: ${data.details.map((d) => `${(d.loc ?? []).slice(-1)[0] ?? 'body'} ${d.msg}`).join('; ')}`
      : '';
    throw new ApiError(res.status, data?.code ?? `HTTP_${res.status}`, `${data?.message ?? text.slice(0, 200)}${details}`, res.headers.get('date'));
  }
  return data;
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The later of two instants, as the string to send (ended_at can't be before started_at). */
function notBefore(at, floor) {
  const a = Date.parse(at);
  const f = Date.parse(floor);
  return Number.isNaN(f) || a >= f ? new Date(a).toISOString() : floor;
}

/** The note for a task the agent never marked done: why it was closed, and the agent's last reply. */
const unfinished = (state, why) => `Not marked done: ${why}${state.lastReply ? `\n\nLast reply: ${state.lastReply}` : ''}`;

const lastActive = (state) => Date.parse(state.lastActivity ?? state.task?.startedAt ?? 0);
const minutes = (from, to) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
const when = (iso) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Creates a task in the user's own queue with the agent's estimate and starts it at once. */
async function openTask(s, session, { title, estimate, description }) {
  const state = readState(session);
  if (state.task) await closeTask(s, session, unfinished(state, 'closed when new work started.'), state.lastStop);
  const body = { title: clip(title, TITLE_MAX), category: s.category, estimate_minutes: estimate };
  if (s.workspace) body.workspace_id = s.workspace;
  if (description) body.description = description;
  const doc = await api(s, 'POST', '/my/tasks', body);
  // The id, not link.url: that carries the server's public address, which may differ from the configured one.
  const id = doc.link.url.split('/').pop();
  const startedAt = doc.task.queue_entered_at;
  await api(s, 'POST', `/my/tasks/${id}`, { started_at: startedAt });
  const task = { id, number: doc.task.task_number, title: doc.task.title, estimate, startedAt };
  writeState(session, { ...readState(session), task, prompt: null, lastActivity: startedAt });
  return task;
}

/** Adds a note to the open task. False when it was closed or removed in the app meanwhile. */
async function noteTask(s, task, text) {
  try {
    await api(s, 'POST', `/my/tasks/${task.id}`, { comment: clip(text, COMMENT_MAX) });
    return true;
  } catch (err) {
    if (['TASK_CLOSED', 'NOT_FOUND'].includes(err.code)) return false;
    throw err;
  }
}

/** Completes the conversation's open task at `at` (default now). Returns it with its end time, or null. */
async function closeTask(s, session, note, at) {
  const state = readState(session);
  const task = state.task;
  if (!task) return null;
  const body = { ended_at: notBefore(at ?? new Date().toISOString(), task.startedAt) };
  if (note) body.completion_note = clip(note, NOTE_MAX);
  try {
    await api(s, 'POST', `/my/tasks/${task.id}`, body);
  } catch (err) {
    if (err.status === 422 && /in the future/.test(err.message) && err.serverTime) {
      // This machine's clock runs ahead of the server's: end it at the server's time instead.
      body.ended_at = notBefore(new Date(err.serverTime).toISOString(), task.startedAt);
      await api(s, 'POST', `/my/tasks/${task.id}`, body);
    } else if (['TASK_CLOSED', 'NOT_FOUND', 'INVALID_TRANSITION'].includes(err.code)) {
      // Completed, removed or blocked in the app meanwhile: nothing for the tracker to close.
      log('close', `${task.number}: ${err.code} ${err.message}`);
    } else {
      throw err;
    }
  }
  writeState(session, { ...readState(session), task: null });
  return { ...task, endedAt: body.ended_at };
}

// ------------------------------------------------------------------ hooks

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

/** What the agent is told with each prompt: where the work stands and the exact commands to run. */
function guidance(session, task) {
  const start = `${COMMAND} start --session ${session} --estimate <minutes> "<short title>"`;
  const done = `${COMMAND} done --session ${session} "<one-line summary of what you did>"`;
  if (!task) {
    return [
      'Task Queue tracking is on: your work for the user is logged as tasks in their Task Queue account.',
      '- If this request is work (a change, a fix, an investigation, a document; not a quick question or a thank-you), log it before anything else by running:',
      `  ${start}`,
      `  with your honest estimate of the minutes you need to finish it (at most ${MAX_ESTIMATE}; split longer work into several tasks).`,
      '- When that work is finished (done, not when you stop to ask the user something), run this as your last step. It records the end date and time:',
      `  ${done}`,
    ].join('\n');
  }
  return [
    `Task Queue: ${task.number} "${task.title}" is in progress (your estimate: ${task.estimate} minutes, started ${when(task.startedAt)}).`,
    '- If this prompt continues that work, carry on. When it is finished (done, not when you stop to ask the user something), run as your last step:',
    `  ${done}`,
    '- If it is new, unrelated work, first run the line below. It closes the open task at the time you last finished replying:',
    `  ${start}`,
  ].join('\n');
}

/** Asks the agent to finish setup, once per conversation: from SessionStart or the first prompt, whichever runs
 * first. Nothing when the user turned tracking off. */
function askForSetup(session, s) {
  if (s.file.enabled === false) return;
  const state = readState(session);
  if (state.setupAsked) return;
  writeState(session, { ...state, setupAsked: true });
  const missing = connected(s) ? 'the category for tracked work' : 'their Task Queue API URL and personal API key';
  process.stdout.write(
    `The Task Queue tracker plugin is installed but not set up: it still needs ${missing}. ` +
      'Before working on the first request, use the task-queue skill to ask the user for it and finish the setup. ' +
      'If the user says they do not want tracking, run its disable command.\n',
  );
}

const HOOKS = {
  /** Before a shell command: approve a run of this tracker, so the agent never stops to ask for it. */
  async approve(input) {
    if (!['Bash', 'PowerShell'].includes(input.tool_name) || !isTrackerCommand(input.tool_input?.command)) return;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'Task Queue tracker command, approved by the task-queue plugin.',
        },
      }),
    );
  },

  /** A prompt: remember it (it becomes the task's description, or a note on the open task) and brief the agent. */
  async prompt(input, s) {
    const prompt = String(input.prompt ?? '').trim();
    if (!prompt || prompt.startsWith('/')) return; // empty, or a slash command
    const session = input.session_id || 'default';
    // SessionStart doesn't run for a plugin loaded mid-conversation (/reload-plugins), so the prompt hook also
    // does its per-conversation work: keep the stable copy current and ask for setup until it's done.
    syncStableCopy();
    if (!ready(s)) return askForSetup(session, s);
    if (!s.enabled) return;
    let state = readState(session);
    if (state.task && Date.now() - lastActive(state) > s.idle * 60_000) {
      // Idle too long: that stretch of work ended when the agent last finished replying (or was last prompted).
      try {
        const closed = await closeTask(s, session, unfinished(state, 'closed after the conversation went idle.'), state.lastStop ?? state.lastActivity);
        log('prompt', `${closed.number} completed (idle)`);
      } catch (err) {
        log('prompt', `idle close failed: ${err.code} ${err.message}`);
      }
      state = readState(session);
    }
    const now = new Date().toISOString();
    writeState(session, { ...state, prompt: { text: prompt, at: now, cwd: input.cwd ?? null }, lastActivity: now });
    process.stdout.write(`${guidance(session, state.task)}\n`);
  },

  /** The agent finished a reply: note a follow-up prompt on the task it continued, and remember when it finished. */
  async stop(input, s) {
    const session = input.session_id || 'default';
    const state = readState(session);
    if (!state.task && !state.prompt) return;
    if (state.task && state.prompt && s.promptText && connected(s)) {
      try {
        if (!(await noteTask(s, state.task, `Prompt: ${state.prompt.text}`))) state.task = null; // closed in the app
      } catch (err) {
        log('stop', `note failed: ${err.code} ${err.message}`);
      }
    }
    const now = new Date().toISOString();
    const reply = s.promptText ? String(input.last_assistant_message ?? '').trim() : '';
    writeState(session, { ...state, prompt: null, lastStop: now, lastActivity: now, lastReply: reply ? clip(reply, NOTE_MAX) : state.lastReply });
  },

  /** Keep the stable copy current, close conversations that never ended, and ask for setup until it's done. */
  async 'session-start'(input, s) {
    syncStableCopy();
    if (connected(s) && fs.existsSync(SESSIONS)) {
      for (const name of fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.json'))) {
        const session = name.slice(0, -'.json'.length);
        const state = readJson(path.join(SESSIONS, name)) ?? {};
        if (session === input.session_id || session === MANUAL || Date.now() - lastActive(state) < ABANDONED_MS) continue;
        try {
          if (state.task) {
            await closeTask(s, session, unfinished(state, 'the conversation never ended properly.'), state.lastStop ?? state.lastActivity);
            log('session-start', `${state.task.number} closed (abandoned conversation)`);
          }
          fs.rmSync(path.join(SESSIONS, name), { force: true });
        } catch (err) {
          log('session-start', `closing ${state.task?.number} failed: ${err.code} ${err.message}`);
        }
      }
    }
    if (!ready(s)) askForSetup(input.session_id || 'default', s);
  },

  /** The conversation is over (exit, /clear, …): close anything left open, at the time the agent last finished. */
  async 'session-end'(input, s) {
    const session = input.session_id || 'default';
    const state = readState(session);
    if (state.task && connected(s)) {
      const closed = await closeTask(s, session, unfinished(state, 'closed when the conversation ended.'), state.lastStop);
      log('session-end', `${closed.number} completed (conversation ended)`);
    }
    fs.rmSync(stateFile(session), { force: true });
  },
};

// ------------------------------------------------------------------ commands

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [name, inline] = a.slice(2).split(/=(.*)/s);
      flags[name] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

const out = (...lines) => console.log(lines.join('\n'));

const RELOAD_HINT =
  'Tracking starts with your next prompt. In Claude Code, if the plugin was installed during this conversation, type /reload-plugins first so its hooks load now instead of in your next session.';

class Stop extends Error {}

/** Ends the command with a message for the user. (No process.exit: on Windows it can crash while fetch sockets close.) */
function fail(message) {
  throw new Stop(message);
}

async function account(s) {
  try {
    return await api(s, 'GET', '/my/tasks');
  } catch (err) {
    fail(`Task Queue refused the connection check: ${err.code}: ${err.message}`);
  }
}

function describeWorkspaces(list) {
  return list.map(
    (w) =>
      `- ${w.organization} / ${w.name}  (workspace id ${w.id})${w.can_add_tasks ? '' : '  [you can’t add tasks here]'}\n` +
      `  categories: ${w.categories.map((c) => `${c.value} (${c.label})`).join(', ')}`,
  );
}

function pickCategory(workspace, wanted) {
  const w = String(wanted).trim().toLowerCase();
  return workspace.categories.find((c) => c.value.toLowerCase() === w || c.label.toLowerCase() === w)?.value ?? null;
}

/** Fills in the workspace and category where the account leaves no choice, and says what's still missing. */
function settle(s, me, flags = {}) {
  const addable = me.workspaces.filter((w) => w.can_add_tasks);
  if (!addable.length) fail('This account can’t add tasks in any workspace: it needs Take tasks or Create tasks there. Ask a Task Queue admin.');
  let workspace = addable.find((w) => w.id === (flags.workspace ?? s.workspace)) ?? null;
  if (flags.workspace && !workspace) fail(`Workspace ${flags.workspace} isn’t one this account can add tasks to.\n${describeWorkspaces(addable).join('\n')}`);
  if (!workspace && addable.length === 1) workspace = addable[0];
  const changes = { workspace: workspace?.id };
  const wantedCategory = flags.category ?? s.category;
  if (workspace && wantedCategory) {
    const category = pickCategory(workspace, wantedCategory);
    if (!category && flags.category) fail(`"${flags.category}" isn’t a category in ${workspace.name}. Choose one of: ${workspace.categories.map((c) => c.value).join(', ')}`);
    changes.category = category ?? undefined;
  } else if (!workspace) {
    changes.category = undefined;
  }
  return { addable, workspace, changes };
}

function summary(s, extra = []) {
  out(
    `Tracking: ${!s.enabled ? 'off (disabled)' : ready(s) ? 'on' : 'not set up yet'}`,
    `API: ${s.url ?? 'not set'}`,
    `API key: ${maskKey(s.key)}`,
    `Workspace: ${s.workspace ?? 'not set (only needed when you belong to several)'}`,
    `Category: ${s.category ?? 'not set'}`,
    `Estimates: the agent's own, per task (${s.estimate} minutes if it gives none)`,
    `Idle limit: ${s.idle} minutes, after which an open task is closed at the agent's last reply`,
    `Prompt text sent: ${s.promptText ? 'yes (the request as the description, follow-up prompts as notes, the final reply as the note when not marked done)' : 'no'}`,
    'Approvals: none needed (the plugin approves its own tracker commands)',
    ...extra,
  );
}

function estimateOf(flags, s) {
  if (flags.estimate === undefined || flags.estimate === true) return { value: s.estimate, given: false };
  const n = Number(flags.estimate);
  if (!(Number.isInteger(n) && n >= 1 && n <= MAX_ESTIMATE)) {
    fail(`--estimate takes whole minutes from 1 to ${MAX_ESTIMATE}, e.g. --estimate 20. Split longer work into several tasks.`);
  }
  return { value: n, given: true };
}

const COMMANDS = {
  async setup({ flags }) {
    syncStableCopy();
    let s = loadSettings();
    const url = flags.url ? normalizeUrl(flags.url) : s.url;
    const key = typeof flags.key === 'string' ? flags.key.trim() : s.key;
    if (!url || !key) fail('Give both: setup --url <Task Queue API URL> --key <personal API key>');
    if (!key.startsWith('tqk_')) fail('That isn’t a Task Queue API key: keys start with tqk_. Generate one under Profile → API keys.');
    s = { ...s, url, key };
    const me = await account(s);
    const { addable, workspace, changes } = settle(s, me, flags);
    s = saveSettings({ url, key, ...changes, enabled: true });
    const next = [];
    if (!workspace) next.push('Next: choose the workspace with  set workspace <workspace id>', ...describeWorkspaces(addable));
    else if (!s.category) next.push(`Next: choose the category with  set category <VALUE>  (in ${workspace.name}: ${workspace.categories.map((c) => c.value).join(', ')})`);
    if (ready(s)) next.push(RELOAD_HINT);
    out(`Connected as ${me.user}.`);
    summary(s, next);
  },

  async set({ rest }) {
    const [field, ...words] = rest;
    const value = words.join(' ').trim();
    let s = loadSettings();
    const usage = 'Usage: set <workspace|category|estimate|idle|prompt-text> <value>';
    if (!value) fail(usage);
    if (field === 'estimate' || field === 'idle') {
      const n = Number(value);
      if (!(Number.isInteger(n) && n > 0)) fail(`The ${field} is whole minutes, e.g. ${field === 'idle' ? 60 : 30}.`);
      if (field === 'estimate' && n > MAX_ESTIMATE) fail(`The estimate can be at most ${MAX_ESTIMATE} minutes.`);
      s = saveSettings({ [field]: n });
    } else if (field === 'prompt-text') {
      if (!['on', 'off'].includes(value)) fail('Usage: set prompt-text on|off');
      s = saveSettings({ promptText: value === 'on' });
    } else if (field === 'workspace' || field === 'category') {
      if (!connected(s)) fail('Run setup first.');
      const me = await account(s);
      const { workspace, changes } = settle(s, me, { [field]: value });
      if (field === 'workspace' && s.category && !changes.category) {
        out(`${workspace.name} has no category "${s.category}": choose one with  set category <VALUE>  (${workspace.categories.map((c) => c.value).join(', ')})`);
      }
      s = saveSettings(changes);
    } else {
      fail(usage);
    }
    summary(s);
  },

  async workspaces() {
    const s = loadSettings();
    if (!connected(s)) fail('Run setup first.');
    out(...describeWorkspaces((await account(s)).workspaces));
  },

  async status() {
    const s = loadSettings();
    const extra = [];
    if (connected(s)) {
      try {
        const me = await api(s, 'GET', '/my/tasks');
        extra.push(`Connection: OK, signed in as ${me.user}`);
      } catch (err) {
        extra.push(`Connection: FAILED (${err.code}: ${err.message})`);
      }
    }
    const open = (fs.existsSync(SESSIONS) ? fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.json')) : [])
      .map((name) => readJson(path.join(SESSIONS, name))?.task)
      .filter(Boolean);
    extra.push(`Open tasks: ${open.length}`, ...open.map((t) => `  ${t.number}: ${t.title} (estimate ${t.estimate} min, started ${when(t.startedAt)})`));
    if (fs.existsSync(LOG)) extra.push('Recent log:', ...fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-5).map((l) => `  ${l}`));
    summary(s, extra);
  },

  async enable() {
    const s = saveSettings({ enabled: true });
    summary(s, ready(s) ? [] : ['Tracking starts once setup is finished.']);
  },

  async disable() {
    summary(saveSettings({ enabled: false }));
  },

  async start({ rest, flags }) {
    const s = loadSettings();
    if (!ready(s)) fail('Not set up: run setup --url <API URL> --key <API key> --category <VALUE> first.');
    const title = rest.join(' ').trim();
    if (!title) fail('Usage: start --estimate <minutes> "<short title>"');
    const estimate = estimateOf(flags, s);
    const session = typeof flags.session === 'string' ? flags.session : MANUAL;
    const pending = readState(session).prompt;
    let description = typeof flags.description === 'string' ? flags.description : '';
    if (!description && pending && s.promptText) {
      const project = pending.cwd ? path.basename(pending.cwd) : '';
      const footer = [project && `Project: ${project}`, `Session: ${session}`, 'Logged by the Task Queue tracker for AI coding agents.'].filter(Boolean).join('\n');
      description = `${clip(pending.text, PROMPT_MAX)}\n\n---\n${footer}`;
    }
    const task = await openTask(s, session, { title, estimate: estimate.value, description: description || undefined }).catch((err) =>
      fail(`Could not open the task: ${err.code}: ${err.message}`),
    );
    out(`Started ${task.number}: ${task.title} (estimate ${task.estimate} minutes${estimate.given ? '' : ', the default: no --estimate given'}).`);
  },

  async note({ rest, flags }) {
    const s = loadSettings();
    if (!connected(s)) fail('Not set up: run setup first.');
    const text = rest.join(' ').trim();
    if (!text) fail('Usage: note "<text>"');
    const session = typeof flags.session === 'string' ? flags.session : MANUAL;
    const state = readState(session);
    if (!state.task) fail('No task is open: start one first.');
    const noted = await noteTask(s, state.task, text).catch((err) => fail(`Could not add the note: ${err.code}: ${err.message}`));
    if (!noted) {
      writeState(session, { ...state, task: null });
      fail(`${state.task.number} was closed or removed in Task Queue: start a new task.`);
    }
    writeState(session, { ...state, lastActivity: new Date().toISOString() });
    out(`Noted on ${state.task.number}.`);
  },

  async done({ rest, flags }) {
    const s = loadSettings();
    if (!connected(s)) fail('Not set up: run setup first.');
    const session = typeof flags.session === 'string' ? flags.session : MANUAL;
    const closed = await closeTask(s, session, rest.join(' ').trim() || 'Done.').catch((err) => fail(`Could not complete the task: ${err.code}: ${err.message}`));
    if (!closed) return out('No task is open.');
    out(`Completed ${closed.number}: ${closed.title}, ended ${when(closed.endedAt)} (took ${minutes(closed.startedAt, closed.endedAt)} of the ${closed.estimate} minutes estimated).`);
  },

  async hook({ rest }) {
    const handler = HOOKS[rest[0]];
    try {
      const input = await readStdin();
      if (handler) await handler(input, loadSettings());
    } catch (err) {
      // A hook never blocks or fails the agent: whatever went wrong is only logged.
      log(`hook ${rest[0]}`, `failed: ${err.code ?? err.name} ${err.message}`);
    }
  },
};
COMMANDS.finish = COMMANDS.done;

const { flags, rest } = parseArgs(process.argv.slice(2));
const name = rest.shift();
try {
  if (!COMMANDS[name]) fail('Commands: setup, set, workspaces, status, enable, disable, start, note, done, hook. See the top of this file.');
  await COMMANDS[name]({ flags, rest });
} catch (err) {
  console.error(err.message);
  process.exitCode = name === 'hook' ? 0 : 1;
}
