import { memo, useMemo } from 'react'
import { renderMarkdown } from '../../lib/markdown'

/**
 * Markdown is the per-token hot path during streaming: marked.parse +
 * DOMPurify.sanitize re-run the WHOLE accumulated message on every render,
 * and that cost grows with message length. Isolating each text block behind
 * React.memo means a render only re-parses the block whose `text` actually
 * changed — finished messages and unchanged blocks cost ~0 while a new
 * bubble streams in.
 */
export const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
})
