/**
 * agentTools — the deterministic tool surface for the LLM agent.
 *
 * This file is the public barrel. The per-domain tool defs live under
 * `agentTools/`:
 *
 *   DRIVE    → blind actions (navigate / grep_click / grep_type /
 *              execute_in_browser / cdp_command).
 *              Return only ack strings; the LLM never sees raw page data.
 *   PERCEIVE → `grep_page`, `read_a11y`, `watch_network`; bounded page reads and targeting.
 *   SEARCH   → `search` (with navigate_visible to also load the best hit).
 *   FS       → read_file / write_file / edit_file / list_dir / search_files /
 *              run_command.
 *   MEMORY   → `recall_history` plus the working-memory triplet.
 *
 * Token budget: the old free-form loop could inject 30–100 K tokens per turn
 * through extract_page + screenshot + get_browser_html. This surface keeps the
 * tool set lean and perception bounded.
 */

export {
  AGENT_TOOLS,
  isKnownToolName,
  knownToolByName,
  normalizeToolName
} from './agentTools/profiles'
