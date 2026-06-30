import { spawn, ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import type { ToolOutcome } from '../browserTools'
import type { TabManager } from '../../TabManager'
import { sleep } from './toolUtils'

export interface DevServerDeps {
  files: { getRoot: () => string | null }
  tabs: TabManager
}

interface RunningServer {
  id: string
  command: string
  cwd: string
  port?: number
  url?: string
  child: ChildProcess
  stdout: string[]
  stderr: string[]
  status: 'starting' | 'running' | 'failed' | 'stopped'
}

// Global registry of running dev servers to persist across tool calls
const activeServers = new Map<string, RunningServer>()

// Cleanup all active processes on main process exit
process.on('exit', () => {
  for (const server of activeServers.values()) {
    try {
      if (server.child.pid) {
        if (process.platform === 'win32') {
          server.child.kill()
        } else {
          process.kill(-server.child.pid, 'SIGKILL')
        }
      }
    } catch (e) {
      // Ignore
    }
  }
})

async function detectDevCommand(resolvedCwd: string): Promise<string | null> {
  const packageJsonPath = path.join(resolvedCwd, 'package.json')
  if (!fs.existsSync(packageJsonPath)) {
    return null
  }
  try {
    const pkg = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf-8'))
    const scripts = pkg.scripts || {}
    
    // Ordered list of preferred scripts
    const scriptKeys = ['dev', 'start', 'serve']
    for (const key of scriptKeys) {
      if (scripts[key]) {
        if (fs.existsSync(path.join(resolvedCwd, 'pnpm-lock.yaml'))) {
          return `pnpm run ${key}`
        } else if (fs.existsSync(path.join(resolvedCwd, 'yarn.lock'))) {
          return `yarn run ${key}`
        } else {
          return `npm run ${key}`
        }
      }
    }
  } catch (err) {
    // Ignore JSON parsing/read errors
  }
  return null
}

async function pollUrl(urlStr: string, timeoutMs: number): Promise<boolean> {
  const startTime = Date.now()
  try {
    const url = new URL(urlStr)
    const client = url.protocol === 'https:' ? https : http
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        const ok = await new Promise<boolean>((resolve) => {
          const req = client.get(urlStr, (res) => {
            // Treat any response (even 404, 500, redirect) as "listening"
            resolve(true)
          })
          req.on('error', () => {
            resolve(false)
          })
          req.setTimeout(800, () => {
            req.destroy()
            resolve(false)
          })
        })
        if (ok) return true
      } catch {
        // Fall through
      }
      await sleep(500)
    }
  } catch {
    return false
  }
  return false
}

export async function runLaunchWebDevServer(
  deps: DevServerDeps,
  args: Record<string, any>
): Promise<ToolOutcome> {
  const action = String(args.action || 'start').toLowerCase()
  const rawCwd = args.cwd ? String(args.cwd) : null
  const root = deps.files.getRoot() || process.cwd()
  const resolvedCwd = rawCwd ? path.resolve(root, rawCwd) : root

  if (action === 'status') {
    if (rawCwd) {
      const server = activeServers.get(resolvedCwd)
      if (!server) {
        return { ok: true, text: `No active dev server registered for: ${resolvedCwd}` }
      }
      const exitCode = server.child.exitCode
      return {
        ok: true,
        text: `Dev Server for directory: ${resolvedCwd}
Command: ${server.command}
Status: ${server.status}${exitCode !== null ? ` (Exited with code ${exitCode})` : ' (Running)'}
URL: ${server.url || 'Not detected yet'}
Port: ${server.port || 'Not detected yet'}

Last 20 log lines:
${server.stdout.slice(-20).join('')}
${server.stderr.slice(-20).join('')}`
      }
    } else {
        if (activeServers.size === 0) {
          return { ok: true, text: 'No active dev servers running.' }
        }
        const lines = Array.from(activeServers.entries()).map(([cwd, s]) => {
          const exitCode = s.child.exitCode
          return `- CWD: ${cwd}\n  Command: ${s.command}\n  Status: ${s.status}${exitCode !== null ? ` (Exit: ${exitCode})` : ''}\n  URL: ${s.url || 'None'}`
        })
        return { ok: true, text: `Active Dev Servers:\n\n${lines.join('\n\n')}` }
    }
  }

  if (action === 'stop') {
    const server = activeServers.get(resolvedCwd)
    if (!server) {
      return { ok: false, text: `No running dev server found for: ${resolvedCwd}` }
    }
    
    try {
      if (server.child.pid) {
        if (process.platform === 'win32') {
          server.child.kill()
        } else {
          process.kill(-server.child.pid, 'SIGKILL')
        }
      }
    } catch (e) {
      // Ignore
    }
    server.status = 'stopped'
    activeServers.delete(resolvedCwd)
    return { ok: true, text: `Stopped dev server for directory: ${resolvedCwd}` }
  }

  // Action is start or restart
  let server = activeServers.get(resolvedCwd)
  if (server && action === 'restart') {
    try {
      if (server.child.pid) {
        if (process.platform === 'win32') {
          server.child.kill()
        } else {
          process.kill(-server.child.pid, 'SIGKILL')
        }
      }
    } catch (e) {
      // Ignore
    }
    activeServers.delete(resolvedCwd)
    server = undefined
  }

  // If already running, check health and return
  if (server && server.child.exitCode === null) {
    if (server.url) {
      const healthy = await pollUrl(server.url, 1500)
      if (healthy) {
        if (args.open_browser !== false) {
          const tab = deps.tabs.create(server.url)
          deps.tabs.switch(tab.id)
          return {
            ok: true,
            text: `Dev server already running at ${server.url} and opened in browser.\nDirectory: ${resolvedCwd}\nCommand: ${server.command}`
          }
        }
        return {
          ok: true,
          text: `Dev server already running at ${server.url}.\nDirectory: ${resolvedCwd}\nCommand: ${server.command}`
        }
      }
    } else {
      return {
        ok: true,
        text: `Dev server process is active, but URL is not yet ready.\nDirectory: ${resolvedCwd}\nCommand: ${server.command}`
      }
    }
  }

  // Determine starting command
  let command = args.command ? String(args.command) : null
  if (!command) {
    command = await detectDevCommand(resolvedCwd)
  }
  if (!command) {
    return {
      ok: false,
      text: `Could not auto-detect a dev or start command in: ${resolvedCwd}. Please specify a command explicitly in the "command" parameter.`
    }
  }

  const port = args.port ? Number(args.port) : undefined
  const explicitUrl = args.url ? String(args.url) : undefined
  const timeoutMs = args.timeout_ms ? Number(args.timeout_ms) : 30000
  const openBrowser = args.open_browser !== false

  // Spawn process
  let child: ChildProcess
  try {
    child = spawn('bash', ['-lc', command], {
      cwd: resolvedCwd,
      env: { ...process.env, FORCE_COLOR: '1' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    return {
      ok: false,
      text: `Failed to spawn process with command "${command}": ${(err as Error)?.message ?? String(err)}`
    }
  }

  const record: RunningServer = {
    id: resolvedCwd,
    command,
    cwd: resolvedCwd,
    port,
    url: explicitUrl,
    child,
    stdout: [],
    stderr: [],
    status: 'starting'
  }
  activeServers.set(resolvedCwd, record)

  let detectedUrl: string | undefined = explicitUrl || undefined
  let detectedPort: number | undefined = port || undefined

  child.stdout?.on('data', (data) => {
    const chunk = data.toString()
    record.stdout.push(chunk)
    if (record.stdout.length > 500) record.stdout.shift()

    if (!detectedUrl) {
      // Best effort to parse localhost URL from stdout
      // Match http://localhost:PORT or http://127.0.0.1:PORT
      const match = chunk.match(/https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):\d+/i)
      if (match) {
        // Canonicalize 0.0.0.0 / [::] to localhost for clean browser navigation
        const rawUrl = match[0]
        detectedUrl = rawUrl.replace(/(0\.0\.0\.0|\[::\])/i, 'localhost')
        record.url = detectedUrl
        
        const portMatch = rawUrl.match(/:(\d+)/)
        if (portMatch) {
          detectedPort = Number(portMatch[1])
          record.port = detectedPort
        }
      }
    }
  })

  child.stderr?.on('data', (data) => {
    const chunk = data.toString()
    record.stderr.push(chunk)
    if (record.stderr.length > 500) record.stderr.shift()
  })

  child.on('exit', (code) => {
    record.status = 'failed'
  })

  // Wait for server to become responsive
  const startWait = Date.now()
  let isReady = false

  while (Date.now() - startWait < timeoutMs) {
    if (child.exitCode !== null) {
      const logs = [...record.stdout, ...record.stderr].join('')
      return {
        ok: false,
        text: `Dev server failed to start or crashed. Exit code: ${child.exitCode}\nLogs:\n${logs}`
      }
    }

    const testUrl = detectedUrl || (detectedPort ? `http://localhost:${detectedPort}/` : null)
    if (testUrl) {
      const responsive = await pollUrl(testUrl, 1000)
      if (responsive) {
        record.url = testUrl
        record.status = 'running'
        isReady = true
        break
      }
    }
    await sleep(500)
  }

  if (!isReady) {
    // If we have an expected URL/port or detected one, but it timed out
    const testUrl = detectedUrl || (detectedPort ? `http://localhost:${detectedPort}/` : null)
    const logs = [...record.stdout, ...record.stderr].join('')
    return {
      ok: false,
      text: `Dev server started but timed out waiting to respond at ${testUrl || 'URL'}.\nCommand: ${command}\nLogs:\n${logs}`
    }
  }

  // Open browser tab if requested
  let browserText = ''
  if (openBrowser && record.url) {
    try {
      const tab = deps.tabs.create(record.url)
      deps.tabs.switch(tab.id)
      browserText = ` Opened browser tab with URL: ${record.url}.`
    } catch (err) {
      browserText = ` Tried to open browser tab with URL: ${record.url} but encountered error: ${(err as Error).message}`
    }
  }

  const shortLogs = [...record.stdout.slice(-10), ...record.stderr.slice(-10)].join('')

  return {
    ok: true,
    text: `Successfully launched web dev server!\nDirectory: ${resolvedCwd}\nCommand: ${command}\nURL: ${record.url}\nPort: ${record.port || 'detected'}${browserText}\n\nLast few log lines:\n${shortLogs}`
  }
}
