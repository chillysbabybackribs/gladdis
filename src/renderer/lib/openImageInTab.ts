function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildImageViewerHtml(imageSrc: string, title = 'Image viewer'): string {
  const safeTitle = escapeHtml(title)
  const safeImageSrc = escapeHtml(imageSrc)
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${safeTitle}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg-app: #181818;
        --bg-panel: #1c1c1c;
        --bg-surface: #212121;
        --bg-elevated: #262626;
        --border-subtle: #2b2b2b;
        --border-faint: rgba(255, 255, 255, 0.05);
        --text-primary: #e6e6e6;
        --text-secondary: #a8a8ac;
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        margin: 0;
        width: 100%;
        height: 100%;
        background: var(--bg-app);
        color: var(--text-primary);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', system-ui, sans-serif;
      }

      body {
        display: grid;
        grid-template-rows: auto 1fr;
      }

      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 14px;
        border-bottom: 1px solid var(--border-subtle);
        background: color-mix(in srgb, var(--bg-panel) 92%, black 8%);
      }

      .meta {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }

      .title {
        font-size: 13px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .hint {
        font-size: 12px;
        color: var(--text-secondary);
      }

      main {
        display: grid;
        place-items: center;
        overflow: auto;
        padding: 20px;
        background:
          radial-gradient(circle at top, rgba(255, 255, 255, 0.03), transparent 45%),
          var(--bg-app);
      }

      img {
        display: block;
        max-width: 100%;
        height: auto;
        object-fit: contain;
        background: var(--bg-surface);
        border: 1px solid var(--border-faint);
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.38);
        border-radius: 12px;
      }
    </style>
  </head>
  <body>
    <header>
      <div class="meta">
        <div class="title">${safeTitle}</div>
        <div class="hint">Right click the image to save or copy it.</div>
      </div>
    </header>
    <main>
      <img src="${safeImageSrc}" alt="${safeTitle}" />
    </main>
  </body>
</html>`
}

export async function openImageInTab(imageSrc: string, title = 'Image viewer'): Promise<void> {
  const html = buildImageViewerHtml(imageSrc, title)
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
  await window.gladdis.tabs.create(url)
}
