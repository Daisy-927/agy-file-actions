# Changelog

All notable changes to `agy-file-actions` are documented in this file.

## [0.1.2] - 2026-11-25

### Fixed
- Fixed the broken `"信任此文件，启用脚本与联网"` action in the sandboxed HTML/SVG preview window caused by double quotes inside an inline `onclick` attribute (`scripts/preview-server.mjs`).

### Security
- Blocked Windows UNC network paths (`\\host\share`, `//host/share`), extended/device namespace paths (`\\?\`, `\\.\`), and remote `file://host/...` URIs from being resolved or opened (`scripts/windows-file-ops.mjs`, `scripts/agy-file-actions-overlay.js`).
- Extracted the sandboxed HTTP preview server into `scripts/preview-server.mjs` and wired `scripts/runtime-injector.mjs` (`previewInBrowser`) to open sandboxed preview URLs instead of raw HTML/SVG files directly; added `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and wrapper CSP headers.
- Hardened `sidecars/panel/server.mjs` with `fs.realpathSync.native()` root containment checks (preventing symlink/junction escapes), `Content-Security-Policy` (`frame-ancestors`), `X-Content-Type-Options: nosniff`, and `X-AGY-FA-Token` enforcement on `GET /api/status` and `GET /api/settings` (updated `sidecars/panel/ui.html` accordingly).
- Fixed `install.ps1` loader path escaping via `ConvertTo-Json` so paths containing apostrophes generate valid JavaScript, and removed the unused HTTP `/api/rpc` fallback branch in `scripts/agy-file-actions-overlay.js`.

## [0.1.1] - 2026-11-25

### Security
- Removed unused `/api/rpc` HTTP route and `Access-Control-Allow-Origin: *` headers from the Sidecar panel server (`sidecars/panel/server.mjs`).
- Added strict loopback `Host`, `Sec-Fetch-Site`, `Origin`, and per-session `X-AGY-FA-Token` CSRF validation (`crypto.timingSafeEqual`) on Sidecar API endpoints, plus workspace/brain root containment checks on `/api/action`.
- Eliminated `cmd.exe /c start` shell invocation in fallback file opening (`sidecars/panel/server.mjs`, `scripts/runtime-injector.mjs`), replacing it with direct `explorer.exe` invocation to prevent command injection from special characters in file paths.
- Updated `readJsonBody` to explicitly reject oversized payloads (> 1 MiB) with `413 Payload Too Large` and malformed JSON with `400`.
- Upgraded preview server token comparison in `scripts/electron-overlay-loader.cjs` to `crypto.timingSafeEqual`.

### Changed
- Replaced the 1.5s `setInterval` polling loop for `settings.json` in `scripts/electron-overlay-loader.cjs` with debounced `fs.watch`.
- Verified compatibility with Google Antigravity `2.35.1` on Windows.

## [0.1.0] - 2026-11-25

### Added
- Initial Windows release of `agy-file-actions` ported from `jidekaixin2dian/dsh-file-actions` (MIT) and written by Gemini 4 Hydrogen.
- Codex/DSH-style right-click context menu for chat `file:///` links (with `#L` line ranges), inline `<code>` references, chips, images, and web links.
- Electron main-process overlay loader (`resources/app/index.cjs`), sandboxed browser preview window, Windows Registry application discovery, Sidecar settings panel, and CDP fallback injector.
