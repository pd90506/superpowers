// Superpowers plugin for DeepSeek Harness (DSH).
//
// Two contributions, mirroring what the Claude Code SessionStart hook and the
// OpenCode plugin do on their own harnesses:
//
//   1. Skill discovery — every `skills/<name>/SKILL.md` bundle is registered on
//      `ctx.skills` so all 14 skills appear in the session catalog. They are
//      registered directly rather than by adding `skills/` to the filesystem
//      provider's roots, so the skills travel with the repository wherever it
//      is checked out instead of depending on a configured path. Content is
//      used verbatim — no copying, symlinking, or rewriting.
//
//   2. Bootstrap injection — `using-superpowers` is injected as a user-role
//      message at `agent/pre-step`. DSH has no SessionStart hook, so this is
//      the seam that makes skills auto-trigger instead of sitting on disk as
//      dead weight.
//
//      The shape is prescribed by `docs/porting-to-a-new-harness.md` ("Shape
//      B"): a *user* message rather than a system one, guarded so it is not
//      injected twice, and re-injected once history no longer carries it. An
//      earlier revision used `ctx.systemPrompt.section()` instead; measurement
//      showed that shape only holds on the first turn, because nothing
//      re-asserts a system-prompt section as the conversation grows.
//
// Registration is an effect: every contribution goes through `ctx.effect()`,
// `ctx.on()`, or a service disposer, so unloading the plugin removes it
// cleanly.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

export const name = 'superpowers'
export const inject = ['skills']

const pluginRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(pluginRoot, '..')
const skillsDir = join(repoRoot, 'skills')

/**
 * Strip a leading YAML frontmatter block and return the body.
 * Superpowers' bootstrap body is injected verbatim; the frontmatter is
 * catalog metadata the filesystem provider already parsed.
 * @param text - raw SKILL.md content.
 * @returns the body with frontmatter removed.
 */
function stripFrontmatter(text) {
  if (!text.startsWith('---\n')) return text
  const end = text.indexOf('\n---', 4)
  if (end < 0) return text
  return text.slice(end + 4).replace(/^\n+/, '')
}

/**
 * Parse the `name`, `description`, and `whenToUse` fields out of a SKILL.md
 * frontmatter block. Values may be quoted or plain; a block spanning multiple
 * lines is not supported because no Superpowers skill uses one.
 * @param text - raw SKILL.md content.
 * @returns the parsed frontmatter fields and the body.
 */
function parseSkill(text) {
  const body = stripFrontmatter(text)
  if (!text.startsWith('---\n')) return { body }
  const end = text.indexOf('\n---', 4)
  if (end < 0) return { body }
  const meta = text.slice(4, end)
  const field = key => {
    const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(meta)
    return match?.[1]?.trim().replace(/^["']|["']$/g, '')
  }
  return { name: field('name'), description: field('description'), whenToUse: field('whenToUse'), body }
}

/**
 * Discover every `<name>/SKILL.md` bundle directly under the skills root.
 * Mirrors the directory-bundle half of DSH's filesystem provider contract:
 * only top-level bundles are skills; nested SKILL.md files are resources.
 * @param root - absolute path to the skills directory.
 * @returns one descriptor per discovered skill.
 */
function discoverSkills(root) {
  const found = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    // `withFileTypes` reports a symlinked directory as a link, so stat it.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = join(root, entry.name)
    const file = join(dir, 'SKILL.md')
    let text
    try {
      if (!statSync(dir).isDirectory()) continue
      text = readFileSync(file, 'utf8')
    } catch {
      continue // No SKILL.md: a resource directory, not a skill.
    }
    const parsed = parseSkill(text)
    // The registry requires kebab-case names and a description; skip anything
    // malformed rather than registering a skill the model cannot route to.
    if (!parsed.name || !parsed.description) continue
    found.push({ ...parsed, dir, file })
  }
  return found
}

// DSH tool names differ from the Claude Code names the skills were written
// against. Skills say "use the Task tool" or "Write the file"; without this
// mapping the model improvises. Keep this in sync with the actual DSH tool set.
const TOOL_MAPPING = `**Tool Mapping for DeepSeek Harness:**
When skills request actions, substitute the DSH equivalents:
- Create or update todos → \`todo_write\`
- \`Subagent (general-purpose):\` → \`subagent\` (or \`subagent_fork\` to inherit this conversation)
- Invoke a skill → DSH's native \`skill\` tool
- Read files → \`read\`
- Create or replace files → \`write\`; targeted edits → \`edit\`
- Run shell commands → \`bash\`
- Search file contents → \`grep\`; find files by path → \`glob\`
- Fetch a URL → \`web_fetch\`; search the web → \`web_search\`
- Ask your human partner a question → \`ask_user_question\`
- Present final deliverables → \`present\`

Use DSH's native \`skill\` tool to load any skill by name.`

/**
 * The bootstrap text, assembled once per process.
 * Re-reading and re-wrapping `SKILL.md` on every step would repeat the same
 * work on a hot path, so the body is read lazily and then cached.
 * @returns the full `<EXTREMELY_IMPORTANT>` block the model sees.
 */
let cachedBootstrapText
function bootstrapText() {
  if (cachedBootstrapText !== undefined) return cachedBootstrapText
  const body = stripFrontmatter(
    readFileSync(join(skillsDir, 'using-superpowers', 'SKILL.md'), 'utf8'),
  )
  cachedBootstrapText = `<EXTREMELY_IMPORTANT>
You have superpowers.

**The content below is your 'using-superpowers' skill — your introduction to using skills. It is ALREADY LOADED; you are currently following it. Do NOT call the \`skill\` tool to load "using-superpowers" again. For every other skill, use the \`skill\` tool.**

${body}

${TOOL_MAPPING}
</EXTREMELY_IMPORTANT>`
  return cachedBootstrapText
}

/**
 * Recursively freeze a value, mirroring how DSH publishes its own messages.
 * @param value - the structure to freeze in place.
 * @returns the same value, deeply frozen.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const inner of Object.values(value)) deepFreeze(inner)
  return value
}

/**
 * Does this message source identify a bootstrap this plugin injected?
 * `plugin` is the marker; `form` is one of DSH's fixed context forms and is
 * not discriminating on its own.
 * @param source - a message source from history or from the pending batch.
 * @returns true when the message is one of ours.
 */
function isBootstrapSource(source) {
  return source?.kind === 'plugin' && source.plugin === name
}

/**
 * Build the bootstrap as a user-role message.
 * Upstream requires a *user* message: repeated system messages inflate tokens
 * and break some models.
 * @returns a frozen user message carrying the bootstrap.
 */
function bootstrapMessage() {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: bootstrapText() }],
    source: { kind: 'plugin', plugin: name, form: 'instructions' },
  })
}

/**
 * Is a bootstrap still visible to the model in this session?
 * Presence in the log is not enough: compaction leaves the event in history
 * but drops it from the visible surface, and a bootstrap the model can no
 * longer read has to be injected again. This one check therefore serves as
 * both the dedup guard and the post-compaction re-injection trigger.
 * @param agent - the agent whose session log is inspected.
 * @returns true when the model can still see a bootstrap.
 */
function bootstrapVisible(agent) {
  const session = agent?.session
  if (session === undefined) return false
  const visible = new Set(session.surface.nodes)
  for (let index = session.seq - 1; index >= 0; index -= 1) {
    const event = session.eventAt(index)
    if (event === undefined) break
    if (event.type !== 'user/message') continue
    if (!isBootstrapSource(event.data?.source)) continue
    if (visible.has(event.seq)) return true
  }
  return false
}

/**
 * Mount the Superpowers skill root and inject the bootstrap.
 * @param ctx - Cordis context carrying the injected `skills` service.
 */
export function apply(ctx) {
  // 1. Register every skill bundle under `skills/`. `resourceBase` points at
  //    each skill's own directory so relative references inside a body
  //    (`examples/`, companion `*.md` files) resolve through the skill tool.
  //    The body is re-read at registration; DSH re-reads nothing afterwards,
  //    so a plugin reload is what picks up edited skill content.
  for (const skill of discoverSkills(skillsDir)) {
    ctx.effect(() =>
      ctx.skills.register({
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
        source: 'bundled',
        content: skill.body,
        path: skill.file,
        resourceBase: { kind: 'directory', path: skill.dir },
      }),
    )
  }

  // 2. Inject the bootstrap as a user-role message on the way into a step.
  //    Appending it to the decision places it in that step's message batch,
  //    after the durable prefix and the skill catalog. Ordering against other
  //    plugins' pre-step listeners follows their registration order, so this
  //    is "late in the step", not a guaranteed last position.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    // A waterfall listener owes `next()` its turn; skipping it would silently
    // short-circuit every other contributor.
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal?.throwIfAborted()
    if (decision.messages.some((message) => isBootstrapSource(message.source))) return decision
    if (bootstrapVisible(agent)) return decision
    return { ...decision, messages: [...decision.messages, bootstrapMessage()] }
  })
}
