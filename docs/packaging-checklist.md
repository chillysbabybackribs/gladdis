# Packaging Checklist

This repo now has the first packaging scaffold in place:

- Electron Builder config with installer targets for macOS, Windows, and Linux
- macOS notarization hook
- GitHub Actions workflow that builds platform installers
- `npm run release:doctor` to show what is still missing

Still intentionally open:

- final product name
- final icons and branded installer artwork
- public download/marketing page
- production signing certificates and secrets

Before a user-facing launch, tie up these items:

1. Choose the production `GLADDIS_PRODUCT_NAME` and `GLADDIS_APP_ID`.
2. Add `build/icon.icns`, `build/icon.ico`, and `build/icon.png`.
3. Configure Apple notarization secrets:
   - `APPLE_ID`
   - `APPLE_APP_SPECIFIC_PASSWORD`
   - `APPLE_TEAM_ID`
4. Configure Windows signing secrets:
   - `WIN_CSC_LINK`
   - `WIN_CSC_KEY_PASSWORD`
5. Decide where release artifacts will live:
   - GitHub Releases
   - a download CDN/bucket
   - a product website download endpoint
6. Add the final download page once branding and naming are set.
