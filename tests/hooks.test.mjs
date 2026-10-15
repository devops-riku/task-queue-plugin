// Hook tests for the tracker: the input each agent (Claude Code, Codex, Gemini CLI) sends, checked against what
// each one accepts back, plus check-ins against a fake Task Queue in its own process. No dependencies:
//   node tests/hooks.test.mjs [path to tq.mjs] [scratch dir]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const TQ = process.argv[2] ?? fileURLToPath(new URL('../plugins/task-queue/skills/task-queue/scripts/tq.mjs', import.meta.url));
const DIR = process.argv[3] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tq-hooks-'));
// What check-ins must report: the plugin's version, which the tracker keeps in step with the manifests.
const VERSION = JSON.parse(fs.readFileSync(new URL('../plugins/task-queue/.claude-plugin/plugin.json', import.meta.url), 'utf8')).version;
let n = 0;
const fresh = (name) => { const d = path.join(DIR, name); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };
const READY = { TASK_QUEUE_URL: 'http://127.0.0.1:9/api/v1', TASK_QUEUE_API_KEY: 'tqk_fake', TASK_QUEUE_CATEGORY: 'FEATURE' };
function hook(home, event, input, { host, env = {} } = {}) {
  const args = [TQ, 'hook', event, ...(host ? ['--host', host] : [])];
  const clean = { ...process.env };
  for (const k of ['TASK_QUEUE_URL', 'TASK_QUEUE_API_KEY', 'TASK_QUEUE_CATEGORY', 'TASK_QUEUE_WORKSPACE']) delete clean[k];
  const r = spawnSync(process.execPath, args, { input: JSON.stringify(input), env: { ...clean, TASK_QUEUE_HOME: home, ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const ok = (name) => console.log(`ok ${++n} - ${name}`);
const geminiJson = (out, event) => {
  const doc = JSON.parse(out); // throws if anything but one JSON document
  assert.equal(doc.hookSpecificOutput.hookEventName, event);
  assert.equal(typeof doc.hookSpecificOutput.additionalContext, 'string');
  return doc.hookSpecificOutput.additionalContext;
};
const tracker = (home) => `node ${path.join(home, 'tq.mjs').replace(/\\/g, '/')}`;

// Claude Code regression (default host)
let h = fresh('claude');
assert.match(hook(h, 'prompt', { session_id: 's1', prompt: 'fix it' }), /not set up/); ok('claude: not set up, first prompt asks for setup');
assert.equal(hook(h, 'prompt', { session_id: 's1', prompt: 'again' }), ''); ok('claude: asked once per conversation');
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h, 'sessions', 's1.json'), 'utf8')), { setupAsked: true }); ok('claude: pre-setup prompt not stored');
assert.ok(fs.readFileSync(path.join(h, 'tq.mjs')).equals(fs.readFileSync(TQ))); ok('claude: stable copy synced');
assert.match(hook(h, 'session-start', { session_id: 's2' }), /setup --url/); assert.equal(hook(h, 'prompt', { session_id: 's2', prompt: 'hi' }), ''); ok('claude: session-start then prompt asks once');
const off = fresh('off'); fs.writeFileSync(path.join(off, 'config.json'), '{"enabled":false}');
assert.equal(hook(off, 'prompt', { session_id: 's3', prompt: 'w' }) + hook(off, 'session-start', { session_id: 's3' }), ''); ok('claude: disabled stays silent');
assert.match(hook(h, 'prompt', { session_id: 's4', prompt: 'build' }, { env: READY }), /Task Queue tracking is on/); ok('claude: ready prompt gives guidance');
assert.equal(hook(h, 'prompt', { session_id: 's5', prompt: '/help' }, { env: READY }), ''); ok('claude: slash command ignored');
const allow = JSON.parse(hook(h, 'approve', { tool_name: 'Bash', tool_input: { command: `${tracker(h)} status` } }));
assert.equal(allow.hookSpecificOutput.permissionDecision, 'allow'); ok('claude: approve gives PreToolUse allow');
assert.equal(hook(h, 'approve', { tool_name: 'Bash', tool_input: { command: `${tracker(h)} status && rm -rf x` } }), ''); ok('claude: chained command not approved');
assert.match(hook(h, 'prompt', { session_id: 's6', prompt: 'x' }, { host: 'nonsense', env: READY }), /^Task Queue tracking is on/); ok('unknown host falls back to claude');

// Gemini CLI
h = fresh('gemini');
assert.match(geminiJson(hook(h, 'session-start', { session_id: 'g1', source: 'startup' }, { host: 'gemini' }), 'SessionStart'), /not set up/); ok('gemini: setup request is SessionStart JSON only');
assert.equal(hook(h, 'prompt', { session_id: 'g1', prompt: 'hello' }, { host: 'gemini' }), ''); ok('gemini: asked once per conversation');
assert.match(geminiJson(hook(h, 'prompt', { session_id: 'g2', prompt: 'fix' }, { host: 'gemini' }), 'BeforeAgent'), /not set up/); ok('gemini: setup request on first prompt is BeforeAgent JSON');
assert.match(geminiJson(hook(h, 'prompt', { session_id: 'g3', prompt: 'build it' }, { host: 'gemini', env: READY }), 'BeforeAgent'), /start --session g3/); ok('gemini: guidance is BeforeAgent JSON');
assert.equal(hook(h, 'stop', { session_id: 'g3', prompt: 'build it', prompt_response: 'Built it.' }, { host: 'gemini', env: READY }), ''); ok('gemini: AfterAgent prints nothing');
assert.equal(JSON.parse(fs.readFileSync(path.join(h, 'sessions', 'g3.json'), 'utf8')).lastReply, 'Built it.'); ok('gemini: prompt_response kept as the last reply');
assert.equal(hook(h, 'approve', { tool_name: 'run_shell_command', tool_input: { command: `${tracker(h)} status` } }, { host: 'gemini' }), ''); ok('gemini: never approves');
assert.equal(hook(h, 'session-end', { session_id: 'g3', reason: 'exit' }, { host: 'gemini', env: READY }), ''); ok('gemini: SessionEnd prints nothing');

// Codex
h = fresh('codex');
assert.match(hook(h, 'session-start', { session_id: 'c1', source: 'startup' }, { host: 'codex' }), /^The Task Queue tracker is installed but not set up/); ok('codex: setup request is plain text');
assert.match(hook(h, 'prompt', { session_id: 'c2', prompt: 'do it' }, { host: 'codex', env: READY }), /^Task Queue tracking is on/); ok('codex: guidance is plain text');
assert.equal(hook(h, 'stop', { session_id: 'c2', last_assistant_message: 'Done.', stop_hook_active: false }, { host: 'codex', env: READY }), ''); ok('codex: Stop prints nothing');
const cx = JSON.parse(hook(h, 'approve', { tool_name: 'Bash', tool_input: { command: `${tracker(h)} done --session c2 "x"` } }, { host: 'codex' }));
assert.deepEqual(cx, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }); ok('codex: approve gives PermissionRequest allow');
assert.equal(hook(h, 'approve', { tool_name: 'Bash', tool_input: { command: ['node', `${h}/tq.mjs`, 'status'] } }, { host: 'codex' }), ''); ok('codex: array command fails closed');
assert.equal(hook(h, 'approve', { tool_name: 'Bash', tool_input: { command: `${tracker(h)} status; whoami` } }, { host: 'codex' }), ''); ok('codex: chained command not approved');
// Check-ins, against a fake Task Queue in its own process: /ok has the endpoint, /missing is an older server.
const { spawn } = await import('node:child_process');
const REQS = path.join(DIR, 'fake-requests.log');
fs.rmSync(REQS, { force: true });
const PORT = 8799;
const fake = spawn(process.execPath, ['-e', `
  const fs = require('fs');
  require('http').createServer((q, r) => {
    let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => {
      fs.appendFileSync(${JSON.stringify(REQS)}, JSON.stringify({ url: q.url, body: b ? JSON.parse(b) : null }) + '\\n');
      r.setHeader('content-type', 'application/json');
      if (q.url.startsWith('/slow')) return; // accepts the request and never answers
      if (q.method === 'POST' && q.url.endsWith('/my/tasks')) {
        // /nofolder is an older Task Queue: it refuses the folder field.
        if (q.url.startsWith('/nofolder') && JSON.parse(b).folder) {
          r.statusCode = 422;
          return r.end(JSON.stringify({ code: 'VALIDATION_ERROR', message: 'folder: Extra inputs are not permitted' }));
        }
        const task = { task_number: 'TASK-9', title: JSON.parse(b).title, queue_entered_at: new Date().toISOString() };
        return r.end(JSON.stringify({ link: { url: 'http://tq/api/v1/my/tasks/t9' }, task }));
      }
      if (q.url.startsWith('/missing')) { r.statusCode = 404; return r.end(JSON.stringify({ code: 'NOT_FOUND', message: 'Not Found' })); }
      r.end(JSON.stringify({ recorded: [] }));
    });
  }).listen(${PORT}, () => console.log('ready'));
`]);
await new Promise((resolve) => fake.stdout.once('data', resolve));
const requests = () => (fs.existsSync(REQS) ? fs.readFileSync(REQS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const at = (prefix) => ({ TASK_QUEUE_URL: `http://127.0.0.1:${PORT}/${prefix}/api/v1`, TASK_QUEUE_API_KEY: 'tqk_fake', TASK_QUEUE_CATEGORY: 'FEATURE' });
try {
  for (const host of ['claude', 'codex', 'gemini']) {
    h = fresh(`ci-${host}`);
    const before = requests().length;
    assert.equal(hook(h, 'session-start', { session_id: 'x' }, { host, env: at('ok') }), ''); ok(`${host}: check-in at session start prints nothing`);
    const sent = requests().slice(before);
    assert.deepEqual(sent, [{ url: '/ok/api/v1/my/tracker', body: { host, version: VERSION, enabled: true } }]); ok(`${host}: check-in sends only agent, version and on/off`);
    const out = hook(h, 'prompt', { session_id: 'x', prompt: 'work' }, { host, env: at('ok') });
    if (host === 'gemini') geminiJson(out, 'BeforeAgent'); else assert.match(out, /^Task Queue tracking is on/);
    assert.equal(requests().length, before + 1); ok(`${host}: one check-in per conversation, guidance output untouched`);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h, 'check-ins.json'), 'utf8')).hosts, [host]); ok(`${host}: agent remembered`);
  }
  h = fresh('ci-paused'); fs.writeFileSync(path.join(h, 'config.json'), '{"enabled":false}');
  assert.equal(hook(h, 'prompt', { session_id: 'p', prompt: 'work' }, { env: at('ok') }), '');
  assert.equal(requests().at(-1).body.enabled, false); ok('paused tracker still checks in, with enabled false, silently');

  h = fresh('ci-old');
  const before = requests().length;
  assert.equal(hook(h, 'session-start', { session_id: 'o1' }, { host: 'gemini', env: at('missing') }), ''); ok('older server: nothing printed');
  assert.ok(JSON.parse(fs.readFileSync(path.join(h, 'check-ins.json'), 'utf8')).unsupportedAt); ok('older server: remembered as unsupported');
  assert.equal(hook(h, 'session-start', { session_id: 'o2' }, { host: 'gemini', env: at('missing') }), '');
  assert.equal(requests().length, before + 1); ok('older server: not asked again for a day');
  assert.match(fs.readFileSync(path.join(h, 'tracker.log'), 'utf8'), /no check-in endpoint/); ok('older server: logged');

  h = fresh('ci-slow');
  const slowBefore = requests().length;
  let t = Date.now();
  assert.match(hook(h, 'prompt', { session_id: 's', prompt: 'work' }, { env: at('slow') }), /^Task Queue tracking is on/);
  assert.ok(Date.now() - t < 10_000, 'the check-in gives up');
  t = Date.now();
  hook(h, 'prompt', { session_id: 's', prompt: 'more work' }, { env: at('slow') });
  assert.ok(Date.now() - t < 2000, `second prompt waited ${Date.now() - t} ms`);
  assert.equal(requests().length, slowBefore + 1); ok('hanging server: one attempt per conversation, later prompts not delayed');

  h = fresh('ci-down');
  for (const host of ['claude', 'codex', 'gemini']) assert.equal(hook(h, 'session-start', { session_id: `d-${host}` }, { host, env: READY }), '');
  ok('unreachable server: nothing printed in any agent');

  // enable / disable report for every agent this tracker has checked in from
  h = fresh('ci-toggle');
  hook(h, 'session-start', { session_id: 't' }, { host: 'codex', env: at('ok') });
  hook(h, 'session-start', { session_id: 't2' }, { host: 'claude', env: at('ok') });
  const mark = requests().length;
  const off = spawnSync(process.execPath, [TQ, 'disable'], { env: { ...process.env, TASK_QUEUE_HOME: h, ...at('ok') }, encoding: 'utf8' });
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /Reported to Task Queue/);
  assert.deepEqual(requests().slice(mark).map((r) => [r.body.host, r.body.enabled]).sort(), [['claude', false], ['codex', false]]); ok('disable reports off for each agent');
  const down = spawnSync(process.execPath, [TQ, 'disable'], { env: { ...process.env, TASK_QUEUE_HOME: h, ...READY }, encoding: 'utf8' });
  assert.doesNotMatch(down.stdout, /Reported/); ok('disable does not claim a report it could not make');
  // Task descriptions: the agent's summary, then the user's request unless prompt text is off, then a footer.
  const startTask = (home, args) => {
    const r = spawnSync(process.execPath, [TQ, 'start', ...args], { env: { ...process.env, TASK_QUEUE_HOME: home, ...at('ok') }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return requests().filter((q) => q.url === '/ok/api/v1/my/tasks').at(-1).body;
  };
  const summary = 'Sign-in sends people to the home page instead of the page they asked for.';
  h = fresh('desc-on');
  assert.match(hook(h, 'prompt', { session_id: 'd', prompt: 'fix the login redirect', cwd: 'D:/work/shop' }, { env: at('ok') }), /--description "/);
  ok('guidance asks for a description');
  let body = startTask(h, ['--session', 'd', '--estimate', '20', '--description', summary, 'Fix the login redirect']);
  assert.equal(body.description, `${summary}\n\nRequest:\nfix the login redirect\n\n---\nProject: shop\nSession: d\nLogged by the Task Queue tracker for AI coding agents.`);
  ok('description: summary, then the request, then the footer');
  h = fresh('desc-off'); fs.writeFileSync(path.join(h, 'config.json'), '{"promptText":false}');
  hook(h, 'prompt', { session_id: 'd', prompt: 'secret request text', cwd: 'D:/work/shop' }, { env: at('ok') });
  body = startTask(h, ['--session', 'd', '--estimate', '20', '--description', summary, 'Fix the login redirect']);
  assert.equal(body.description, `${summary}\n\n---\nSession: d\nLogged by the Task Queue tracker for AI coding agents.`);
  ok('prompt text off: summary only, no request and no project');
  h = fresh('desc-none');
  hook(h, 'prompt', { session_id: 'd', prompt: 'fix it', cwd: 'D:/work/shop' }, { env: at('ok') });
  assert.match(startTask(h, ['--session', 'd', '--estimate', '20', 'Fix it']).description, /^fix it\n\n---\nProject: shop/);
  ok('no description given: the request, as before');
  const cmd = `${tracker(h)} start --session d --estimate 20 --description "Sign-in (signed out) goes home, not back." "Fix login"`;
  assert.equal(JSON.parse(hook(h, 'approve', { tool_name: 'Bash', tool_input: { command: cmd } })).hookSpecificOutput.permissionDecision, 'allow');
  ok('a start with a description is still approved');

  // Project folders: each task is filed under its project, named after the git repository or working folder.
  const startIn = (home, args, prefix = 'ok') => {
    const r = spawnSync(process.execPath, [TQ, 'start', ...args], { env: { ...process.env, TASK_QUEUE_HOME: home, ...at(prefix) }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return requests().filter((q) => q.url === `/${prefix}/api/v1/my/tasks`);
  };
  const client = path.join(DIR, 'clients', 'Stars PH'); // need not exist
  h = fresh('folders');
  assert.match(hook(h, 'prompt', { session_id: 'f', prompt: 'fix checkout', cwd: client }, { env: at('ok') }), /folder "Stars PH"/);
  ok('guidance names the project folder');
  assert.equal(startIn(h, ['--session', 'f', '--estimate', '20', 'Fix checkout']).at(-1).body.folder, 'Stars PH');
  ok('task filed under the working folder name');
  const repo = path.join(DIR, 'Stars PH app');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'api'), { recursive: true });
  hook(h, 'prompt', { session_id: 'g', prompt: 'fix the api', cwd: path.join(repo, 'src', 'api') }, { env: at('ok') });
  assert.equal(startIn(h, ['--session', 'g', '--estimate', '20', 'Fix the api']).at(-1).body.folder, 'Stars PH app');
  ok('inside a git repository: its name, from any subfolder');
  hook(h, 'prompt', { session_id: 'home', prompt: 'misc', cwd: os.homedir() }, { env: at('ok') });
  assert.equal(startIn(h, ['--session', 'home', '--estimate', '20', 'Misc']).at(-1).body.folder, undefined);
  ok('home directory: no folder');
  assert.equal(startIn(h, ['--session', 'f', '--estimate', '20', '--folder', 'Client X', 'Other work']).at(-1).body.folder, 'Client X');
  ok('--folder overrides the project');
  h = fresh('folders-off');
  fs.writeFileSync(path.join(h, 'config.json'), '{"folders":false}');
  assert.doesNotMatch(hook(h, 'prompt', { session_id: 'f', prompt: 'x', cwd: client }, { env: at('ok') }), /folder "/);
  assert.equal(startIn(h, ['--session', 'f', '--estimate', '20', 'X']).at(-1).body.folder, undefined);
  ok('folders off: none sent, none named');
  h = fresh('folders-old');
  hook(h, 'prompt', { session_id: 'f', prompt: 'x', cwd: client }, { env: at('nofolder') });
  assert.deepEqual(startIn(h, ['--session', 'f', '--estimate', '20', 'X'], 'nofolder').slice(-2).map((q) => q.body.folder), ['Stars PH', undefined]);
  ok('older server: retried without the folder');

  // Idle closing: only after the agent finished replying and nothing happened since.
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const task = { id: 't1', number: 'TASK-1', title: 'Long work', estimate: 30, startedAt: ago(120) };
  const statePath = (home, id) => path.join(home, 'sessions', `${id}.json`);
  h = fresh('idle');
  fs.mkdirSync(path.join(h, 'sessions'));
  // A long turn: the task started 120 min ago, the last reply was before it, and no reply since.
  fs.writeFileSync(statePath(h, 'long'), JSON.stringify({ task, lastStop: ago(125), lastActivity: ago(120) }));
  assert.match(hook(h, 'prompt', { session_id: 'long', prompt: 'mid-turn message' }, { env: at('ok') }), /TASK-1 "Long work" is in progress/);
  assert.equal(JSON.parse(fs.readFileSync(statePath(h, 'long'), 'utf8')).task?.id, 't1'); ok('long agent turn: task kept open');
  // A real idle stretch: the agent replied 90 min ago and nothing happened since.
  const replied = ago(90); // the stop hook writes both from one timestamp
  fs.writeFileSync(statePath(h, 'idle'), JSON.stringify({ task, lastStop: replied, lastActivity: replied }));
  hook(h, 'prompt', { session_id: 'idle', prompt: 'back again' }, { env: at('ok') });
  assert.equal(JSON.parse(fs.readFileSync(statePath(h, 'idle'), 'utf8')).task, null);
  assert.ok(requests().some((r) => r.url === '/ok/api/v1/my/tasks/t1' && r.body.ended_at)); ok('real idle: task closed');
} finally {
  fake.kill();
}
console.log(`\nall ${n} passed`);
if (!process.argv[3]) fs.rmSync(DIR, { recursive: true, force: true });
