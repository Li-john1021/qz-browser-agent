# Capability example

Copy `example/` to `src/capabilities/<your-name>/`, run `npm run dev`, and reload the Chrome
extension. The build discovers `index.ts` automatically. The test harness also builds this fixture
in isolation.

Keep only the contributions and dependencies you need. When removing an index declaration, also
remove unused TypeScript files. Rename stable tool, Skill, Provider, Renderer, page, and template
IDs, along with the `example` and `example-model` message namespaces, to avoid conflicts. Import the
framework through `#sdk/*` and package files through relative `.js` paths.

| Learn how to | Start here |
| --- | --- |
| Define a tool and typed results | [table-tool.ts](table-tool.ts), [result.ts](result.ts) |
| Render an interactive card and offline export | [value-card.ts](value-card.ts) |
| Add pages, settings, and draft saves | [ui.ts](ui.ts), [ui.html](ui.html), [ui.css](ui.css) |
| Translate messages and model descriptions | [messages.ts](messages.ts), [model-messages.ts](model-messages.ts) |
| Implement a local deterministic provider and authentication | [deterministic-provider.ts](deterministic-provider.ts), [presets.ts](presets.ts) |
| Supply context and observe run events | [context-and-observer.ts](context-and-observer.ts) |
| Parse documents and embed Skills | [json-document-codec.ts](json-document-codec.ts), [skills.ts](skills.ts) |

The [capability guide](../../../../src/capabilities/README.md) covers registration, SDK boundaries,
and extension development. In this example, tools and renderers share `result.ts` and parse unknown
results before displaying them. `ui.ts` uses `createSettingsForm` to separate the submitted snapshot
from later edits. Templates, images, and `srcset` use package-relative paths; styles reuse the
[design system](../../../../docs/design-system.md).

## Test the example

```bash
npm test -- playwright extension-example.spec.mjs --workers 1
npm run typecheck
```

The first command builds this fixture in isolated source and tests its tool, interactive card,
settings saves, provider, context, documents, disposal and remounting, and export. It uses synthetic
data and a local provider. Use
[extension-example.spec.mjs](../../../browser/extension-example.spec.mjs) as a starting point for
your own package's integration tests. `typecheck` checks capabilities and dependency boundaries in
the actual source tree.

## Record the demo

[`tool-renderer-example.gif`](../../../../docs/images/tool-renderer-example.gif) was recorded from
the Chrome test above using only this package's synthetic data. To record it again:

```bash
QINGZHOU_RECORD_DEMO=1 npm test -- playwright tests/browser/extension-example.spec.mjs --workers=1
```

Playwright saves `video.webm` under `tests/results/playwright/`. Convert it to a GIF at 8 fps and
760 px wide with palettegen/paletteuse. Check that the card is expanded and its result changes from
12 to 24 before replacing the public recording.
