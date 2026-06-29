# Gladdis Agent Builder Blueprint

Date: 2026-06-29

## Goal
Design an upgraded agent creation flow for the header `Agents` dropdown that does more than rewrite a prompt. The builder should let a user describe what they want, then run a deep optimization pass that uses the best available model to discover the optimal execution process for the current workspace, and finally save a reviewable blueprint with the distilled findings.

## What “done” means
1. The blueprint clearly distinguishes between the current behavior and the proposed behavior.
2. The blueprint defines the new optimize flow, including quick vs deep optimize.
3. The blueprint lists the exact artifact shape that should be saved for review.
4. The blueprint calls out risks, guardrails, and rollout suggestions.

## Live repo facts observed
- `shared/agents.ts` now extends `SavedAgent`, `OptimizeAgentInput`, `OptimizeAgentResult`, and `ChatAgentSelection` with a shared blueprint shape (`goal`, tool lists, workflow metadata, assumptions, etc.).
- `shared/api.ts` describes `agents.optimize` as a blueprint distillation flow and includes quick vs deep mode.
- `src/main/models/ChatService.ts` optimizer now:
  - accepts `optimizationMode: 'quick' | 'deep'`
  - gathers richer workspace evidence in deep mode (`repoOverview`, `searchRepo`, `readSpans`, `researchDossier`)
  - validates optimizer JSON and emits `validationNotes` when schema checks fail
  - injects saved blueprint metadata into the runtime agent system block
  - applies per-agent tool constraints (`preferredTools`, `disallowedTools`) before each agent turn
  - resolves optimizer/runtime model preference from a mode-specific ranking and only selects provider-usable models
- `src/main/models/AgentStore.ts` persists the new blueprint fields with normalization.
- `src/renderer/components/AgentBuilderModal.tsx` surfaces quick/deep optimization and persists validation notes.
- `src/renderer/components/ChatPanel.tsx` prefers `runtimeModelId` from the selected agent when choosing model.

## Current-state summary
The builder now behaves as a lightweight distillation system:
- user supplies a rough goal
- optimizer can run quick or deep evidence modes
- result includes structured blueprint fields beyond prompt + test task
- custom agents can constrain runtime tool profile from preferred/disallowed tool lists.
- remaining work now is mostly polish:
  - add cross-mode compare UI (quick vs deep outputs)

## Proposed product direction

### Core idea
When the user creates an agent from the `Agents` dropdown:
1. They enter what they want the agent to do.
2. They can click **Optimize**.
3. Optimize should run a real discovery pass using the strongest available model, preferring a top coding/exploration model when available.
4. The optimizer should inspect the workspace and identify the real process:
   - relevant files and directories
   - commands and validation steps
   - required tools
   - useful sequencing
   - stable repo conventions
   - unnecessary noise to omit
5. The system then distills that into a compact reusable blueprint.
6. The user reviews the blueprint before saving.

### Why this is better
The main value is not better wording. It is removing rediscovery work:
- searching for the right files every time
- rediscovering the right tools
- rediscovering validation commands
- re-deriving task sequencing
- re-loading repo conventions

The saved agent should capture durable process knowledge, not just a nicer prompt.

## Recommended optimize modes

### 1. Quick Optimize
Low-cost prompt improvement only.
Use when the user wants a faster result and doesn’t need deep workspace discovery.

### 2. Deep Optimize
Full exploration + distillation.
Use the best available model to inspect the workspace and derive the optimal process.
This should be the default for serious agent creation.

## Suggested deep optimize workflow
1. Gather the user’s rough goal.
2. Select the best available optimizer model.
3. Inspect workspace context and any relevant app/browser state.
4. Discover:
   - candidate file paths
   - tool requirements
   - commands
   - verification strategy
   - likely failure modes
   - scope boundaries
5. Distill the findings into a blueprint artifact.
6. Present the artifact for review.
7. Save only after the user confirms.

## Blueprint artifact shape
The saved output should evolve from a single prompt into a structured agent blueprint.

Recommended fields:
- `name`
- `goal`
- `optimizerModelId`
- `runtimeModelId`
- `roughPrompt`
- `prompt`
- `taskFamily`
- `workspaceBound` (boolean)
- `preferredTools`
- `disallowedTools`
- `knownPaths`
- `knownCommands`
- `workflowSteps`
- `verificationSteps`
- `stopConditions`
- `fallbackRules`
- `assumptions`
- `testTasks`
- `optimizationSummary`
- `evidenceNotes`

## What should be stripped out
The optimizer should remove repeated discovery noise from the final prompt/blueprint, such as:
- “find the repo root”
- “figure out where components live”
- “search for package manager”
- “discover test/build commands”
- “choose tools from scratch each run”

If these are stable facts, they belong in the blueprint, not in every execution.

## Tool policy recommendation
The optimized agent should have only the tools it truly needs.

Examples:
- filesystem: usually required for repo tasks
- shell: required if the task changes or validates code
- browser: only when the task touches UI behavior or live pages
- research/web: only if the task needs external information
- memory: only when the agent should persist or recall durable task facts

The builder should surface tool choices explicitly so the user can edit them.

## File path policy recommendation
If the optimizer discovers relevant paths, they should be preserved in the blueprint.

Examples:
- key component folders
- state/store files
- command entrypoints
- test config files
- scripts or docs that define conventions

Prefer:
- “check these paths first”
- “these are the canonical locations for this task family”

Avoid hard-coding a single path unless the agent is intentionally workspace-specific.

## Verification policy recommendation
Every optimized agent should include a success definition.

At minimum, capture:
- what counts as done
- how to verify it
- what command or browser state to check
- what signals indicate failure

This is especially important in Gladdis because the app can verify with browser, filesystem, and shell access.

## UX suggestions for the modal
### Suggested flow states
- Draft goal
- Choose optimize depth: Quick or Deep
- Optimize run in progress
- Review blueprint
- Save agent

### Suggested review sections
- Summary
- Tools
- Paths
- Workflow
- Verification
- Notes / assumptions
- Final prompt

### Suggested labels
Instead of “Optimize Prompt,” consider:
- Discover Best Process
- Deep Optimize
- Derive Expert Agent
- Optimize from Workspace

## Key risks
1. **Brittleness**
   - Too many hard-coded paths or assumptions could make the agent fragile.
2. **Cost / latency**
   - Deep optimization will use more model time and may require more steps.
3. **False confidence**
   - The optimizer may infer facts that should be marked as assumptions.
4. **Over-pruning**
   - Stripping noise is good, but the agent still needs enough context to recover when the workspace changes.

## Guardrails
- Show evidence for discovered paths, commands, and tools.
- Separate confirmed facts from assumptions.
- Keep the blueprint reviewable, with generated discovery fields treated as defaults unless the user makes explicit edits.
- Support both workspace-bound and portable agents.
- Allow the user to fall back to quick optimize.

## Recommended rollout
### MVP
- Add deep optimize as a non-destructive review step.
- Save a structured blueprint alongside the prompt.
- Keep current prompt-based behavior available.

### V2
- Add eval cases / test tasks.
- Add workflow steps and verification rules.
- Surface discovered tool-policy and execution metadata for review before save.

### V3
- Add optimization from successful transcripts.
- Add agent versioning and comparisons.
- Add reuse across workspaces.

## Strategic takeaway
Gladdis should evolve from a prompt editor into a task distillation system.
The differentiator is: the agent is optimized from the real workspace and then saved as a compact operating blueprint.

## Implementation status note
Status by slice:
- **Slice 1 (contract + storage)**: complete
- **Slice 2 (optimize depth)**: complete
- **Slice 3 (tool-policy + runtime tuning)**: complete
  - done: tool constraints, runtime model preference, metadata in system prompt, model ranking with provider availability checks

## Slice plan
### Slice 1: Contract and storage
- ✅ Extend shared contract types for `OptimizeAgentResult`, `SaveAgentInput`, `SavedAgent`, and `ChatAgentSelection` to include structured blueprint fields.
- ✅ Update persistence so those fields are stored with agents and round-tripped unchanged.
- ✅ Update optimizer JSON parsing to read those optional fields safely.
- ✅ Include blueprint metadata in custom-agent system context without changing the current modal UX.

### Slice 2: Optimize depth
- ✅ Add explicit quick vs deep optimize pathways.
- ✅ Replace `repoOverview`-only evidence with richer workspace discovery for deep mode.
- ✅ Add explicit schema checks for optimizer output and surface validation notes.

### Slice 3: Tool-policy + runtime tuning
- ✅ Build tool-profile constraints from saved blueprint fields.
- ✅ Add tool-level override rules for preferred/disallowed tools.
- ✅ Add runtime model preference field support (`runtimeModelId`) in runtime model selection.
- ✅ Add mode-specific optimizer/runtime model ranking and provider availability checks.

### Slice 4: Runtime blueprint UX
- ✅ Expose structured fields in the modal as a review-only generated blueprint:
  - `goal`, `taskFamily`, `workspaceBound`
  - model IDs, preferred/disallowed tools, paths, commands
  - workflow / verification / assumptions / stop conditions / fallback / test tasks / evidence notes
  - `optimizationSummary` and prompt task fields
- ✅ Add validation and parse coverage for edge cases in `optimizeAgent` outputs and tool policy application.

### Slice 5: UX polish + visibility
- Add compare controls for quick vs deep optimizer output.
- Improve optimization-feedback visibility (fallback explanation, richer diff helpers).
- Add quick-edit affordances around compare outputs before save.

## Slice 3 implementation note
- Optimizer ranking now checks provider keys first (OpenAI/Gemini/Anthropic/Grok) and requires Codex `installed && authenticated` for Codex IDs before use.
- `optimizeAgent` returns:
  - `modelId` as the actually resolved optimizer model,
  - `optimizerModelId` / `runtimeModelId` defaulted to the resolved model unless explicitly overridden by JSON.

## Current implementation checks to verify next
- open `src/renderer/components/AgentBuilderModal.tsx` and quickly sanity-check modal state around fallback notice and generated-blueprint summary panel.
- verify `window.gladdis.agents.save` continues to serialize `blueprintMetadata` as the source of truth for saved agent fields.

## Next step recommendation
Next implementation sequence:
1. Slice 5: quick vs deep compare surface and richer diff/selection UX.
2. Optional: compact the expanded modal form for high-frequency editing workflows.
