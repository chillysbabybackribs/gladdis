import { useEffect, useRef } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import {
  BlockNoteSchema,
  createCodeBlockSpec,
  type Block,
  type PartialBlock
} from '@blocknote/core'
import type { Theme } from '@blocknote/mantine'
import { codeBlockOptions } from '@blocknote/code-block'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'

const GLADDIS_NOTEPAD_THEME: Theme = {
  colors: {
    editor: { text: '#e6e6e6', background: '#1a1a1a' },
    menu: { text: '#e6e6e6', background: '#262626' },
    tooltip: { text: '#e6e6e6', background: '#2d2d2d' },
    hovered: { text: '#e6e6e6', background: '#2d2d2d' },
    selected: { text: '#e6e6e6', background: '#333333' },
    disabled: { text: '#757575', background: '#212121' },
    shadow: 'rgba(0, 0, 0, 0.45)',
    border: '#3a3a3a',
    sideMenu: '#a8a8ac',
    highlights: {
      gray: { text: '#e6e6e6', background: '#3a3a3a' },
      brown: { text: '#e6e6e6', background: '#4a3f35' },
      red: { text: '#e6e6e6', background: '#5c3330' },
      orange: { text: '#e6e6e6', background: '#5c4528' },
      yellow: { text: '#e6e6e6', background: '#5c5128' },
      green: { text: '#e6e6e6', background: '#2f4a35' },
      blue: { text: '#e6e6e6', background: '#2d4a6e' },
      purple: { text: '#e6e6e6', background: '#44355c' },
      pink: { text: '#e6e6e6', background: '#5c3548' }
    }
  },
  borderRadius: 8,
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", system-ui, sans-serif'
}

// Schema overrides BlockNote's default no-op codeBlock with the
// `@blocknote/code-block` shiki-backed version (dark-plus theme + ~50 langs).
// Built once at module load so every tab shares one highlighter promise.
const NOTEPAD_SCHEMA = BlockNoteSchema.create().extend({
  blockSpecs: {
    // @shikijs/types between BlockNote core and the codeBlock package drift by
    // a patch version, runtime is identical; cast away the spurious mismatch.
    // See TypeCellOS/BlockNote#2279.
    codeBlock: createCodeBlockSpec(codeBlockOptions as never)
  }
})

interface Props {
  tabId: string
  initialBlocks: PartialBlock[]
  onChange: (blocks: Block[]) => void
}

/**
 * Per-tab BlockNote editor. The parent re-mounts this by `key={tabId}` so each
 * tab keeps an isolated ProseMirror instance, history stack, and undo state.
 * Save is debounced via `onChange` upstream; we also flush on unmount.
 */
export function NotepadEditor({ tabId, initialBlocks, onChange }: Props) {
  const editor = useCreateBlockNote({
    schema: NOTEPAD_SCHEMA,
    initialContent: initialBlocks.length > 0 ? initialBlocks : undefined,
    // Silence the "Enter text or type '/' for commands" prompts. We want a
    // clean canvas — the slash menu still works, it just isn't advertised.
    placeholders: { default: '', emptyDocument: '' }
  })

  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    const unsubscribe = editor.onChange(() => {
      onChangeRef.current(editor.document)
    })
    return () => {
      unsubscribe()
      // Final flush on unmount so a tab-switch or close persists the last edit.
      onChangeRef.current(editor.document)
    }
  }, [editor])

  return (
    <div className="notepad-editor-wrap" data-tab-id={tabId}>
      <BlockNoteView editor={editor} theme={GLADDIS_NOTEPAD_THEME} sideMenu={false} />
    </div>
  )
}
