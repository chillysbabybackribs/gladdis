# Packaging Checklist

This repo now has the first packaging scaffold in place:

- Electron Builder config with Linux installer targets (`AppImage` and `deb`)
- Linux-first GitHub Actions workflow that builds installer artifacts on Ubuntu
- `npm run release:doctor` to show what is still missing

Still intentionally open:

- final product name
- final icons and branded installer artwork
- public download/marketing page
- macOS and Windows release/signing work

Before a user-facing launch, tie up these items:

1. Choose the production `GLADDIS_PRODUCT_NAME` and `GLADDIS_APP_ID`.
2. Add `build/icon.png` for polished Linux packaging.
3. Decide where Linux release artifacts will live:
   - GitHub Releases
   - a download CDN/bucket
   - a product website download endpoint
4. Add the final download page once branding and naming are set.

Deferred until after Linux:

1. Add `build/icon.icns` and `build/icon.ico`.
2. Configure Apple notarization secrets:
   - `APPLE_ID`
   - `APPLE_APP_SPECIFIC_PASSWORD`
   - `APPLE_TEAM_ID`
3. Configure Windows signing and reputation work.
