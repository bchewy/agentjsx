# Hermes, through the effectctx lens

A working harness, not a port. [Hermes Agent](https://github.com/NousResearch/hermes-agent) is a Python harness from Nous Research with a self-improving learning loop, multi-platform delivery (Telegram/Discord/Slack/etc.), session search, scheduled automations, subagent delegation, and pluggable terminal backends. effectctx is a TypeScript composition model. This folder takes Hermes's agent-core ideas and rebuilds them as small steering extensions over an append-only event log.

## Run it

```bash
cd harnesses/hermes
npm install
AI_GATEWAY_API_KEY=... npm run agent "your prompt"
```

State persists under `./.hermes/`:

- `.hermes/workspace/` — the agent's sandboxed working directory
- `.hermes/skills/<handle>/SKILL.md` — skills the agent has saved itself
- `.hermes/skills/.usage.json` — per-skill counters + lifecycle state (used by curator)
- `.hermes/skills/.archive/<handle>/` — archived skills, hidden from the catalog
- `.hermes/sessions/<id>.json` — past session transcripts (for `session_search`)
- `.hermes/user-model.json` — the user model the agent has built up

Run it twice. The second run sees what the first run wrote.

## Tests

```bash
npx vitest run harnesses/hermes/test
```

Thirteen deterministic scenarios using `scriptedInfer` (no real LLM). They pin the contracts this harness claims to preserve from Hermes — see "What we test" below.

## Feature map

| Hermes feature | effectctx shape | Where |
| --- | --- | --- |
| Skill catalog (load on demand, refreshed each turn) | `dynamicSkills` extension | `extensions/dynamic-skills.ts` |
| Skill creation from experience | `learningLoop` (`save_skill`) | `extensions/learning-loop.ts` |
| Skill self-improvement during use | `learningLoop` (`update_skill`) | same |
| Skill usage telemetry (`skill_usage.py`) | counters in `SkillStore` (sidecar `.usage.json`) | `skill-store.ts` |
| Skill lifecycle / curator (`curator.py`) | `skillCurator` extension + `manage_skill` tool | `extensions/skill-curator.ts` |
| Honcho-style user model | `userModel` extension | `extensions/user-model.ts` |
| Reflection nudges | `nudge` extension | `extensions/nudge.ts` |
| Todo tool (`todo_tool.py`) | `todos` extension | `extensions/todos.ts` |
| Clarify tool (`clarify_tool.py`) | `clarify` extension | `extensions/clarify.ts` |
| Subagent delegation (`delegate_task`) | core `subagents` + Hermes-flavored child loadout | `index.ts` |
| Session search (`session_search_tool.py`) | `sessionSearch` ext + `SessionStore` | `extensions/session-search.ts`, `session-store.ts` |
| Recall over current log | core `recall` | core |
| Compaction / summarization | core `auto-compact`, `summarize` | core |
| Local workspace backend | core `localWorkspace` | core |
| Multi-model (Portal/OpenRouter/NIM/...) | pluggable `infer` | core |
| Hydration across restarts | event-log replay | `docs/hydration.md` |

## Known gaps from Hermes

We deliberately stopped before these. Each is real Hermes functionality and a candidate for follow-up:

| Hermes feature | Why deferred |
| --- | --- |
| **Skills hub / sync** (`skills_hub.py`, `skills_sync.py`) — central skill registry with bundled-vs-agent-created provenance | Distribution concern; out of scope for "agent core." |
| **Cron tool surface** (`cronjob_tools.py`) — model can schedule jobs | The tool is a thin wrapper over a CronStore. The *firing* mechanism (which actually runs the job) is process-level, not agent-level. We mention this in "What sits outside." |
| **Approval gate** (`approval.py`) — interactive approval for dangerous commands | Tightly bound to the `terminal_tool` thread-local approval callback; correct shape is a workspace adapter wrapper, not a standalone extension. |
| **Send-message tool** (`send_message_tool.py`) — outbound to platforms | Gateway concern; sits outside the agent. |
| **Memory provider lifecycle** (`memory_provider.py` `on_delegation` / `flush` hooks) | Hermes's curator and delegation systems share a memory-provider contract that fires lifecycle events. Worth modeling as an effectctx event contract. |
| **LLM-summarized session results** | We surface raw excerpts; Hermes summarizes each match with an aux model (Gemini Flash). The harness exposes a `summarizer` plug-point — wire one to close the gap. |
| **FTS5-backed session store** | Our `SessionStore` is JSON+naive scoring. Production parity wants SQLite + FTS5; the interface is in place to swap in. |
| **Mixture-of-agents** (`mixture_of_agents_tool.py`) | Specialized; the existing `subagents` extension covers the same shape. |
| **Browser, voice, image-gen, code-execution, MCP-OAuth, email, Discord/Feishu/Yuanbao integrations** | Domain tools, not agent-core architecture. Out of scope. |

## What sits outside the agent

- **The platform gateway** (Telegram/Discord/Slack/...). Receiving inbound messages and routing replies is about *how* `agent.send` is invoked. Each inbound message becomes a `user.message` event; each reply is a side effect of `agent.until`. The gateway is a process wrapping the agent.
- **The cron firing mechanism.** The tool surface for "schedule X" can be an extension; the actual scheduler that fires those schedules calls `agent.send` from outside the agent.
- **Terminal backends** (Docker / SSH / Daytona / Modal). Host adapters behind the same `workspace` extension shape. Pick the right adapter at construction time. This wiring uses `localWorkspace`.

## How the pieces fit

```
            ┌──────────────── log (append-only) ────────────────┐
            │  user.message → assistant.message → tool.result    │
            └────────────────────┬───────────────────────────────┘
                                 │ projects to fragments
                                 ▼
  ambients (recomputed each turn):
    • workspace tree           ← localWorkspace
    • skills catalog           ← dynamicSkills (re-reads disk)
    • user model               ← userModel    (re-reads disk)
    • current todos            ← todos        (re-reads event log)
    • reflection nudge         ← nudge        (reads event log)
                                 │
                                 ▼
                           model context
                                 │
                                 ▼
                  tools the model can call:
                    bash, read_file, write_file, ...    ← localWorkspace
                    load_skill                          ← dynamicSkills
                    save_skill, update_skill            ← learningLoop
                    manage_skill (archive/restore/pin)  ← skillCurator
                    update_user_model, forget_user_model ← userModel
                    todo                                ← todos
                    clarify                             ← clarify
                    spawn_agent (children: read-only)   ← subagents
                    session_search                      ← sessionSearch
                    recall                              ← core
```

Children spawned via `spawn_agent` get a restricted toolset that mirrors Hermes's `DELEGATE_BLOCKED_TOOLS`: no recursive `spawn_agent`, no `clarify`, no `save_skill` / `update_skill`, no `update_user_model`. They DO get read-only `dynamicSkills`, the workspace, todos, and `recall`.

## What we test

`test/scenarios.test.ts` runs thirteen deterministic scenarios with a scripted `infer` (no real LLM). Each scenario is a contract this harness preserves from Hermes:

1. **Catalog freshness** — `save_skill` → next turn's system block lists the new skill.
2. **Cross-session persistence** — Agent A saves skills + user-model entries; Agent B (fresh instance, same store) sees both.
3. **Skill self-improvement** — `load_skill` → `update_skill` → `load_skill` returns the new body, no v1 residue.
4. **Todos: ambient reflects writes** — write list, see it; rewrite, see the new one (event-sourced from log).
5. **Todos: duplicate id rejection** — guards against malformed writes.
6. **Clarify: host callback contract** — tool receives question + choices, host answer flows back as JSON.
7. **Clarify: choice-count guard** — >4 choices is a tool-level error, not a host call.
8. **Subagents: delegation isolation** — child sees the read-only loadout, parent receives only the final summary; the `DELEGATE_BLOCKED_TOOLS` contract is asserted explicitly.
9. **Skill usage telemetry** — `load_skill` bumps view+use counters, `update_skill` bumps patch counter; mirrors `skill_usage.py`.
10. **Curator sweep** — pinned skills survive past the archive threshold; unpinned skills past the threshold get archived.
11. **`manage_skill` lifecycle** — archive removes from catalog, restore brings it back.
12. **Session search** — browse mode (no query) returns recent sessions in time order; query mode ranks matches by hit count and excludes non-matching sessions.
13. **Nudge contract** — fires after N quiet turns, clears after one persist call.

If any of these fail, the harness has drifted from Hermes's shape.

## What this is and isn't

- **Is**: an honest model of Hermes's *agent core* — the learning loop, the user model, the planning surface, the clarify boundary, the delegation isolation contract — composed from independently deletable extensions over an event log. Designed to be the smallest thing that lets you say "this is recognizably Hermes-shaped."
- **Isn't**: proof of equivalence with real Hermes, and not a full port. The "Known gaps" table is the honest list of what we haven't built. Distinguishing this harness from Hermes by feature count alone is easy; by *agent-core architecture*, less so — the shape converges.

## Audit notes — how this folder evolved

The first cut had three extensions (skills loop, user model, nudge) and missed `delegate_task`, `todo_tool`, and `clarify_tool` because we built the feature map from the README's marketing tiles, not the repo. The fix was to read `tools/` and `agent/` in the Hermes source directly. The "Known gaps" table is the honest output of that pass — features present in Hermes that we still haven't reproduced, with a sentence each on why.

If you find another gap, it belongs in that table.
