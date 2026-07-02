/**
 * @vitest-environment jsdom
 *
 * Real-DOM smoke tests for runSubmit's in-page intent script. The browserTools
 * tests mock the script result; these cases exercise the actual DOM-selection
 * logic so utility buttons like date pickers do not outrank true submitters.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { submitIntentScript } from './driveTools'

function runInPage(payload: string): unknown {
  // eslint-disable-next-line no-new-func
  const fn = new Function(payload)
  return fn.call(globalThis)
}

function stubVisibleLayout() {
  const rect = { left: 10, top: 20, width: 100, height: 30, right: 110, bottom: 50, x: 10, y: 20, toJSON() {} }
  Element.prototype.getBoundingClientRect = () => rect as DOMRect
  if (!Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText')?.get) {
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() {
        return (this as HTMLElement).textContent ?? ''
      }
    })
  }
}

describe('submit intent script (real DOM)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    stubVisibleLayout()
  })

  it('prefers a submit-like action over an earlier utility button in the same form', () => {
    document.body.innerHTML = `
      <form id="contract">
        <input aria-label="Contract Title" value="Q3 Launch Support">
        <button id="pick">Choose Date</button>
        <button id="submit">Submit Contract</button>
      </form>
    `
    const form = document.getElementById('contract') as HTMLFormElement
    form.addEventListener('submit', (event) => event.preventDefault())

    const clicks: string[] = []
    document.getElementById('pick')!.addEventListener('click', () => clicks.push('pick'))
    document.getElementById('submit')!.addEventListener('click', () => clicks.push('submit'))
    ;(form.querySelector('input') as HTMLInputElement).focus()

    const result = runInPage(submitIntentScript()) as { ok: boolean; mode?: string; label?: string }

    expect(result).toMatchObject({ ok: true, mode: 'click', label: 'Submit Contract' })
    expect(clicks).toEqual(['submit'])
  })

  it('falls back to requestSubmit when only utility buttons are present', () => {
    document.body.innerHTML = `
      <form id="search">
        <input aria-label="Start Date" value="07-15-2026">
        <button id="pick">Choose Date</button>
      </form>
    `
    const form = document.getElementById('search') as HTMLFormElement
    const requestSubmit = vi.fn()
    Object.defineProperty(form, 'requestSubmit', {
      configurable: true,
      value: requestSubmit
    })

    const clicks: string[] = []
    document.getElementById('pick')!.addEventListener('click', () => clicks.push('pick'))
    ;(form.querySelector('input') as HTMLInputElement).focus()

    const result = runInPage(submitIntentScript()) as { ok: boolean; mode?: string }

    expect(result).toMatchObject({ ok: true, mode: 'requestSubmit' })
    expect(requestSubmit).toHaveBeenCalledTimes(1)
    expect(clicks).toEqual([])
  })
})
