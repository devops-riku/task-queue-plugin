#!/usr/bin/env node
/**
 * Task Queue tracker: logs each request you give an AI coding agent as a task in your own Task Queue
 * queue, started when you send it and completed when the agent finishes, so admins can see the work.
 *
 *   setup --url <api url> --key <api key> [--workspace <id>] [--category <VALUE>] [--estimate <minutes>]
 *   set <workspace|category|estimate|prompt-text> <value>
 *   workspaces                    Workspaces you can add tasks to, with their categories.
 *   status | enable | disable
 *   start "<title>" [--description <text>] [--session <id>]   Open and start a task by hand.
 *   finish ["<note>"] [--session <id>]                          Complete the task opened with start.
 *   hook <prompt|stop|session-start|session-end>              Hook entry points: JSON on stdin, never fail.
 *
 * Settings live in ~/.task-queue/config.json (TASK_QUEUE_HOME moves the folder). The environment variables
 * TASK_QUEUE_URL, TASK_QUEUE_API_KEY, TASK_QUEUE_WORKSPACE, TASK_QUEUE_CATEGORY and TASK_QUEUE_ESTIMATE
 * override it. No dependencies: Node 18 or later.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.TASK_QUEUE_HOME || path.join(os.homedir(), '.task-queue');
const CONFIG = path.join(HOME, 'config.json');
const SESSIONS = path.join(HOME, 'sessions');
const LOG = path.join(HOME, 'tracker.log');
const TIMEOUT_MS = 5000;
const DEFAULT_ESTIMATE = 30;
const TITLE_MAX = 200;
const PROMPT_MAX = 19000; // the description takes 20,000 characters; the rest is the footer
const NOTE_MAX = 4000;
const MANUAL = 'manual';

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

const stateFile = (session) => path.join(SESSIONS, `${String(session).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);

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
    estimate: Number(env.TASK_QUEUE_ESTIMATE || file.estimate || DEFAULT_ESTIMATE),
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

/** Creates the task in the user's own queue and starts it at the moment the server queued it. */
async function openTask(s, session, title, description) {
  if (fs.existsSync(stateFile(session))) {
    await closeTask(s, session, 'Closed when the next request came in before this one finished.');
  }
  const body = { title: clip(title, TITLE_MAX), category: s.category, estimate_minutes: s.estimate };
  if (s.workspace) body.workspace_id = s.workspace;
  if (description) body.description = description;
  const doc = await api(s, 'POST', '/my/tasks', body);
  // The id, not link.url: that carries the server's public address, which may differ from the configured one.
  const id = doc.link.url.split('/').pop();
  const startedAt = doc.task.queue_entered_at;
  await api(s, 'POST', `/my/tasks/${id}`, { started_at: startedAt });
  const state = { id, number: doc.task.task_number, title: doc.task.title, startedAt };
  writeJson(stateFile(session), state);
  return state;
}

/** Completes the session's open task now. Returns it, or null when nothing was open. */
async function closeTask(s, session, note) {
  const file = stateFile(session);
  const state = readJson(file);
  if (!state) return null;
  const body = { ended_at: notBefore(new Date().toISOString(), state.startedAt) };
  if (note) body.completion_note = clip(note, NOTE_MAX);
  try {
    await api(s, 'POST', `/my/tasks/${state.id}`, body);
  } catch (err) {
    if (err.status === 422 && /in the future/.test(err.message) && err.serverTime) {
      // This machine's clock runs ahead of the server's: end it at the server's time instead.
      body.ended_at = notBefore(new Date(err.serverTime).toISOString(), state.startedAt);
      await api(s, 'POST', `/my/tasks/${state.id}`, body);
    } else if (['TASK_CLOSED', 'NOT_FOUND', 'INVALID_TRANSITION'].includes(err.code)) {
      // Completed, removed or blocked in the app meanwhile: nothing for the tracker to close.
      log('close', `${state.number}: ${err.code} ${err.message}`);
    } else {
      throw err;
    }
  }
  fs.rmSync(file, { force: true });
  return state;
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

function promptTask(input, s) {
  const prompt = String(input.prompt ?? '').trim();
  const project = input.cwd ? path.basename(input.cwd) : '';
  const session = input.session_id || 'default';
  const firstLine = (prompt.split(/\r?\n/).find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim();
  const fallback = project ? `AI coding request in ${project}` : 'AI coding request';
  const title = s.promptText ? firstLine || fallback : fallback;
  const footer = [project && `Project: ${project}`, `Session: ${session}`, 'Logged by the Task Queue tracker for AI coding agents.']
    .filter(Boolean)
    .join('\n');
  const description = s.promptText ? `${clip(prompt, PROMPT_MAX)}\n\n---\n${footer}` : footer;
  return { prompt, session, title, description };
}

const HOOKS = {
  /** A new request: close any task the session left open, then open and start one for this request. */
  async prompt(input, s) {
    if (!s.enabled || !ready(s)) return;
    const task = promptTask(input, s);
    if (!task.prompt || task.prompt.startsWith('/')) return; // empty, or a slash command
    try {
      const state = await openTask(s, task.session, task.title, task.description);
      log('prompt', `${state.number} started: ${state.title}`);
    } catch (err) {
      log('prompt', `failed: ${err.code} ${err.message}`);
      // Printed text reaches the agent, so the user hears about it instead of losing the record silently.
      process.stdout.write(
        `Task Queue tracking could not log this request (${err.code}: ${err.message}). ` +
          'Tell the user once, briefly, and suggest checking it with the task-queue skill (status).\n',
      );
    }
  },

  /** The agent finished replying: complete the request's task with its last message as the note. */
  async stop(input, s) {
    if (!connected(s)) return;
    const session = input.session_id || 'default';
    const reply = s.promptText ? String(input.last_assistant_message ?? '').trim() : '';
    const state = await closeTask(s, session, reply || 'Finished.');
    if (state) log('stop', `${state.number} completed`);
  },

  /** Ask for setup at the start of a session until it's done (or turned off). */
  async 'session-start'(_input, s) {
    if (ready(s) || s.file.enabled === false) return;
    const missing = connected(s) ? 'the category for tracked requests' : 'their Task Queue API URL and personal API key';
    process.stdout.write(
      `The Task Queue tracker plugin is installed but not set up: it still needs ${missing}. ` +
        'Before working on the first request, use the task-queue skill to ask the user for it and finish the setup. ' +
        'If the user says they do not want tracking, run its disable command.\n',
    );
  },

  /** The session is over: complete anything it left open. */
  async 'session-end'(input, s) {
    if (!connected(s)) return;
    const state = await closeTask(s, input.session_id || 'default', 'Closed when the session ended.');
    if (state) log('session-end', `${state.number} completed`);
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
    `Estimate per request: ${s.estimate} minutes`,
    `Prompt text sent: ${s.promptText ? 'yes (title, description and the final reply as the completion note)' : 'no (generic title only)'}`,
    ...extra,
  );
}

const COMMANDS = {
  async setup({ flags }) {
    let s = loadSettings();
    const url = flags.url ? normalizeUrl(flags.url) : s.url;
    const key = typeof flags.key === 'string' ? flags.key.trim() : s.key;
    if (!url || !key) fail('Give both: setup --url <Task Queue API URL> --key <personal API key>');
    if (!key.startsWith('tqk_')) fail('That isn’t a Task Queue API key: keys start with tqk_. Generate one under Profile → API keys.');
    s = { ...s, url, key };
    const me = await account(s);
    const estimate = flags.estimate !== undefined ? Number(flags.estimate) : undefined;
    if (estimate !== undefined && !(Number.isInteger(estimate) && estimate > 0)) fail('--estimate takes whole minutes, e.g. 30.');
    const { addable, workspace, changes } = settle(s, me, flags);
    s = saveSettings({ url, key, ...changes, estimate: estimate ?? s.file.estimate, enabled: true });
    const next = [];
    if (!workspace) next.push('Next: choose the workspace with  set workspace <workspace id>', ...describeWorkspaces(addable));
    else if (!s.category) next.push(`Next: choose the category with  set category <VALUE>  (in ${workspace.name}: ${workspace.categories.map((c) => c.value).join(', ')})`);
    out(`Connected as ${me.user}.`);
    summary(s, next);
  },

  async set({ rest }) {
    const [field, ...words] = rest;
    const value = words.join(' ').trim();
    let s = loadSettings();
    if (!value) fail('Usage: set <workspace|category|estimate|prompt-text> <value>');
    if (field === 'estimate') {
      const n = Number(value);
      if (!(Number.isInteger(n) && n > 0)) fail('The estimate is whole minutes, e.g. 30.');
      s = saveSettings({ estimate: n });
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
      fail('Usage: set <workspace|category|estimate|prompt-text> <value>');
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
    const open = fs.existsSync(SESSIONS) ? fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.json')) : [];
    extra.push(`Open tracked tasks: ${open.length}`);
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
    if (!title) fail('Usage: start "<one-line summary of the request>"');
    const state = await openTask(s, flags.session || MANUAL, title, typeof flags.description === 'string' ? flags.description : undefined).catch((err) =>
      fail(`Could not open the task: ${err.code}: ${err.message}`),
    );
    out(`Started ${state.number}: ${state.title}`);
  },

  async finish({ rest, flags }) {
    const s = loadSettings();
    if (!connected(s)) fail('Not set up: run setup first.');
    const state = await closeTask(s, flags.session || MANUAL, rest.join(' ').trim() || 'Finished.').catch((err) =>
      fail(`Could not complete the task: ${err.code}: ${err.message}`),
    );
    out(state ? `Completed ${state.number}: ${state.title}` : 'No task is open.');
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

const { flags, rest } = parseArgs(process.argv.slice(2));
const name = rest.shift();
try {
  if (!COMMANDS[name]) fail('Commands: setup, set, workspaces, status, enable, disable, start, finish, hook. See the top of this file.');
  await COMMANDS[name]({ flags, rest });
} catch (err) {
  console.error(err.message);
  process.exitCode = name === 'hook' ? 0 : 1;
}
