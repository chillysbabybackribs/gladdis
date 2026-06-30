# Packaging Checklist

This repo now has the first packaging scaffold in place:

- Electron Builder config with Linux installer targets (`AppImage` and `deb`)
- Linux-first GitHub Actions workflow that builds installer artifacts on Ubuntu
- GitHub Release publishing scaffold for tagged Linux builds
- Release checksum publishing scaffold for Linux assets
- Static Linux download page scaffold in `docs/download/`
- `npm run release:doctor` to show what is still missing

Still intentionally open:

- final product name
- final icons and branded installer artwork
- final polished marketing copy and branded download page
- macOS and Windows release/signing work

Before a user-facing launch, tie up these items:

1. Choose the production `GLADDIS_PRODUCT_NAME` and `GLADDIS_APP_ID`.
2. Replace the provisional Linux icon and desktop branding with final artwork.
3. Decide where Linux release artifacts will live:
   - GitHub Releases
   - a download CDN/bucket
   - a product website download endpoint
4. Move the preview download page deployment from the packaging branch to the final release branch flow.
5. Replace placeholder copy and styling with final brand assets once ready.

Deferred until after Linux:

1. Replace the provisional `build/icon.icns` and `build/icon.ico` with final branded assets.
2. Configure Apple notarization secrets:
   - `APPLE_ID`
   - `APPLE_APP_SPECIFIC_PASSWORD`
   - `APPLE_TEAM_ID`
3. Configure Windows signing and reputation work.
