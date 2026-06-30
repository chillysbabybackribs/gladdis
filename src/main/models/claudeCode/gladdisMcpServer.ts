import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { CLAUDE_CODE_BROWSER_TOOL_NAMES, CLAUDE_CODE_BROWSER_TOOLS } from './browserTools'

const BRIDGE_URL = process.env.GLADDIS_CLAUDE_BRIDGE_URL
const BRIDGE_TOKEN = process.env.GLADDIS_CLAUDE_BRIDGE_TOKEN

const GUARDRAIL_GUIDANCE =
  'Use the Gladdis MCP tools for browser work: search, fetch_page, navigate, browse_task, read_page, ' +
  'grep_page, grep_click, grep_type, screenshot, or screenshot_app. ' +
  'Never use native shell/CLI browser commands (google-chrome, chromium, playwright, puppeteer, xdg-open on URLs, ' +
  'curl/wget against localhost:9222) — they bypass Gladdis and the user cannot see them.'

async function main(): Promise<void> {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) {
    throw new Error('Missing Claude Code bridge environment')
  }

  const server = new Server(
    { name: 'gladdis-browser-tools', version: '1.0.0' },
    { capabilities: { tools: { listChanged: false } } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: CLAUDE_CODE_BROWSER_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name
    if (!CLAUDE_CODE_BROWSER_TOOL_NAMES.has(toolName)) {
      return {
        content: [{ type: 'text' as const, text: `Unknown Gladdis tool "${toolName}". ${GUARDRAIL_GUIDANCE}` }],
        isError: true
      }
    }
    const response = await fetch(`${BRIDGE_URL}/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: BRIDGE_TOKEN,
        name: toolName,
        arguments: request.params.arguments ?? {}
      })
    })
    const payload = await response.json() as {
      ok?: boolean
      text?: string
      imageBase64?: string | null
    }
    return {
      content: [
        ...(payload.text ? [{ type: 'text' as const, text: payload.text }] : []),
        ...(payload.imageBase64
          ? [{
              type: 'image' as const,
              data: payload.imageBase64,
              mimeType: 'image/png'
            }]
          : [])
      ],
      isError: payload.ok === false
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  process.stderr.write(`[gladdis-mcp] ${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exit(1)
})
