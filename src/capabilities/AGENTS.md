# Capability development rules

Read the root AGENTS.md, this directory's README, and the [SDK guide](README.md#sdk) before editing
a capability. These rules apply to every package.

- Each direct subdirectory is a build-time capability. Declare contributions with static named re-exports
  in `index.ts`; organize implementation files as needed. Tool, Renderer, and UI modules default-export
  registration functions. Other contributions export objects, arrays, or factories as their contracts
  require. Keep the index declarative and dispatch through registered contributions.
- Import only `#sdk/*`, pinned npm dependencies, and the package's own files. Add a bounded SDK
  contract for a missing host operation, exposing the specific methods the contribution needs.
- Apply runtime constraints to contribution dependency graphs. Shared modules must
  satisfy every consumer's constraints. All package TypeScript must be reachable from its declarations.
- Keep module scope declarative. Register behavior and listeners in entry factories. Communicate across
  Chrome contexts through protocols, and keep Shared modules pure.
- Tools use the supplied Session/run/tab context and AbortSignal. The common runtime validates arguments,
  page permissions, and effects.
- Renderers support update/dispose and offline renderStatic. Summaries are synchronous, pure functions;
  preserve the result protocol. Define structured result types and parsers in the package,
  declare execution return types, and validate `unknown` before rendering. Retain a readable fallback
  for historical or unrecognized results. Interactive views and exports share the same projection.
- UI contributions use `mountTemplate/registerPage/registerSettings/on`, bind listeners to the signal,
  and clean up owned resources with `onDispose`. Check cancellation after awaiting load, save, or restore;
  discard late results after disposal. Prefer `#sdk/sidepanel/settings-form` for ordinary
  settings drafts; the package still owns persistence and copy.
- Use stable, unique IDs in the package's namespace and keep its styles and DOM self-contained.
  Tool replacements explicitly declare
  `replaces: "<original-package>/<same-tool-name>"` and provide the complete execution contract.
  Preserve result compatibility and the existing metadata registration when reusing a renderer.
- Reuse [design-system](../../docs/design-system.md) tokens and `qz-*` controls. Prefer complete static
  `qz:` utilities for template layout. Put complex states, third-party adaptations, and renderer rules
  in the `components` layer of `ui.css`. The build imports the public skin. Check both color schemes
  and offline export.
- Register embedded Skills through `skills` and `#sdk/shared/skill-definition`. The capability owns
  their content, resources, and optional host implementations. Declare hosts separately through
  `skillHosts`. Privileged host bindings require build-time registration. Preserve installed Skill
  manifests, wire/storage formats, tool names, script ABIs, and user history when renaming framework concepts.
- Update the relevant guide when boundaries change. Run related unit tests first, then browser/E2E checks
  appropriate to the runtime. New capabilities must cover failures, cancellation, removal, and fallbacks
  for unknown implementations.
