const owner = 'chillysbabybackribs'
const repo = 'gladdis'
const releaseStatus = document.getElementById('release-status')
const appImageButton = document.getElementById('download-appimage')
const debButton = document.getElementById('download-deb')
const checksumButton = document.getElementById('download-checksums')
const checksumStatus = document.getElementById('checksum-status')
const verifyCommand = document.getElementById('verify-command')
const appImageCommand = document.getElementById('appimage-command')
const debCommand = document.getElementById('deb-command')

function setButtonState(button, asset) {
  if (!button || !asset) {
    return
  }

  button.href = asset.browser_download_url
  button.removeAttribute('aria-disabled')
  button.classList.remove('button-disabled')
}

function setCommandText(element, text) {
  if (!element) {
    return
  }

  element.textContent = text
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

function setReleaseCommands(appImage, deb, checksums) {
  const checksumName = checksums?.name || 'SHA256SUMS.txt'
  const appImageName = appImage?.name || 'Gladys-*.AppImage'
  const debName = deb?.name || 'Gladys-*.deb'

  setCommandText(
    verifyCommand,
    `sha256sum -c ${checksumName} --ignore-missing`
  )
  setCommandText(
    appImageCommand,
    `chmod +x ${appImageName} && ./${appImageName}`
  )
  setCommandText(debCommand, `sudo apt install ./${debName}`)
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
    const checksums = release.assets.find((asset) => asset.name === 'SHA256SUMS.txt')

    setButtonState(appImageButton, appImage)
    setButtonState(debButton, deb)
    setButtonState(checksumButton, checksums)
    setReleaseCommands(appImage, deb, checksums)

    if (releaseStatus) {
      releaseStatus.textContent = `Latest Linux release: ${release.tag_name} published ${formatPublishedAt(release.published_at)}.`
    }

    if (checksumStatus) {
      checksumStatus.textContent = checksums
        ? 'Release checksums are published alongside the Linux installers.'
        : 'This release does not include a checksum bundle yet.'
    }
  } catch (error) {
    if (releaseStatus) {
      releaseStatus.textContent =
        'No published Linux release was found yet. Tagging a release will light up these download buttons.'
    }
    if (checksumStatus) {
      checksumStatus.textContent =
        'Checksums will appear here once a Linux release has been published.'
    }
    console.error(error)
  }
}

void loadLatestRelease()
