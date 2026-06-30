import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'claude-code-mcp': resolve(__dirname, 'src/main/models/claudeCode/gladdisMcpServer.ts')
        },
        // @lydell/node-pty loads a platform-specific .node binary at runtime
        // (require('@lydell/node-pty-${platform}-${arch}')), which Rollup cannot
        // bundle. Externalize it (and its platform subpackages) so the main
        // process resolves them from node_modules at runtime.
        external: [/^@lydell\/node-pty/]
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared')
      }
    }
  }
})
