# SwipeTab — Firefox extension for trackpad gesture tab control

## Project
- Firefox-only Manifest V2 extension (gecko id `swipetab@evgeny.local`, min FF 115).
- No build step, no dependencies — plain JS loaded directly by the browser.
- Source files: `content.js` (gesture detection + bubble indicator), `background.js` (tab operations), `manifest.json`, `icon.svg`.
- Entry point: `manifest.json` → content script injects `content.js` on `<all_urls>`; `background.js` runs as event page.

## Commands
```bash
# Package for distribution (from project root):
zip -r -FS swipetab.xpi manifest.json content.js background.js icon.svg

# Load extension for dev — open about:debugging#/runtime/this-firefox, pick manifest.json

# JS syntax smoke-test (macOS, jsc available):
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -e '
  const window={matchMedia:()=>({matches:false,addEventListener(){}}),addEventListener(){},innerWidth:0,innerHeight:0,getSelection:()=>({removeAllRanges(){}})};
  const browser={runtime:{sendMessage:()=>Promise.resolve()}};
  load("content.js");
  print("OK");
'
```

## Architecture
- **`content.js`** (~540 LOC, IIFE) — the core. Left-button hold-then-swipe gesture recogniser with a visual bubble indicator.
  - Constants block at the top: timing thresholds, dimensions, debug flag, theme palettes, icon definitions.
  - `THEMES.dark` / `THEMES.light` — ring palette selected by `prefers-color-scheme` media query.
  - `buildUi()` constructs a fixed-position bubble (ring + arrows + action icons) appended to `document.body`.
  - Icons are rendered OUTSIDE the ring (82px from center, ring radius 62px) → sit directly on page background. Dual-tone (dark outline + light core) — no longer depend on `prefers-color-scheme`.
  - Right-click on links opens them in background tab; context menu suppressed for links (Shift+right-click bypasses).
- **`background.js`** (~60 LOC) — event page handling `browser.runtime.onMessage`: `switchTab`, `closeTab`, `undoCloseTab`, `openLink`.
- **`manifest.json`** — permissions: `tabs`, `sessions`, `<all_urls>`.

## Conventions
- Comments and UI strings in English.
- AVOID: trailing semicolons on `function` declarations; REQUIRE: semicolons on statement expressions and `const`/`let` assignments.
- `(IIFE)` closure: `(() => { ... })();`.
- Constants grouped at file top under a `// ── Config ──` block.
- `content.js` is the fat file (~540 LOC); `background.js` is thin (~60 LOC). Keep this ratio — content logic stays in `content.js`.
- Bubble theming: ring + arrows use `THEMES[DARK_MQ.matches ? "dark" : "light"]` from `window.matchMedia("(prefers-color-scheme: dark)")`. Icons are THEME-INDEPENDENT (dual-tone — `ICON_OUTLINE`/`ICON_CORE` in `content.js`).
- Tweakables are constants at the top of `content.js`, not a settings page.

