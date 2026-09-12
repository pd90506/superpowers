import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const pluginPath = resolve(repoRoot, '.dsh-plugin/index.js');
const skillsDir = resolve(repoRoot, 'skills');

const BOOTSTRAP_PLUGIN = 'superpowers';

/**
 * A Cordis context stub carrying only what the adapter is allowed to use.
 * It deliberately has no `systemPrompt`: touching that service is the bug this
 * suite guards against, so any use throws instead of silently passing.
 */
function makeCtx() {
  const skills = [];
  const handlers = new Map();
  const ctx = {
    effect(fn) {
      const dispose = fn();
      return () => dispose?.();
    },
    skills: {
      register(skill) {
        skills.push(skill);
        return () => {};
      },
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
  };
  return { ctx, skills, handlers };
}

/**
 * A session stub over an explicit event log and visible-node surface.
 * `visible` defaults to "every node still visible"; pass [] to model a
 * compaction that dropped the bootstrap out of the surface.
 */
function makeAgent(events = [], visible) {
  return {
    session: {
      seq: events.length,
      eventAt: (index) => events[index],
      surface: { nodes: visible ?? events.map((event) => event.seq) },
    },
  };
}

function bootstrapEvent(seq) {
  return {
    seq,
    type: 'user/message',
    data: { source: { kind: 'plugin', plugin: BOOTSTRAP_PLUGIN, form: 'instructions' } },
  };
}

function bootstrapMessages(messages) {
  return messages.filter(
    (message) => message.source?.kind === 'plugin' && message.source?.plugin === BOOTSTRAP_PLUGIN,
  );
}

function textOf(message) {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

async function loadPlugin() {
  const { ctx, skills, handlers } = makeCtx();
  const mod = await import(`${pathToFileURL(pluginPath).href}?cachebust=${Date.now()}-${Math.random()}`);
  mod.apply(ctx);
  return { mod, skills, handlers };
}

function preStepHandler(handlers) {
  const registered = handlers.get('agent/pre-step') ?? [];
  assert.equal(registered.length, 1, 'expected exactly one agent/pre-step handler');
  return registered[0];
}

/** Drive the pre-step waterfall and report whether `next()` was reached. */
async function runPreStep(handler, { agent, decision }) {
  let nextCalls = 0;
  const result = await handler(
    { agent, messages: [], signal: { throwIfAborted() {} } },
    async () => {
      nextCalls += 1;
      return decision;
    },
  );
  return { result, nextCalls };
}

function enterDecision(messages = []) {
  return { kind: 'enter', messages };
}

test('adapter never reaches for the system prompt service', async () => {
  const { mod } = await loadPlugin();

  assert.ok(!mod.inject.includes('systemPrompt'), 'systemPrompt must not be injected');
  assert.deepEqual(mod.inject, ['skills']);
});

test('every skill bundle on disk is registered with its own resource base', async () => {
  const { skills } = await loadPlugin();

  const onDisk = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(skills.map((skill) => skill.name).sort(), onDisk);
  const brainstorming = skills.find((skill) => skill.name === 'brainstorming');
  assert.ok(brainstorming.description);
  assert.ok(brainstorming.content.length > 0);
  assert.equal(brainstorming.resourceBase.path, join(skillsDir, 'brainstorming'));
});

test('a fresh session receives the bootstrap as a user-role message', async () => {
  const { handlers } = await loadPlugin();
  const handler = preStepHandler(handlers);

  const { result, nextCalls } = await runPreStep(handler, {
    agent: makeAgent([]),
    decision: enterDecision(),
  });

  assert.equal(nextCalls, 1, 'the waterfall must call next()');
  const injected = bootstrapMessages(result.messages);
  assert.equal(injected.length, 1);
  assert.equal(injected[0].role, 'user', 'must be user-role, not a system message');
  assert.equal(injected[0].source.form, 'instructions');
  const text = textOf(injected[0]);
  assert.match(text, /<EXTREMELY_IMPORTANT>/);
  assert.match(text, /You have superpowers/);
  assert.match(text, /Tool Mapping for DeepSeek Harness/);
});

test('the bootstrap is appended last so it lands nearest the task', async () => {
  const { handlers } = await loadPlugin();
  const handler = preStepHandler(handlers);
  const earlier = { id: 'earlier', role: 'user', content: [], source: { kind: 'user' } };

  const { result } = await runPreStep(handler, {
    agent: makeAgent([]),
    decision: enterDecision([earlier]),
  });

  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0], earlier);
  assert.equal(result.messages.at(-1).source.plugin, BOOTSTRAP_PLUGIN);
});

test('a bootstrap already visible in history is not injected again', async () => {
  const { handlers } = await loadPlugin();
  const handler = preStepHandler(handlers);

  const { result } = await runPreStep(handler, {
    agent: makeAgent([bootstrapEvent(0)]),
    decision: enterDecision(),
  });

  assert.equal(bootstrapMessages(result.messages).length, 0);
});

test('a bootstrap compacted out of the visible surface is re-injected', async () => {
  const { handlers } = await loadPlugin();
  const handler = preStepHandler(handlers);

  const { result } = await runPreStep(handler, {
    agent: makeAgent([bootstrapEvent(0)], []),
    decision: enterDecision(),
  });

  assert.equal(bootstrapMessages(result.messages).length, 1);
});

test('the bootstrap is not injected twice within one step', async () => {
  const { handlers } = await loadPlugin();
  const handler = preStepHandler(handlers);
  const pending = {
    id: 'pending',
    role: 'user',
    content: [{ type: 'text', text: '<EXTREMELY_IMPORTANT>' }],
    source: { kind: 'plugin', plugin: BOOTSTRAP_PLUGIN, form: 'instructions' },
  };

  const { result } = await runPreStep(handler, {
    agent: makeAgent([]),
    decision: enterDecision([pending]),
  });

  assert.equal(bootstrapMessages(result.messages).length, 1);
});

test('a rejected decision passes through untouched', async () => {
  const { handlers } = await loadPlugin();
  const handler = preStepHandler(handlers);
  const decision = { kind: 'reject', messages: [] };

  const { result, nextCalls } = await runPreStep(handler, { agent: makeAgent([]), decision });

  assert.equal(nextCalls, 1);
  assert.equal(result, decision);
});
