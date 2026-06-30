const owner = 'chillysbabybackribs'
const repo = 'gladdis'
const releaseStatus = document.getElementById('release-status')
const appImageButton = document.getElementById('download-appimage')
const debButton = document.getElementById('download-deb')

function setButtonState(button, asset) {
  if (!button || !asset) {
    return
  }

  button.href = asset.browser_download_url
  button.removeAttribute('aria-disabled')
  button.classList.remove('button-disabled')
}

function formatPublishedAt(value) {
  if (!value) {
    return 'date unavailable'
  }

  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

async function loadLatestRelease() {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
      {
        headers: {
          Accept: 'application/vnd.github+json'
        }
      }
    )

    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}`)
    }

    const release = await response.json()
    const appImage = release.assets.find((asset) => asset.name.endsWith('.AppImage'))
    const deb = release.assets.find((asset) => asset.name.endsWith('.deb'))

    setButtonState(appImageButton, appImage)
    setButtonState(debButton, deb)

    if (releaseStatus) {
      releaseStatus.textContent = `Latest Linux release: ${release.tag_name} published ${formatPublishedAt(release.published_at)}.`
    }
  } catch (error) {
    if (releaseStatus) {
      releaseStatus.textContent =
        'No published Linux release was found yet. Tagging a release will light up these download buttons.'
    }
    console.error(error)
  }
}

void loadLatestRelease()
