#!/usr/bin/env node
/**
 * Task Queue tracker: the AI coding agent logs its own work as tasks in your Task Queue queue, so admins
 * can see it. When a request is new work, the agent opens a task with its own estimate of how long it
 * needs (`start`), and when the work is finished it completes the task with the end date and time
 * (`done`). Follow-up prompts on the same work are added to the open task as notes.
 *
 * In Claude Code, Codex and Gemini CLI the plugin's hooks keep the agent informed (every prompt says whether a
 * task is open and what to run) and close what it leaves open: a conversation idle past the idle limit, one
 * that ends (exit, /clear), or one abandoned without ending, at the time the agent last finished replying.
 *
 *   setup --url <api url> --key <api key> [--workspace <id>] [--category <VALUE>]
 *   set <workspace|category|estimate|idle|prompt-text> <value>
 *   workspaces | status | enable | disable
 *   start [--session <id>] --estimate <minutes> [--description "<text>"] [--folder "<name>"] [--parent <task number>] "<title>"
 *                                                            Open and start a task (with --parent, as a subtask
 *                                                            of that task).
 *   note [--session <id>] "<text>"                           Add a note to the open task.
 *   done [--session <id>] "<summary>"                        Complete it now (alias: finish).
 *   hook <prompt|stop|session-start|session-end|approve> [--host claude|codex|gemini]
 *                                                            Hook entry points: JSON on stdin, never fail.
 *
 * In Claude Code and Codex the agent never has to ask before running the tracker: a hook approves exactly one
 * run of it, with nothing chained, piped, redirected or substituted. Gemini CLI doesn't let an extension
 * approve commands, so there the user approves them (or allows them with their own policy).
 *
 * When Task Queue can't be reached, nothing fails: tasks opened, notes and completions are kept in
 * ~/.task-queue/outbox, and the hooks quietly check for Task Queue again (at most every RETRY_MS) and send
 * everything kept, in order, once it answers. `status` checks at once.
 *
 * Settings live in ~/.task-queue/config.json (TASK_QUEUE_HOME moves the folder), with a copy of this script
 * at ~/.task-queue/tq.mjs so the commands have a stable path. The environment variables TASK_QUEUE_URL,
 * TASK_QUEUE_API_KEY, TASK_QUEUE_WORKSPACE and TASK_QUEUE_CATEGORY override the settings. No dependencies:
 * Node 18 or later.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = process.env.TASK_QUEUE_HOME || path.join(os.homedir(), '.task-queue');
const CONFIG = path.join(HOME, 'config.json');
const SESSIONS = path.join(HOME, 'sessions');
const LOG = path.join(HOME, 'tracker.log');
const STABLE = path.join(HOME, 'tq.mjs');
const CHECK_INS = path.join(HOME, 'check-ins.json');
// Changes Task Queue didn't get because it couldn't be reached: one file each, sent oldest first once it answers.
const OUTBOX = path.join(HOME, 'outbox');
// Tasks opened from the outbox, by the local ref they had until then: their id and number in Task Queue.
const OPENED = path.join(HOME, 'opened.json');
// When the last try to send the outbox failed, and why.
const SYNC = path.join(HOME, 'sync.json');
// Held while one process sends the outbox, so two conversations never send the same change twice.
const SYNC_LOCK = path.join(HOME, 'sync.lock');
// The plugin's version, reported in check-ins. Keep it the same as the plugin and extension manifests.
const VERSION = '1.6.0';
const TIMEOUT_MS = 5000;
// Check-ins run while a session starts, so they give up sooner than other calls.
const CHECK_IN_TIMEOUT_MS = 2500;
// After a server says it has no check-in endpoint, wait this long before trying it again.
const UNSUPPORTED_RETRY_MS = 24 * 60 * 60 * 1000;
// After Task Queue didn't answer, hooks wait this long before checking again, so they stay quick while it's down.
const RETRY_MS = 30 * 1000;
// A pass over the outbox starts no change after this long; the rest goes on the next one. Hooks get less: one
// change can take three calls, and all of it has to fit in the 20 seconds the agents give a hook.
const SYNC_BUDGET_MS = 10 * 1000;
const HOOK_SYNC_BUDGET_MS = 2 * 1000;
// A lock older than this was left by a process that died while sending.
const LOCK_STALE_MS = 60 * 1000;
// Opened tasks are remembered this long, past any conversation that could still name them by their ref.
const OPENED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
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
const FOLDER_MAX = 60;
const PARENT_MAX = 64;
// A task's description takes 20,000 characters: the agent's own summary, the user's request, then the footer.
const SUMMARY_MAX = 2000;
const PROMPT_MAX = 16000;
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

/** One conversation's state: its open task (if any), its pending prompt, and when it was last active. A task
 * opened while Task Queue couldn't be reached gets its id and number here once the outbox has opened it. */
function readState(session) {
  const state = readJson(stateFile(session)) ?? {};
  const made = state.task && !state.task.number && state.task.ref ? opened(state.task.ref) : null;
  if (made) state.task = { ...state.task, id: made.id, number: made.number };
  return state;
}
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
    // File each task in a folder named after the project the agent works in.
    folders: file.folders ?? true,
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

async function api(s, method, route, body, timeout = TIMEOUT_MS) {
  let res;
  try {
    res = await fetch(s.url + route, {
      method,
      headers: { Authorization: `Bearer ${s.key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
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

/** Task Queue didn't answer, or the proxy in front of it says it's down: worth trying again later. Anything else
 * (a revoked key, a refused field) won't change by waiting. */
const unreachable = (err) => err instanceof ApiError && [0, 502, 503, 504].includes(err.status);

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The project a working directory belongs to: its git repository's folder name, or else the directory's own.
 * None for the home directory or a drive root, which aren't projects. */
function projectOf(cwd) {
  if (!cwd) return '';
  const start = path.resolve(cwd);
  let root = start;
  for (let dir = start, i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      root = dir;
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (root === path.dirname(root) || path.resolve(root) === path.resolve(os.homedir())) return '';
  return clip(path.basename(root).trim(), FOLDER_MAX);
}

/** The later of two instants, as the string to send (ended_at can't be before started_at). */
function notBefore(at, floor) {
  const a = Date.parse(at);
  const f = Date.parse(floor);
  return Number.isNaN(f) || a >= f ? new Date(a).toISOString() : floor;
}

/** Tells Task Queue which agent this tracker runs in, its version and whether tracking is on, so admins can see
 * on the audit log when it's paused, resumed, or goes silent (removed). Nothing else is sent. Never throws and
 * never prints: a failure is only logged, and a server without the endpoint is left alone for a day. */
async function checkIn(s, host) {
  if (!connected(s)) return false;
  const seen = readJson(CHECK_INS) ?? {};
  if (seen.unsupportedAt && Date.now() - Date.parse(seen.unsupportedAt) < UNSUPPORTED_RETRY_MS) return false;
  try {
    const body = { host, version: VERSION, enabled: s.enabled };
    if (s.workspace) body.workspace_id = s.workspace;
    const { recorded } = await api(s, 'POST', '/my/tracker', body, CHECK_IN_TIMEOUT_MS);
    if (recorded?.length) log('check-in', `${host}: ${recorded.join(', ')}`);
    writeJson(CHECK_INS, { hosts: [...new Set([...(seen.hosts ?? []), host])] });
    return true;
  } catch (err) {
    if (err.status === 404 && !/workspace/i.test(err.message)) {
      // An older Task Queue without /my/tracker. (A workspace that's gone is a 404 too, and is logged each time.)
      writeJson(CHECK_INS, { ...seen, unsupportedAt: new Date().toISOString() });
      log('check-in', 'this Task Queue has no check-in endpoint; trying again in a day');
    } else {
      log('check-in', `${host} failed: ${err.code} ${err.message}`);
    }
    return false;
  }
}

/** Checks in once per conversation, from SessionStart or the first prompt, whichever runs first. One attempt,
 * whatever the outcome, so a slow server delays one prompt at most; the next conversation tries again. Before
 * setup there is nothing to send, so the first prompt after setup checks in. */
async function checkInOnce(session, s, host) {
  const state = readState(session);
  if (state.checkedIn || !connected(s)) return;
  writeState(session, { ...state, checkedIn: true });
  await checkIn(s, host);
}

/** Reports a change made by command (enable, disable) for every agent this tracker has checked in from.
 * Returns whether Task Queue got it. */
async function checkInEverywhere(s) {
  let reported = false;
  for (const host of (readJson(CHECK_INS) ?? {}).hosts ?? []) reported = (await checkIn(s, host)) || reported;
  return reported;
}

/** The note for a task the agent never marked done: why it was closed, and the agent's last reply. */
const unfinished = (state, why) => `Not marked done: ${why}${state.lastReply ? `\n\nLast reply: ${state.lastReply}` : ''}`;

const lastActive = (state) => Date.parse(state.lastActivity ?? state.task?.startedAt ?? 0);
const minutes = (from, to) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
const when = (iso) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
/** A task by its number, or by its title while it's still waiting in the outbox. */
const named = (task) => task.number ?? `"${task.title}"`;

// ------------------------------------------------------------------ the outbox

/** The changes waiting in the outbox, oldest first. */
function pending() {
  try {
    return fs.readdirSync(OUTBOX).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

/** Writes a file whole or not at all, so another process never reads half of it. */
function writeWhole(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const part = `${file}.${process.pid}.part`;
  fs.writeFileSync(part, JSON.stringify(data));
  fs.renameSync(part, file);
}

let queued = 0;
/** Keeps a change for when Task Queue answers again. Files are named by time, so they list in the order made. */
function enqueue(change) {
  writeWhole(path.join(OUTBOX, `${String(Date.now()).padStart(15, '0')}-${process.pid}-${String(queued++).padStart(4, '0')}.json`), change);
}

/** The task a ref names, once the outbox has opened it in Task Queue: its id, number, title and start there. */
const opened = (ref) => (readJson(OPENED) ?? {})[ref] ?? null;

function rememberOpened(ref, made) {
  try {
    const now = Date.now();
    const all = Object.entries(readJson(OPENED) ?? {}).filter(([, t]) => now - Date.parse(t.at) < OPENED_KEEP_MS);
    writeWhole(OPENED, { ...Object.fromEntries(all), [ref]: { ...made, at: new Date(now).toISOString() } });
  } catch (err) {
    log('sync', `could not remember ${made.number}: ${err.message}`);
  }
}

const describe = (change) => `${change.op} of ${change.body ? `"${change.body.title}"` : change.id ?? change.ref}`;

function failed(err) {
  writeJson(SYNC, { failedAt: new Date().toISOString(), status: err.status, error: `${err.code}: ${err.message}` });
}

/** Takes the outbox for this process. False while another one is sending it. */
function lockOutbox() {
  for (let tries = 0; tries < 2; tries++) {
    try {
      fs.closeSync(fs.openSync(SYNC_LOCK, 'wx'));
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return false;
      try {
        if (Date.now() - fs.statSync(SYNC_LOCK).mtimeMs < LOCK_STALE_MS) return false;
        fs.rmSync(SYNC_LOCK, { force: true }); // left by a process that died while sending
      } catch {
        return false;
      }
    }
  }
  return false;
}

/** Whether Task Queue refused a new task because of its parent: that task can't take subtasks (it's a subtask, closed,
 * cancelled or full), it isn't there, the account may not add subtasks, or (an older Task Queue) the field is unknown. */
function parentRefused(err) {
  if (['SUBTASK_DEPTH', 'TOO_MANY_SUBTASKS', 'TASK_CLOSED', 'INVALID_TRANSITION'].includes(err.code)) return true;
  if (err.status === 403 || err.status === 404) return true;
  return err.status === 422 && /parent/i.test(err.message);
}

/** Adds the task of an 'open' change. What Task Queue refuses that the task can do without is dropped and the add
 * tried again: a folder an older Task Queue doesn't know, or a parent that can't take it (the task is then filed on
 * its own, and `change.parentRefused` says why). */
async function addTask(s, change) {
  for (;;) {
    try {
      return await api(s, 'POST', '/my/tasks', change.body);
    } catch (err) {
      if (change.body.folder && err.status === 422 && /folder/i.test(err.message)) {
        log('start', `this Task Queue has no project folders; "${change.body.folder}" not used`);
        delete change.body.folder;
      } else if (change.body.parent && parentRefused(err)) {
        log('start', `not filed under ${change.body.parent}: ${err.code} ${err.message}`);
        change.parentRefused = err.message;
        delete change.body.parent;
      } else {
        throw err;
      }
    }
  }
}

/** Makes one change in Task Queue: opens a task (adds it, then starts it), notes on one, or completes one. A task
 * opened from the outbox is named by its ref until then. Returns 'sent', or 'gone' when the task was closed or
 * removed in the app meanwhile. `added` is told as soon as Task Queue has added a task, before it's started. */
async function send(s, change, added = () => {}) {
  const post = (id, body) => api(s, 'POST', `/my/tasks/${id}`, body);
  if (change.op === 'open') {
    if (!change.made) {
      const doc = await addTask(s, change);
      // The id, not link.url: that carries the server's public address, which may differ from the configured one.
      const id = doc.link.url.split('/').pop();
      change.made = {
        id,
        number: doc.task.task_number,
        title: doc.task.title,
        startedAt: doc.task.queue_entered_at,
        parent: doc.task.parent?.task_number ?? null,
      };
      added(change);
    }
    // Task Queue can't start a task before it got it, so work begun while it couldn't be reached says when.
    const { id, startedAt } = change.made;
    const late = Date.parse(startedAt) - Date.parse(change.startedAt) >= 60_000;
    const comment = `Started ${change.startedAt}, while Task Queue couldn't be reached. It got the task at ${startedAt}.`;
    await post(id, { started_at: startedAt, ...(late ? { comment } : {}) });
    return 'sent';
  }
  const made = change.ref ? opened(change.ref) : null;
  const id = change.id ?? made?.id;
  try {
    if (!id) throw new ApiError(404, 'NOT_FOUND', 'Its task was never opened in Task Queue.');
    if (change.op === 'note') {
      await post(id, { comment: change.text });
      return 'sent';
    }
    // Nor end it before it started: work finished while Task Queue couldn't be reached says when, too.
    const floor = made?.startedAt ?? change.startedAt;
    const body = { ended_at: notBefore(change.endedAt, floor) };
    const note = made && Date.parse(change.endedAt) < Date.parse(made.startedAt)
      ? `${change.note ?? 'Done.'}\n\nWorked on from ${change.startedAt} to ${change.endedAt}, while Task Queue couldn't be reached.`
      : change.note;
    if (note) body.completion_note = clip(note, NOTE_MAX);
    try {
      await post(id, body);
    } catch (err) {
      if (!(err.status === 422 && /in the future/.test(err.message) && err.serverTime)) throw err;
      // This machine's clock runs ahead of the server's: end it at the server's time instead.
      body.ended_at = notBefore(new Date(err.serverTime).toISOString(), floor);
      await post(id, body);
    }
    change.endedAt = body.ended_at;
    return 'sent';
  } catch (err) {
    // Completed, removed or blocked in the app meanwhile: nothing left for the tracker to do.
    if (!['TASK_CLOSED', 'NOT_FOUND', 'INVALID_TRANSITION'].includes(err.code)) throw err;
    log(change.op, `${made?.number ?? id ?? change.ref}: ${err.code} ${err.message}`);
    return 'gone';
  }
}

/** Sends what's waiting in the outbox, oldest first, once Task Queue answers. Quiet: only the log says what
 * happened. Hooks skip the try for RETRY_MS after one that failed, so they don't keep waiting on a Task Queue
 * that's down. Commands set `now`: they try at once, and may take longer. */
async function sync(s, { now = false } = {}) {
  if (!connected(s) || !pending().length) return;
  const last = readJson(SYNC);
  if (!now && last && Date.now() - Date.parse(last.failedAt) < RETRY_MS) return;
  if (!lockOutbox()) return; // another conversation is sending them
  const until = Date.now() + (now ? SYNC_BUDGET_MS : HOOK_SYNC_BUDGET_MS);
  const seen = new Set();
  let sent = 0;
  try {
    // Listed again after each pass: other conversations may add changes meanwhile.
    passes: for (let names = pending(); (names = names.filter((n) => !seen.has(n))).length; names = pending()) {
      for (const name of names) {
        if (Date.now() > until) break passes; // the rest goes on the next try
        seen.add(name);
        const file = path.join(OUTBOX, name);
        const change = readJson(file);
        try {
          if (change) {
            // Added but not yet started is written down at once, so even a killed hook never adds it twice.
            await send(s, change, () => writeWhole(file, change));
            if (change.op === 'open') rememberOpened(change.ref, change.made);
            sent++;
          }
        } catch (err) {
          if (unreachable(err) || [401, 403].includes(err.status)) {
            // Down again, or the key or access needs fixing: kept, and tried again later.
            if (!last) log('sync', `Task Queue didn't answer (${err.code}); ${pending().length} changes kept`);
            failed(err);
            return;
          }
          // Refused for good (a removed category, say): waiting won't help.
          log('sync', `dropped the ${describe(change)}: ${err.code} ${err.message}`);
        }
        fs.rmSync(file, { force: true });
      }
    }
    fs.rmSync(SYNC, { force: true });
  } finally {
    fs.rmSync(SYNC_LOCK, { force: true });
    if (sent) log('sync', `Task Queue answered: sent ${sent} kept change${sent === 1 ? '' : 's'}, ${pending().length} still waiting`);
  }
}

/** Sends a change now, or keeps it in the outbox when Task Queue can't be reached or older changes are still
 * waiting there (those go first). Returns 'sent', 'gone' or 'kept'; any other failure is thrown. */
async function deliver(s, change, { flush = true } = {}) {
  if (flush) await sync(s);
  if (!pending().length) {
    try {
      return await send(s, change);
    } catch (err) {
      if (!unreachable(err)) throw err;
      log(change.op, `Task Queue didn't answer (${err.code}): the ${describe(change)} is kept until it does`);
      failed(err);
    }
  }
  enqueue(change);
  return 'kept';
}

// ------------------------------------------------------------------ tasks

/** Creates a task in the user's own queue with the agent's estimate and starts it at once. While Task Queue can't
 * be reached the task is kept in the outbox, without a number until it's sent. */
async function openTask(s, session, { title, estimate, description, folder, parent }) {
  const state = readState(session);
  if (state.task) await closeTask(s, session, unfinished(state, 'closed when new work started.'), state.lastStop);
  const body = { title: clip(title, TITLE_MAX), category: s.category, estimate_minutes: estimate };
  if (s.workspace) body.workspace_id = s.workspace;
  if (description) body.description = description;
  if (folder) body.folder = folder;
  if (parent) body.parent = parent;
  const change = { op: 'open', ref: randomUUID(), body, startedAt: new Date().toISOString() };
  await deliver(s, change);
  const made = change.made;
  const task = { ref: change.ref, id: made?.id ?? null, number: made?.number ?? null, title: made?.title ?? body.title, estimate, startedAt: made?.startedAt ?? change.startedAt };
  writeState(session, { ...readState(session), task, prompt: null, lastActivity: task.startedAt });
  // Not kept in the session's state: only what start reports.
  return { ...task, parent: made?.parent ?? null, parentRefused: change.parentRefused ?? null };
}

/** Adds a note to the open task: 'sent', 'kept' for later, or 'gone' when it was closed or removed in the app. */
const noteTask = (s, task, text) => deliver(s, { op: 'note', id: task.id ?? null, ref: task.ref ?? null, text: clip(text, COMMENT_MAX) });

/** Completes the conversation's open task at `at` (default now). Returns it with its end time and whether it was
 * only kept for later, or null. */
async function closeTask(s, session, note, at, { flush = true } = {}) {
  const state = readState(session);
  const task = state.task;
  if (!task) return null;
  const change = { op: 'close', id: task.id ?? null, ref: task.ref ?? null, startedAt: task.startedAt, endedAt: notBefore(at ?? new Date().toISOString(), task.startedAt) };
  if (note) change.note = clip(note, NOTE_MAX);
  const outcome = await deliver(s, change, { flush });
  writeState(session, { ...readState(session), task: null });
  return { ...task, endedAt: change.endedAt, kept: outcome === 'kept' };
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

/** The agents that run these hooks (`--host`). Claude Code by default, so existing installs keep working. */
const HOSTS = ['claude', 'codex', 'gemini'];

/** Adds `text` to the agent's context. Gemini reads only JSON from a hook's stdout; the others take plain text. */
function tell(host, event, text) {
  if (host === 'gemini') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
  } else {
    process.stdout.write(`${text}\n`);
  }
}

/** What the agent is told with each prompt: where the work stands and the exact commands to run. */
function guidance(session, task, project) {
  const start = `${COMMAND} start --session ${session} --estimate <minutes> --description "<what the work is and why, in one or two sentences>" "<short title>"`;
  const done = `${COMMAND} done --session ${session} "<one-line summary of what you did>"`;
  // Admins read these. One line without $, backticks or backslashes also keeps the command auto-approved.
  const fields = [
    '  Write the title and description in plain words for the people who review the work: no secrets, each on one line, without $, backticks or backslashes.',
    ...(project ? [`  The task is filed in the Task Queue folder "${project}", after this project. To file it under another project, add --folder "<project name>".`] : []),
    '  If the user says the work is part of an existing Task Queue task, add --parent <its task number> to file it as a subtask of that task.',
  ].join('\n');
  if (!task) {
    return [
      'Task Queue tracking is on: your work for the user is logged as tasks in their Task Queue account.',
      '- If this request is work (a change, a fix, an investigation, a document; not a quick question or a thank-you), log it before anything else by running:',
      `  ${start}`,
      `  with your honest estimate of the minutes you need to finish it (at most ${MAX_ESTIMATE}; split longer work into several tasks).`,
      fields,
      '- When that work is finished (done, not when you stop to ask the user something), run this as your last step. It records the end date and time:',
      `  ${done}`,
    ].join('\n');
  }
  return [
    `Task Queue: ${task.number ? `${task.number} ` : ''}"${task.title}" is in progress (your estimate: ${task.estimate} minutes, started ${when(task.startedAt)}).`,
    '- If this prompt continues that work, carry on. When it is finished (done, not when you stop to ask the user something), run as your last step:',
    `  ${done}`,
    '- If it is new, unrelated work, first run the line below. It closes the open task at the time you last finished replying:',
    `  ${start}`,
    fields,
  ].join('\n');
}

/** The request to finish setup, once per conversation: from SessionStart or the first prompt, whichever runs
 * first. Null when it was already made or the user turned tracking off. It names the exact commands, since not
 * every agent can open the task-queue skill. */
function setupRequest(session, s) {
  if (s.file.enabled === false) return null;
  const state = readState(session);
  if (state.setupAsked) return null;
  writeState(session, { ...state, setupAsked: true });
  const missing = connected(s) ? 'the category for tracked work' : 'their Task Queue API URL and personal API key';
  return [
    `The Task Queue tracker is installed but not set up: it still needs ${missing}. Before working on the first request, finish the setup:`,
    '1. Ask the user for their Task Queue API URL (e.g. http://localhost:8000/api/v1) and their personal API key (Task Queue: Profile, API keys; it starts with tqk_). The key is saved only on this machine; never repeat it back or write it anywhere else.',
    `2. Run: ${COMMAND} setup --url <url> --key <key>`,
    `3. If it lists several workspaces, ask the user which one and run: ${COMMAND} set workspace <workspace id>`,
    `4. Ask which category the tasks go under (setup lists them) and run: ${COMMAND} set category <VALUE>`,
    `If the user does not want tracking, run: ${COMMAND} disable`,
  ].join('\n');
}

const HOOKS = {
  /** Before a shell command: approve a run of this tracker, so the agent never stops to ask for it. Claude Code
   * approves in PreToolUse and Codex in PermissionRequest; Gemini CLI doesn't let an extension approve. */
  async approve(input, s, host) {
    if (!['Bash', 'PowerShell'].includes(input.tool_name) || !isTrackerCommand(input.tool_input?.command)) return;
    if (host === 'codex') {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }));
    } else if (host === 'claude') {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'Task Queue tracker command, approved by the task-queue plugin.',
          },
        }),
      );
    }
  },

  /** A prompt: remember it (it becomes the task's description, or a note on the open task) and brief the agent. */
  async prompt(input, s, host) {
    const prompt = String(input.prompt ?? '').trim();
    if (!prompt || prompt.startsWith('/')) return; // empty, or a slash command
    const session = input.session_id || 'default';
    // SessionStart doesn't run for a plugin loaded mid-conversation (/reload-plugins), so the prompt hook also
    // does its per-conversation work: keep the stable copy current, check in (paused or not), and ask for setup
    // until it's done.
    syncStableCopy();
    await checkInOnce(session, s, host);
    if (!ready(s)) {
      const request = setupRequest(session, s);
      if (request) tell(host, 'BeforeAgent', request);
      return;
    }
    if (!s.enabled) return;
    await sync(s);
    let state = readState(session);
    // Idle means the agent finished replying and nothing happened since. A prompt, task or note after its last
    // reply means it is still working on a turn (a message sent mid-turn, or a background job reporting back),
    // however long that turn takes.
    const midTurn = !state.lastStop || Date.parse(state.lastActivity ?? 0) > Date.parse(state.lastStop);
    if (state.task && !midTurn && Date.now() - lastActive(state) > s.idle * 60_000) {
      // Idle too long: that stretch of work ended when the agent last finished replying (or was last prompted).
      try {
        const closed = await closeTask(s, session, unfinished(state, 'closed after the conversation went idle.'), state.lastStop ?? state.lastActivity);
        log('prompt', `${named(closed)} completed (idle)`);
      } catch (err) {
        log('prompt', `idle close failed: ${err.code} ${err.message}`);
      }
      state = readState(session);
    }
    const now = new Date().toISOString();
    writeState(session, { ...state, prompt: { text: prompt, at: now, cwd: input.cwd ?? null }, lastActivity: now });
    tell(host, 'BeforeAgent', guidance(session, state.task, s.folders ? projectOf(input.cwd) : ''));
  },

  /** The agent finished a reply: note a follow-up prompt on the task it continued, and remember when it finished. */
  async stop(input, s) {
    const session = input.session_id || 'default';
    await sync(s);
    const state = readState(session);
    if (!state.task && !state.prompt) return;
    if (state.task && state.prompt && s.promptText && connected(s)) {
      try {
        if ((await noteTask(s, state.task, `Prompt: ${state.prompt.text}`)) === 'gone') state.task = null; // closed in the app
      } catch (err) {
        log('stop', `note failed: ${err.code} ${err.message}`);
      }
    }
    const now = new Date().toISOString();
    // Claude Code and Codex send the final reply as last_assistant_message, Gemini CLI as prompt_response.
    const reply = s.promptText ? String(input.last_assistant_message ?? input.prompt_response ?? '').trim() : '';
    writeState(session, { ...state, prompt: null, lastStop: now, lastActivity: now, lastReply: reply ? clip(reply, NOTE_MAX) : state.lastReply });
  },

  /** Keep the stable copy current, check in, send what was kept while Task Queue couldn't be reached, close
   * conversations that never ended, and ask for setup until it's done. */
  async 'session-start'(input, s, host) {
    syncStableCopy();
    await checkInOnce(input.session_id || 'default', s, host);
    await sync(s);
    if (connected(s) && fs.existsSync(SESSIONS)) {
      for (const name of fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.json'))) {
        const session = name.slice(0, -'.json'.length);
        const state = readJson(path.join(SESSIONS, name)) ?? {};
        if (session === input.session_id || session === MANUAL || Date.now() - lastActive(state) < ABANDONED_MS) continue;
        try {
          if (state.task) {
            await closeTask(s, session, unfinished(state, 'the conversation never ended properly.'), state.lastStop ?? state.lastActivity);
            log('session-start', `${named(state.task)} closed (abandoned conversation)`);
          }
          fs.rmSync(path.join(SESSIONS, name), { force: true });
        } catch (err) {
          log('session-start', `closing ${state.task && named(state.task)} failed: ${err.code} ${err.message}`);
        }
      }
    }
    if (!ready(s)) {
      const request = setupRequest(input.session_id || 'default', s);
      if (request) tell(host, 'SessionStart', request);
    }
  },

  /** The conversation is over (exit, /clear, …): close anything left open, at the time the agent last finished.
   * Codex gives this hook 3 seconds, so it doesn't send the outbox; the next hook to run does. */
  async 'session-end'(input, s) {
    const session = input.session_id || 'default';
    const state = readState(session);
    if (state.task && connected(s)) {
      const closed = await closeTask(s, session, unfinished(state, 'closed when the conversation ended.'), state.lastStop, { flush: false });
      log('session-end', `${named(closed)} completed (conversation ended)`);
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

/** Why a change was kept in the outbox, for the agent. Task Queue being unreachable needs nothing from anyone: the
 * tracker sends it on its own later. A key or access Task Queue refused needs the user. */
function keptBecause() {
  const last = readJson(SYNC);
  if ([401, 403].includes(last?.status)) return `: Task Queue refused what was already waiting (${last.error}). It's all sent once that's fixed; tell the user once.`;
  return ": Task Queue can't be reached right now, and it's sent automatically once it can. Nothing to tell the user; carry on.";
}

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
    `Project folders: ${s.folders ? 'on (each task is filed in a folder named after its project)' : 'off (tasks go to the default folder)'}`,
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
    const usage = 'Usage: set <workspace|category|estimate|idle|prompt-text|folders> <value>';
    if (!value) fail(usage);
    if (field === 'estimate' || field === 'idle') {
      const n = Number(value);
      if (!(Number.isInteger(n) && n > 0)) fail(`The ${field} is whole minutes, e.g. ${field === 'idle' ? 60 : 30}.`);
      if (field === 'estimate' && n > MAX_ESTIMATE) fail(`The estimate can be at most ${MAX_ESTIMATE} minutes.`);
      s = saveSettings({ [field]: n });
    } else if (field === 'folders') {
      if (!['on', 'off'].includes(value)) fail('Usage: set folders on|off');
      s = saveSettings({ folders: value === 'on' });
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
      let answered = false;
      try {
        const me = await api(s, 'GET', '/my/tasks');
        extra.push(`Connection: OK, signed in as ${me.user}`);
        answered = true;
      } catch (err) {
        extra.push(`Connection: FAILED (${err.code}: ${err.message})`);
      }
      if (answered) await sync(s, { now: true });
    }
    const open = (fs.existsSync(SESSIONS) ? fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.json')) : [])
      .map((name) => readState(name.slice(0, -'.json'.length)).task)
      .filter(Boolean);
    extra.push(`Open tasks: ${open.length}`, ...open.map((t) => `  ${t.number ?? 'not sent yet'}: ${t.title} (estimate ${t.estimate} min, started ${when(t.startedAt)})`));
    const waiting = pending().length;
    const last = readJson(SYNC);
    extra.push(
      waiting
        ? `Waiting to send: ${waiting} change${waiting === 1 ? '' : 's'} kept while Task Queue couldn't be reached${last ? ` (last try: ${last.error})` : ''}. They're sent when it answers.`
        : 'Waiting to send: nothing',
    );
    if (fs.existsSync(LOG)) extra.push('Recent log:', ...fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-5).map((l) => `  ${l}`));
    summary(s, extra);
  },

  async enable() {
    const s = saveSettings({ enabled: true });
    await checkInEverywhere(s);
    summary(s, ready(s) ? [] : ['Tracking starts once setup is finished.']);
  },

  async disable() {
    const s = saveSettings({ enabled: false });
    const reported = await checkInEverywhere(s);
    summary(s, reported ? ['Reported to Task Queue: its audit log shows tracking is off.'] : []);
  },

  async start({ rest, flags }) {
    const s = loadSettings();
    if (!ready(s)) fail('Not set up: run setup --url <API URL> --key <API key> --category <VALUE> first.');
    const title = rest.join(' ').trim();
    if (!title) fail('Usage: start --estimate <minutes> --description "<what the work is>" "<short title>"');
    const estimate = estimateOf(flags, s);
    const session = typeof flags.session === 'string' ? flags.session : MANUAL;
    const asked = readState(session).prompt;
    // The agent's summary of the work, then (unless prompt text is off) the user's request it came from.
    const summary = typeof flags.description === 'string' ? clip(flags.description.trim(), SUMMARY_MAX) : '';
    const request = asked && s.promptText ? clip(asked.text, PROMPT_MAX) : '';
    let description = '';
    if (summary || request) {
      const project = request && asked.cwd ? path.basename(asked.cwd) : '';
      const footer = [project && `Project: ${project}`, `Session: ${session}`, 'Logged by the Task Queue tracker for AI coding agents.'].filter(Boolean).join('\n');
      const body = [summary, request && (summary ? `Request:\n${request}` : request)].filter(Boolean).join('\n\n');
      description = `${body}\n\n---\n${footer}`;
    }
    const folder = typeof flags.folder === 'string' ? clip(flags.folder.trim(), FOLDER_MAX) : s.folders ? projectOf(asked?.cwd) : '';
    const parent = typeof flags.parent === 'string' ? clip(flags.parent.trim(), PARENT_MAX) : '';
    await sync(s, { now: true });
    const task = await openTask(s, session, {
      title,
      estimate: estimate.value,
      description: description || undefined,
      folder: folder || undefined,
      parent: parent || undefined,
    }).catch((err) => fail(`Could not open the task: ${err.code}: ${err.message}`));
    const est = `estimate ${task.estimate} minutes${estimate.given ? '' : ', the default: no --estimate given'}`;
    if (!task.number) return out(`Saved "${task.title}" (${est}) on this machine${keptBecause()}`);
    const under = task.parent ? `, a subtask of ${task.parent}` : '';
    // Filed on its own instead: the task still counts, so this is said, not failed.
    const alone = task.parentRefused ? ` It was filed on its own, not under ${parent}: ${task.parentRefused}` : '';
    out(`Started ${task.number}: ${task.title} (${est}${under}).${alone}`);
  },

  async note({ rest, flags }) {
    const s = loadSettings();
    if (!connected(s)) fail('Not set up: run setup first.');
    const text = rest.join(' ').trim();
    if (!text) fail('Usage: note "<text>"');
    const session = typeof flags.session === 'string' ? flags.session : MANUAL;
    await sync(s, { now: true });
    const state = readState(session);
    if (!state.task) fail('No task is open: start one first.');
    const noted = await noteTask(s, state.task, text).catch((err) => fail(`Could not add the note: ${err.code}: ${err.message}`));
    if (noted === 'gone') {
      writeState(session, { ...state, task: null });
      fail(`${named(state.task)} was closed or removed in Task Queue: start a new task.`);
    }
    writeState(session, { ...state, lastActivity: new Date().toISOString() });
    out(noted === 'kept' ? `Saved the note on this machine${keptBecause()}` : `Noted on ${state.task.number}.`);
  },

  async done({ rest, flags }) {
    const s = loadSettings();
    if (!connected(s)) fail('Not set up: run setup first.');
    const session = typeof flags.session === 'string' ? flags.session : MANUAL;
    await sync(s, { now: true });
    const closed = await closeTask(s, session, rest.join(' ').trim() || 'Done.').catch((err) => fail(`Could not complete the task: ${err.code}: ${err.message}`));
    if (!closed) return out('No task is open.');
    const took = `took ${minutes(closed.startedAt, closed.endedAt)} of the ${closed.estimate} minutes estimated`;
    if (closed.kept) return out(`Saved the completion of "${closed.title}" (ended ${when(closed.endedAt)}, ${took}) on this machine${keptBecause()}`);
    out(`Completed ${closed.number}: ${closed.title}, ended ${when(closed.endedAt)} (${took}).`);
  },

  async hook({ rest, flags }) {
    const handler = HOOKS[rest[0]];
    const host = HOSTS.includes(flags.host) ? flags.host : 'claude';
    try {
      const input = await readStdin();
      if (handler) await handler(input, loadSettings(), host);
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
