/**
 * commandSafety — high-signal denylist for `run_command` and `cdp_command`.
 *
 * gladdis trusts the model and the user with full OS access by design. This
 * module does NOT impose a sandbox; it only blocks the small set of patterns
 * that are catastrophic when issued by mistake (typed wrong, hallucinated,
 * prompt-injected from a fetched page) and that a typical workflow should
 * never legitimately need. Power users keep the override env to reinstate
 * full freedom.
 *
 * Three escape hatches:
 *   GLADDIS_ALLOW_DESTRUCTIVE_COMMANDS=1 — disables the run_command denylist
 *   GLADDIS_REQUIRE_SUDO_CONFIRM=1       — refuses sudo until the user clears it
 *   GLADDIS_BLOCK_PIPE_TO_SHELL=1        — refuses curl|sh, wget|bash, etc.
 *   GLADDIS_CDP_ALLOW_UNSAFE=1           — disables the cdp_command method denylist
 */

export interface CommandSafetyConfig {
  requireSudoConfirm: boolean
  blockPipeToShell: boolean
  allowDestructive: boolean
}

export interface CommandSafetyVerdict {
  allowed: boolean
  reason?: string
  hint?: string
}

const ROOT_OR_SYSTEM_TARGET =
  '(?:[\'"]?\\s*\\/[\'"]?(?:\\s|$|;|&|\\|)|\\/\\*|~(?:\\s|$|/)|\\$\\{?HOME\\}?(?:\\s|$|/)|\\/etc(?:\\/|\\b)|\\/usr(?:\\/|\\b)|\\/bin(?:\\/|\\b)|\\/sbin(?:\\/|\\b)|\\/var(?:\\/|\\b)|\\/boot(?:\\/|\\b)|\\/sys(?:\\/|\\b)|\\/proc(?:\\/|\\b)|\\/root(?:\\/|\\b)|\\/lib(?:\\/|\\b)|\\/lib64(?:\\/|\\b)|\\/opt(?:\\/|\\b)|\\/home(?:\\b|\\/?\\s*$))'

const DEVICE_TARGET =
  '\\/dev\\/(?:sd[a-z]\\d*|nvme\\d+n\\d+(?:p\\d+)?|hd[a-z]\\d*|disk\\d+|mmcblk\\d+(?:p\\d+)?|vd[a-z]\\d*|loop\\d+)\\b'

const DESTRUCTIVE_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // rm -rf <root|system|home> — order of -r/-f flags is irrelevant; --no-preserve-root catches the explicit override too.
  {
    pattern: new RegExp(
      `\\brm\\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*|-[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*|--recursive\\s+--force|--force\\s+--recursive|--no-preserve-root)\\b[^|;&]*?\\s${ROOT_OR_SYSTEM_TARGET}`,
      'i'
    ),
    reason: 'recursive force-delete targeting filesystem root, system path, or home'
  },
  // dd writing directly to a block device (overwrites disks)
  {
    pattern: new RegExp(`\\bdd\\b[^|;&]*?\\bof=${DEVICE_TARGET}`, 'i'),
    reason: 'dd writing directly to a block device'
  },
  // mkfs/shred/wipefs targeting a device
  {
    pattern: new RegExp(`\\b(?:mkfs(?:\\.[a-z0-9]+)?|shred|wipefs)\\b[^|;&]*?\\s\\/dev\\/[a-z0-9]+`, 'i'),
    reason: 'filesystem create / wipe targeting a device path'
  },
  // Classic fork bomb
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb' },
  // chmod -R 777 on root/system/home — common bricking move
  {
    pattern: new RegExp(`\\bchmod\\s+-[a-zA-Z]*[rR][a-zA-Z]*\\s+0?777\\s+${ROOT_OR_SYSTEM_TARGET}`, 'i'),
    reason: 'chmod -R 777 on filesystem root, system path, or home'
  },
  // Shell redirect to a disk device
  {
    pattern: new RegExp(`(?:^|[^<])>\\s*${DEVICE_TARGET}`, 'i'),
    reason: 'shell redirect to a disk device'
  },
  // Removing essential system packages (Debian/Ubuntu side; rpm-side is rarer in this app's audience)
  {
    pattern:
      /\b(?:apt|apt-get|dpkg)\s+(?:-y\s+)?(?:purge|remove|--purge|-r|-P)\b[^|;&]*\b(?:ubuntu-(?:desktop|core|standard)|gnome-(?:core|shell)|systemd|libc6|coreutils|bash|grub2?|linux-image-\S+|kernel)\b/i,
    reason: 'package operation removing essential system packages'
  }
]

const PIPE_TO_SHELL = /\b(?:curl|wget|fetch|http)\b[^|;&]*?\|\s*(?:sudo\s+)?(?:sh|bash|zsh|ksh|fish|python\d?|node|ruby|perl|php)\b/i
const SUDO_INVOCATION = /(?:^|\s|;|&&|\|\||\|)\s*sudo(?:\s|$)/

export function readCommandSafetyConfig(env: NodeJS.ProcessEnv = process.env): CommandSafetyConfig {
  return {
    requireSudoConfirm: isTruthy(env.GLADDIS_REQUIRE_SUDO_CONFIRM),
    blockPipeToShell: isTruthy(env.GLADDIS_BLOCK_PIPE_TO_SHELL),
    allowDestructive: isTruthy(env.GLADDIS_ALLOW_DESTRUCTIVE_COMMANDS)
  }
}

/**
 * Decide whether a shell command should be allowed. Returns a verdict that the
 * caller surfaces as a tool-error so the model sees exactly why it was blocked
 * and can self-correct (narrow the path, remove sudo, etc.).
 */
export function classifyCommand(command: string, cfg: CommandSafetyConfig): CommandSafetyVerdict {
  const trimmed = command.trim()
  if (!trimmed) return { allowed: false, reason: 'empty command' }

  if (!cfg.allowDestructive) {
    for (const entry of DESTRUCTIVE_PATTERNS) {
      if (entry.pattern.test(trimmed)) {
        return {
          allowed: false,
          reason: `Blocked: ${entry.reason}.`,
          hint:
            'Narrow the path/target, or set GLADDIS_ALLOW_DESTRUCTIVE_COMMANDS=1 in the environment if you really mean it.'
        }
      }
    }
  }

  if (cfg.blockPipeToShell && PIPE_TO_SHELL.test(trimmed)) {
    return {
      allowed: false,
      reason: 'Blocked: pipe-to-shell from network (e.g. curl … | sh) is gated by GLADDIS_BLOCK_PIPE_TO_SHELL.',
      hint: 'Download the script to a file, inspect it, then execute it explicitly.'
    }
  }

  if (cfg.requireSudoConfirm && SUDO_INVOCATION.test(trimmed)) {
    return {
      allowed: false,
      reason: 'Blocked: sudo is gated by GLADDIS_REQUIRE_SUDO_CONFIRM.',
      hint: 'Run the command yourself in a terminal, or unset the env var to re-enable sudo for this session.'
    }
  }

  return { allowed: true }
}

// ── CDP method gating ────────────────────────────────────────────────────────

/**
 * CDP methods that grant cross-origin/cross-tab capabilities our `cdp_command`
 * tool should not freely hand to the model. This is not exhaustive — it is the
 * "obviously dangerous, never legitimately part of a chat task" set. Override
 * with GLADDIS_CDP_ALLOW_UNSAFE=1 if you genuinely need them.
 */
const CDP_DENIED_METHODS: ReadonlySet<string> = new Set([
  // Cross-origin storage wipes
  'Storage.clearDataForOrigin',
  'Storage.clearCookies',
  'Storage.clearTrustTokens',
  // Forced downloads — could write the page-supplied bytes anywhere on disk
  'Page.setDownloadBehavior',
  'Browser.setDownloadBehavior',
  // Browser-wide window/permission/lifecycle manipulation outside our TabManager
  'Browser.close',
  'Browser.setPermission',
  'Browser.resetPermissions',
  'Browser.grantPermissions',
  'Browser.crash',
  'Browser.crashGpuProcess',
  // Cert overrides — could MITM future TLS traffic
  'Security.setIgnoreCertificateErrors',
  'Security.setOverrideCertificateErrors',
  // Network/Fetch interception lets the agent rewrite arbitrary requests/responses
  'Network.setRequestInterception',
  'Fetch.enable',
  // Target manipulation outside our TabManager
  'Target.closeTarget',
  'Target.disposeBrowserContext',
  'Target.createBrowserContext'
])

export interface CdpSafetyVerdict {
  allowed: boolean
  reason?: string
}

export function classifyCdpCommand(method: string, env: NodeJS.ProcessEnv = process.env): CdpSafetyVerdict {
  const trimmed = method.trim()
  if (!trimmed) return { allowed: false, reason: 'empty method' }
  if (isTruthy(env.GLADDIS_CDP_ALLOW_UNSAFE)) return { allowed: true }
  if (CDP_DENIED_METHODS.has(trimmed)) {
    return {
      allowed: false,
      reason: `Blocked: ${trimmed} is on the high-risk CDP method list. Set GLADDIS_CDP_ALLOW_UNSAFE=1 to override.`
    }
  }
  return { allowed: true }
}

function isTruthy(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(value ?? '')
}
