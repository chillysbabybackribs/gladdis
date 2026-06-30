# Linux Distribution Strategy

This document turns the current Linux packaging scaffold into a launch path that feels professional to users.

## Current state

- GitHub Actions builds Linux `AppImage` and `.deb` artifacts for tagged releases.
- GitHub Releases publishes those artifacts plus `SHA256SUMS.txt`.
- GitHub Pages serves a lightweight download page that points to the latest Linux release.

That is enough for preview distribution, but it is not yet the full "official product channel" experience.

## Recommended rollout order

### Phase 1: Official direct download

Keep the current release flow, but make it look canonical:

1. Put the download page on a product-owned domain.
2. Keep GitHub Releases as the artifact origin for now.
3. Treat the download page as the public entrypoint rather than linking users straight to GitHub.
4. Publish checksums and install instructions for every release.

Recommended domain split:

- primary site: `gladys.example`
- downloads page: `download.gladys.example`

This gives us a clean public URL now without forcing package-repository work too early.

### Phase 2: Signed package repository

Once Linux releases are stable, add an APT repository so Debian and Ubuntu users can install and update Gladys through their package manager.

Why this matters:

- it feels more official than downloading a raw `.deb`
- users get package-manager updates
- APT shows repository trust based on the repository signing key and signed `Release` metadata

Recommended domain:

- APT repository: `apt.gladys.example`

Minimum pieces:

1. A repository host:
   - managed: Cloudsmith or packagecloud
   - self-hosted: `aptly` or `reprepro` on object storage/CDN or a small server
2. A dedicated GPG signing key for the APT repository
3. An install snippet that places the key in `/etc/apt/keyrings/`
4. Signed `InRelease` / `Release.gpg` metadata

### Phase 3: Broader Linux channels

After the direct-download and APT path are solid:

1. Flathub for cross-distro reach
2. Snap only if we decide Canonical's store channel is worth the extra maintenance and user tradeoffs

## Channel guidance

### GitHub Releases

Best for:

- immediate shipping
- private/internal previews
- early adopters

Tradeoffs:

- the download host looks more developer-facing than product-facing
- no package-manager install/update story by itself

### APT repository

Best for:

- Debian and Ubuntu users
- "curl the official setup command and install" workflows
- polished update delivery

Tradeoffs:

- repository signing and metadata need real maintenance
- distro/version compatibility becomes a product commitment

### Flathub

Best for:

- discoverability across many Linux distros
- sandboxed install path users already recognize

Tradeoffs:

- packaging review and Flatpak-specific maintenance
- permission model and sandbox behavior may need app-specific work

### Snap

Best for:

- Ubuntu-centric users
- auto-update behavior through the Snap Store

Tradeoffs:

- some Linux users avoid Snap on principle
- another store workflow and packaging surface to maintain

### AppImage direct download

Best for:

- portable installs
- users on distros outside our first package-manager target

Tradeoffs:

- it still feels like "download a binary"
- it is convenient, but not the most trust-rich install path

## What "professional" means on Linux

Unlike macOS and Windows, Linux trust is less about one vendor warning dialog and more about consistent official channels:

- a product-owned HTTPS domain
- package metadata that looks intentional
- signed repository metadata for package-manager installs
- clear install commands
- predictable updates

For Gladys, the fastest professional path is:

1. polished `download.` page
2. stable GitHub-backed artifacts
3. signed APT repository
4. optional Flathub submission

## Repo decisions still open

Before we build the APT path, decide these:

1. Canonical public domain:
   - `gladys.example`
2. Download subdomain:
   - `download.gladys.example`
3. Package-repo subdomain:
   - `apt.gladys.example`
4. Repository host:
   - Cloudsmith
   - packagecloud
   - self-hosted `aptly`
   - self-hosted `reprepro`
5. Whether we want Flathub in the first public Linux wave

## Recommended next implementation step

If we want the cleanest next move with the least risk:

1. lock the final domain names
2. point the download page at the chosen `download.` subdomain
3. keep shipping AppImage + `.deb` through GitHub Releases
4. add an APT repository once we have a stable release cadence
