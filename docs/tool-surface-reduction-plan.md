# Tool Surface Reduction — Plan

**Goal (user's words):** "heavily reduce the tool set to only the least amount but
most powerful tools we currently have." Aggressive collapse. Optimize for all
three at once: token cost, model confusion, maintenance surface.

**Decision axis:** keep **primitives** (general, composable, one obvious use);
delete **workflows** (the agent loop already does them) and **variants**
(multiple verbs for one job).

---

## Target: ~38 → 16 tools

| Family | Keep | Drop |
|---|---|---|
| Perceive | `grep_page`, `read_a11y`, `watch_network` | `read_page`, `screenshot`, `screenshot_app` |
| Drive | `navigate`, `grep_click`, `grep_type`, `execute_in_browser`, `cdp_command` | `click_xy`, `type_text`, `press_key` |
| Filesystem | `read_file`, `write_file`, `edit_file`, `list_dir`, `search_files` | — |
| Shell | `run_command` (absorbs the rest) | `run_validation`, `publish_changes`, `launch_web_dev_server`, `read_clipboard`, `write_clipboard` |
| Web | `search` (absorbs `search_open`) | `search_open`, `deep_search`, `fetch_page` |
| Repo | — (all deleted) | `repo_overview`, `search_repo`, `repo_grep_task`, `read_spans`, `research_dossier`, `verify_change`, `audit_codebase` |
| Memory | `memory` (6→1, recall folded in) | `memory_{read,write,list,forget,create_task}`, `recall_history` as separate verbs |
| Meta | (retired — see Phase C) | `request_tools` |

Final count: **16** after Phase A+B; **15** after Phase C drops `request_tools`.

---

## Why each cut (the "all of the above" mapping)

- **REPO family** → duplicates `list_dir`/`search_files`/`read_file`
  (maintenance + confusion). Backed by a REAL `CapabilityBroker`, so we
  **un-wire, not delete** the broker (decision: reversible).
- **Workflow tools** (`audit_codebase`, `deep_search`, `research_dossier`,
  `verify_change`) → the agent loop IS the workflow (confusion).
- **FS-extras** → all expressible via `run_command` (maintenance + tokens).
- **SEARCH variants** → `fetch_page` = `navigate` + `grep_page`; `search_open`
  folds into `search` (confusion).
- **DRIVE raw input** (`click_xy`/`type_text`/`press_key`) → `grep_click`/
  `grep_type` are the primary path; `execute_in_browser`/`cdp_command` are the
  fallback that subsumes them (confusion).
- **CAPTURE** → the "nearly irrelevant" vision fallback per CLAUDE.md (tokens).
- **MEMORY 6→1** → one concept, six verbs (tokens + confusion).

---

## Consumer blast radius (smaller than it looks)

All embedded runtimes re-export the single source of truth, so they shrink for free:
- `codex/dynamicBrowserTools.ts`: `CODEX_BROWSER_TOOLS = AGENT_TOOLS`
- `claudeCode/browserTools.ts`: `CLAUDE_CODE_BROWSER_TOOLS = AGENT_TOOLS`, `CURSOR_MCP_TOOLS = AGENT_TOOLS`
- 4 providers: go through `resolveTurnTools(...)`

The only hand-written couplings to fix:
- `browserTools.ts` `run()` switch — prune dropped cases, add collapsed `memory`/`search`.
- `turnContextPolicy.ts` — calls `selectAgentToolProfile` (Phase C).
- `prompts.ts` + `historyTools.ts` — `request_tools` prose/validation (Phase C).
- `toolSurfaceCoverage.test.ts` — expected-name list.

---

## Phase A status (in progress)

Done: trimmed agentTools/* defs; pruned AGENT_TOOLS + profiles + TOOL_GROUPS;
pruned BrowserTools.run() switch; un-wired CapabilityBroker from BrowserTools
(class kept in tree, still used by ChatService auto post-validation hook);
deleted orphaned search impls (runSearchOpenTool/runDeepSearchTool/runFetchPage)
+ their nav helpers; updated Codex/Cursor/Claude allowlists + instruction prose;
updated prompts.ts guidance blocks + GUIDANCE_BITS (dropped Validation/Publish
blocks); re-pointed the OpenAI repo-primer from deleted repo tools to
search_files; fixed all affected tests (3 via parallel agents + the rest inline).

**Finding surfaced, NOT yet acted on — needs a decision:**
`providers/toolValidation.ts` implements auto-validation-after-edit that fires
`verify_change`/`run_validation`. Both are now gone from the model surface, so
`hasValidationTool()` returns false for every provider and the feature is
SILENTLY INERT in production (tests still pass because they inject those tool
defs directly). Repairing it means rewiring auto-validation to fire
`run_command npm run typecheck` after edits — a real cross-provider behavior
change. Flagged to the user rather than silently rewired.

**Left as optional follow-up (inert, all tests green):** dead display-only
branches naming dropped tools in CursorClient.ts result-formatting and the
renderer (ToolRun.tsx, Composer.tsx, ContractTraceLine.tsx).

## Sequencing

### Phase A — surface cut
1. Trim `agentTools/{perceive,drive,fs,search,repo}.ts` defs to the keep-list.
2. Delete `REPO_TOOLS` import/spread from `agentTools/profiles.ts` and barrel.
3. Prune the `run()` dispatch switch in `browserTools.ts` (dropped cases →
   removed; `run_validation`/`publish_changes`/etc. removed).
4. Un-wire CapabilityBroker from the agent surface (leave the class in tree).
5. Fix `toolSurfaceCoverage.test.ts`.
6. `npm run typecheck && npm test` green.

### Phase B — collapse MEMORY 6→1
1. One `memory` ToolDef with `op: read|write|list|forget|create_task|recall`.
2. `run()` `case 'memory'` dispatches on `op` to the existing `memoryStore`
   functions (store fns unchanged — only dispatch changes).
3. Update `historyTools.ts`/coverage test references.

### Phase C — retire the profile system (decided in scope)
1. Replace `selectAgentToolProfile`/`PROFILE_TOOLS`/`resolveTurnTools` with a
   single flat `AGENT_TOOLS` handed to every turn.
2. Delete `request_tools` (`historyTools.ts` runner, def, aliases) and the
   `grantedTools` plumbing in the 4 providers + `browserTools.ts` ctx.
3. Simplify `turnContextPolicy.ts` (drop `profile` field, use flat list).
4. Strip `request_tools` prose from `prompts.ts`.
5. Delete `~250 lines` of normalize/alias/cache plumbing in `profiles.ts`.

**Recommended order:** A → (decide B vs C ordering) → C → B. Rationale: if
profiles are retired (C), MEMORY's token motivation (B) weakens; do C first,
then decide whether B still earns its keep.

---

## Open / to-confirm during execution
- Codex `gladdis.*` dynamic tool naming: confirm collapsed `memory`/`search`
  names round-trip through `dynamicBrowserTools.ts` arg mapping.
- Claude Code MCP bridge: confirm no hard-coded tool name lists beyond
  `AGENT_TOOLS` re-export.
- Any UI that renders tool names (capability event stream for repo_*/dossier)
  — check renderer for dangling references after broker un-wire.
