# Themes

Use a theme to provide the shared tokens, controls, and utilities for the Side Panel. The default
implementation is in [default/index.css](default/index.css). Every theme preserves the public token,
`qz-*`, `qz:`, and DOM contracts in the [design system guide](../../docs/design-system.md).

Select a theme at build time by changing the first import in
[sidepanel.css](../sidepanel/sidepanel.css) to the theme's `index.css`, then rebuild. See [Select a
theme](../../docs/design-system.md#select-a-theme) for an example.

Feature and capability CSS stays with its owning module. The build combines those styles with the
selected theme into `sidepanel/sidepanel.css`; the Side Panel and HTML exports use that complete
skin.
