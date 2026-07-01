import { describe, expect, it } from 'vitest'
import { buildToolCalibrationBlock } from './toolCalibration'

describe('buildToolCalibrationBlock', () => {
  it('only names attached browser action tools', () => {
    const block = buildToolCalibrationBlock({
      toolNames: ['search', 'navigate', 'grep_page', 'read_a11y', 'set_field'],
      workspaceRoot: '/tmp/project',
      tabId: 'tab-1'
    })

    expect(block).toContain('start from navigate()/set_field() results before deeper reads')
    expect(block).not.toContain('open_result()')
    expect(block).not.toContain('act()')
    expect(block).not.toContain('retry act with a fresh ref/query')
  })
})
