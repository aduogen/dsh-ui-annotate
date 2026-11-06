# dsh-ui-annotate

Point at any UI element — in the built-in browser page or in DSH itself — and turn it into a precise,
selector-anchored change request for your AI agent.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) client plugin.

## Why

Telling an agent "make that button rounder" wastes a turn: it guesses which button, reads the wrong
component, and changes something you did not mean. This plugin removes the guessing. You click the
element you mean; the agent receives its CSS selector, computed styles, bounding box, text, attributes,
and the owning React component name.

## What it does

- **One picker, no mode switch.** Press *Start picking* once. Clicking a browser-page element and
  clicking a DSH-interface element both work in the same session — the click decides which carrier is
  used, not a toggle you have to get right first.
- **Real guest DOM.** Inside the sidebar browser, the picker is injected into the `<webview>` document,
  so selectors and styles come from the actual page rather than from the frame around it.
- **React awareness.** For DSH's own interface it walks the React fiber tree to name the closest owning
  component, plus its source coordinates when the bundle carries them.
- **Two delivery modes.**
  - *One at a time* — a pick lands straight in the composer, optionally auto-sent.
  - *Batch list* — collect several numbered annotations on screen, then send them as one change request.
- **Never eats your words.** Writing uses the composer's `captureInsertion()` + `insertText()` path, so
  text you already typed survives.

Every annotation carries:

| Field | Example |
|---|---|
| Selector | `html > body > div.card:nth-of-type(2) > p.muted` |
| Uniqueness | how many elements that selector matches |
| Box | `83×33 @ (48, 110)` |
| Styles | `background-color: #247bbf; border-radius: 6px; …` |
| Text / attributes / ancestors | quoted, truncated to a sane length |
| Component | `PrimaryButton (src/Button.tsx:12)` |

## Install

```bash
# in the DSH Desktop profile
plugin_manager install_bundle  target=/absolute/path/to/dsh-ui-annotate
```

The bundle links the working directory into the profile, so edits apply on reload. Restart the DSH
process after changing `client.js` — the client module graph is versioned by content hash, and an
already-open page holding the old revision will 404 instead of picking up new bytes.

## Use

1. Click **⌖ Annotate UI** (bottom right).
2. Choose *One at a time* or *Batch list*.
3. Press **Start picking**, then click the element you want changed.
4. Press **Stop picking** or `Esc` to end; in batch mode, press **Send N** when the list is ready.

Nothing reaches an agent until you send, and in one-at-a-time mode nothing sends at all unless
*Send right after picking* is on.

## Requirements

- **DSH `>=0.2.0`** (declared in `engines.dsh`).
- DSH Desktop (the browser carrier is an Electron `<webview>`; the plain Web GUI has no guest document,
  so the picker covers only the DSH interface there).
- No dependencies, no build step, no install scripts.

## Layout

```
client.js         the whole capability: picker, composer bridge, panel
index.js          Host companion (empty apply; the row exists to compose the Client bundle)
cordis.patch.yml  the bundle row
locale/*.json     Plugin Manager metadata
icon.svg          plugin icon
```

## License

MIT