import { parentPort, workerData } from 'worker_threads'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

interface SearchTask {
  query: string
  root: string
  options?: {
    include?: string
    exclude?: string
    contextLines?: number
    maxResults?: number
    fileType?: string
  }
}

if (parentPort) {
  parentPort.on('message', async (task: SearchTask) => {
    try {
      const args = buildRipgrepArgs(task)
      const { stdout } = await execFileAsync('rg', args, {
        maxBuffer: 10 * 1024 * 1024,
        cwd: task.root
      })
      parentPort!.postMessage({ success: true, data: stdout })
    } catch (err: any) {
      parentPort!.postMessage({ success: false, error: err.message || String(err) })
    }
  })
}

function buildRipgrepArgs(task: SearchTask): string[] {
  const args = ['--json', '--line-number', '--column', '--no-heading', '--with-filename']
  const opts = task.options || {}
  if (opts.contextLines) args.push('-B', String(opts.contextLines), '-A', String(opts.contextLines))
  if (opts.include) args.push('--glob', opts.include)
  if (opts.exclude) args.push('--glob', '!' + opts.exclude)
  if (opts.fileType) args.push('--type', opts.fileType)
  args.push(task.query, '.')
  return args
}
