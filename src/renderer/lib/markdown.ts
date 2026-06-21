import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: true })

/**
 * Render markdown to sanitized HTML. Used for streamed assistant output, so it
 * must tolerate partial/incomplete markdown on every keystroke. Sanitizing is
 * mandatory — model output is untrusted and rendered into the renderer DOM.
 */
export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false }) as string
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel']
  })
}
