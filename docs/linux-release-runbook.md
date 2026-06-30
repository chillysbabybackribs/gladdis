# Linux Release Runbook

Use this flow while Gladys is Linux-first.

## Download page

- GitHub Pages is configured for workflow-based deployment.
- The download page workflow currently deploys from:
  - `main`
  - `grep-page-reliability` for packaging preview work

When this branch is pushed, GitHub Actions can publish the current `docs/download/` scaffold to:

- `https://chillysbabybackribs.github.io/gladdis/`

## Publishing a Linux release

Use the helper script to cut a tag from a known clean commit instead of whatever uncommitted app work is in the tree:

```bash
node scripts/publish-linux-release.cjs --commit 2e2dff9 --tag v0.1.0 --push
```

What it does:

- verifies the target commit exists
- refuses to reuse an existing local or remote tag
- creates an annotated tag
- optionally pushes the tag to `origin`

Once the tag is pushed, the `Release Linux Packages` GitHub Actions workflow will:

- build the Linux `AppImage`
- build the Linux `.deb`
- generate `SHA256SUMS.txt` for the published Linux artifacts
- upload those artifacts to the GitHub release

## Current caveat

The package metadata, icons, and download-page copy are still scaffold-grade. This flow is ready for packaging and delivery plumbing, but not yet for a polished public launch.
