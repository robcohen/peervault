# PeerVault Release Checklist

## Version Bump

1. Update version in all three files:
   - `package.json` → `"version": "X.Y.Z"`
   - `manifest.json` → `"version": "X.Y.Z"`
   - `versions.json` → add `"X.Y.Z": "1.4.0"` (or the correct `minAppVersion`)

2. Verify versions match:
   ```sh
   grep '"version"' package.json manifest.json
   ```

## Build

```sh
bun run build
```

This runs `esbuild.config.mjs` which:
- Bundles TypeScript → `dist/main.js`
- Copies `manifest.json` → `dist/manifest.json`
- Copies `styles.css` → `dist/styles.css`
- Copies WASM files → `dist/`

Verify the build output:
```sh
ls -la dist/main.js dist/manifest.json dist/styles.css dist/peervault_iroh.js dist/peervault_iroh_bg.wasm
```

## Type Check

```sh
bun run check
```

## Package Tarball

```sh
bun run package
```

This creates `peervault-release.tar.gz` containing:
- `main.js`
- `manifest.json`
- `styles.css`
- `peervault_iroh.js`
- `peervault_iroh_bg.wasm`

Optionally create a versioned copy:
```sh
cp peervault-release.tar.gz peervault-X.Y.Z.tar.gz
```

## Commit & Push

```sh
git add package.json manifest.json versions.json src/ styles.css
git commit -m "Description of changes (vX.Y.Z)"
git push origin main
```

**Do not commit**: `.direnv/`, `dist/`, `*.tar.gz`, `.mcp.json`, `node_modules/`

## GitHub Release

```sh
gh release create vX.Y.Z \
  --title "vX.Y.Z" \
  --notes "Release notes here" \
  dist/main.js dist/manifest.json dist/styles.css
```

The GitHub release must include these three assets for Obsidian community plugins / BRAT:
- `main.js`
- `manifest.json`
- `styles.css`

## BRAT Compatibility

[BRAT](https://github.com/TfTHacker/obsidian42-brat) (Beta Reviewers Auto-update Tester) is how beta users install PeerVault.

BRAT requirements:
- `manifest.json` at repo root with correct `version`
- `versions.json` at repo root mapping every plugin version to its `minAppVersion`
- GitHub release tag matching the version (e.g., `v0.2.11`)
- Release assets: `main.js`, `manifest.json`, `styles.css`

**Common issue**: Forgetting to update `versions.json` causes BRAT to report a manifest version mismatch. Always add the new version entry before releasing.

## Quick Release (Copy-Paste)

Replace `X.Y.Z` and `DESCRIPTION` with actual values:

```sh
# 1. Bump versions (edit these files)
#    package.json, manifest.json, versions.json

# 2. Build and verify
bun run build && bun run check

# 3. Package
bun run package

# 4. Commit and push
git add package.json manifest.json versions.json src/ styles.css
git commit -m "DESCRIPTION (vX.Y.Z)"
git push origin main

# 5. Create GitHub release
gh release create vX.Y.Z \
  --title "vX.Y.Z" \
  --notes "DESCRIPTION" \
  dist/main.js dist/manifest.json dist/styles.css
```
