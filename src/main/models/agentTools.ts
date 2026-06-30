/**
 * agentTools — the deterministic tool surface for the LLM agent.
 *
 * This file is the public barrel. The per-domain tool defs live under
 * `agentTools/`:
 *
 *   DRIVE    → blind actions (navigate / click / type / press / cdp).
 *              Return only ack strings; the LLM never sees raw page data.
 *   PERCEIVE → `read_page`, `read_a11y`, `grep_page`; bounded page reads and targeting.
 *              Internally runs PageExtractor, formats through PageDigest.
 *   CAPTURE  → `screenshot`, `screenshot_app`. PNGs returned to the model.
 *   SEARCH   → `search`, `deep_search`, `fetch_page`.
 *   REPO     → `repo_overview`, `repo_grep_task`, `search_repo`, `read_spans`,
 *              `research_dossier`, `verify_change` (CapabilityBroker-backed).
 *   FS       → read_file / write_file / edit_file / list_dir / search_files /
 *              run_validation / publish_changes / run_command / clipboard /
 *              audit_codebase.
 *   MEMORY   → `recall_history` plus the working-memory triplet.
 *
 * Token budget: the old free-form loop could inject 30–100 K tokens per turn
 * through extract_page + screenshot + get_browser_html. This surface caps
 * single-page perception at ~2 600 tokens through PageDigest.
 */

export type {
  AgentToolProfile,
  AgentToolProfileName
} from './agentTools/profiles'
export {
  AGENT_TOOLS,
  isKnownToolGroup,
  isKnownToolName,
  knownToolByName,
  normalizeRequestedGroups,
  normalizeRequestedTools,
  normalizeToolName,
  resolveTurnTools,
  selectAgentToolProfile,
  toolGroupNames
} from './agentTools/profiles'
