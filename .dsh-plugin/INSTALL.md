# Superpowers for DeepSeek Harness (DSH)

Installs all 14 Superpowers skills into a DSH profile and injects the
`using-superpowers` bootstrap into every session as a user-role message.

## Install

```bash
# From a published checkout:
dsh plugin --profile web add link:/path/to/superpowers
```

`dsh plugin add` reads `package.json#dsh.bundle.patch` and appends
`superpowers` to the profile's `dsh.profile.bundles`, so the plugin row is
mounted on the next boot. Restart the profile to activate it.

Verify the row composed:

```bash
dsh --profile web --dump-config | grep -A2 '^- id: superpowers'
```

Expected:

```yaml
- id: superpowers
  name: superpowers/.dsh-plugin/index.js
```

## What it does

| Contribution | Seam | Effect |
|---|---|---|
| 14 skills | `ctx.skills.register()` | Each `skills/<name>/SKILL.md` enters the session catalog with its own directory as `resourceBase`, so companion files resolve. |
| Bootstrap | `ctx.on('agent/pre-step')` | `using-superpowers` plus a DSH tool-name mapping is appended to the step as a **user-role** message. |

Both contributions are effects — `ctx.effect()` and `ctx.on()` — so unloading
the plugin removes them cleanly.

### Why a user-role message at `agent/pre-step`

Superpowers auto-triggers on other harnesses through a `SessionStart` hook
(`hooks/hooks.json`, Claude Code) or a message transform (`.opencode`, `.pi`).
DSH has neither, but `agent/pre-step` lets a plugin append messages to the step
on its way in — the same seam DSH's own `dsh-tool-skill` uses for the skill
catalog and the `/name` gesture.

`docs/porting-to-a-new-harness.md` ("Shape B") requires a **user** message
rather than a system one, a dedup guard, and re-injection after compaction. An
earlier revision of this adapter used `ctx.systemPrompt.section()` instead.
Measurement showed why that was wrong: a system-prompt section reliably fires
skills on the first turn but decays afterwards, because nothing re-asserts it as
the conversation grows and the section sits far above the current task.

The dedup guard and the compaction re-injection are one check. `bootstrapVisible()`
scans the session log backwards for a bootstrap this plugin injected and tests
membership in `agent.session.surface.nodes`. Compaction leaves the event in
history but drops it from the visible surface, so the check turns false exactly
when the model can no longer read the bootstrap, and the next step re-injects it.
No compaction event is needed.

### Why an explicit entry path

The row is `superpowers/.dsh-plugin/index.js`, not the bare package name,
because `package.json#main` is already claimed by the OpenCode adapter. A bare
`superpowers` would load that plugin instead.

## Tool mapping

Skill bodies are written against Claude Code tool names. The bootstrap appends a
mapping table (`Task` → `subagent`, `Write`/`Edit` → `write`/`edit`,
`TodoWrite` → `todo_write`, and so on). If DSH's tool names change, update
`TOOL_MAPPING` in `.dsh-plugin/index.js`.

## Editing skills

Skill bodies are read when the plugin applies. After editing a `SKILL.md`,
reload the plugin (or restart the profile) to pick up the change. This differs
from DSH's built-in `dsh-skill-filesystem` provider, which watches its roots;
this plugin registers skills directly so they travel with the repository rather
than depending on where it is checked out.

## Alternative: no plugin

Because Superpowers' layout already matches DSH's filesystem provider contract
(`<name>/SKILL.md` with `name` + `description` frontmatter), you can skip this
plugin and symlink the skills instead:

```bash
mkdir -p ~/.dsh/skills
ln -s /path/to/superpowers/skills/* ~/.dsh/skills/
```

That gets discovery and live file-watching for free, but **no bootstrap
injection** — skills are then invoked on description match alone, which the
upstream project explicitly warns is the weaker mode.

## Verifying

```bash
dsh --profile web --dump-config | grep -c '^- id: superpowers'   # → 1
```

Then, in a session, confirm the model reports having superpowers and that
`brainstorming` triggers on a request such as "Let's make a react todo list".

## Upstream note

This adapter is fork-specific. `AGENTS.md` states that new-harness PRs require a
session transcript proving `brainstorming` auto-triggers on the acceptance test,
and that fork-sync PRs are closed. Do not open a PR against `obra/superpowers`
without meeting that bar.
