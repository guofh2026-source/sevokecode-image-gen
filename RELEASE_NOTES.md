# Sevokecode Image Gen v1.8.2

This patch restores forward compatibility for previously downloaded v1.8.0
DMG installers while keeping the stable native entrypoint introduced in v1.8.1.

## Fixed

- Let v1.8.0 Intel and Apple Silicon DMG installers launch the current package
  they fetch from the latest formal Gitee Release.
- Keep `bin/sevokecode-image-gen` as the only executable copied into the installed
  Skill, so Codex still cannot infer or select a CPU architecture.
- Remove obsolete architecture-named executables during upgrades.
- Preserve the existing API key, output directory, permission behavior, and
  single-process/single-request image lifecycle.

## Compatibility model

- Current DMGs launch the stable package entrypoint.
- Release ZIPs include one matching architecture-named symlink solely for
  v1.8.0 DMGs that dynamically consume Gitee Latest.
- The symlink runs the same native binary and installs only the stable
  entrypoint; it does not add a wrapper process or an API request.

## Verification

- New-installer and v1.8.0-installer entrypoints both install the same package.
- Final installed `bin` contains only `sevokecode-image-gen`.
- Packaged generation and multipart editing E2E continue to run through the
  stable entrypoint on Apple Silicon and Intel.
