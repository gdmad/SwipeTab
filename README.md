# SwipeTab

A Firefox (desktop) extension that controls tabs with mouse and trackpad gestures.

## Gestures

Press the left button, **hold for a quarter second**, then drag and release. The hold
is what tells a gesture apart from text selection.

| Gesture | Action |
|---|---|
| Hold and drag up | Previous tab (wraps around) |
| Hold and drag down | Next tab (wraps around) |
| Hold and drag left | Close the current tab and switch to the tab on its left |
| Hold and drag right | Restore the last closed tab |
| Right-click a link (two-finger click on a trackpad) | Open the link in a new background tab |

Direction is read from the dominant axis, so you don't need to drag perfectly straight.
An offset under 40 px doesn't count as a gesture, so a shaky hand is safe.

Once the hold is registered, a ring with four arrows appears at the cursor and tilts in
3D toward the direction you drag. The arrow and icon for the current direction brighten
and grow as you approach the threshold, while a cancel icon (⊘) at the center fades out
— it's visible whenever no direction is committed yet, and reappears if you drag back
toward the center. Releasing there cancels the gesture. Right-clicking a link pops up a
small badge confirming it opened in a background tab.

Normal page behavior is preserved: clicks on links and buttons still work, a quick
press-and-drag still selects text, and the gesture never triggers inside input fields.

## Context menu on links

Right-clicking a link opens it in a new tab **instead of** the context menu. The menu is
still reachable there via **`Shift` + right-click** — Firefox shows it, bypassing the
`contextmenu` event.

Outside of links, the context menu works as usual.

## Installation

The extension doesn't need a build step or Node — it's plain files.

### Temporary (for development)

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…**
3. Pick `manifest.json` from this repo

Lasts until Firefox restarts.

### Permanent

Build the package from the repo root:

```bash
zip -r -FS swipetab.xpi manifest.json content.js background.js icon.svg
```

From there you have two options.

**Firefox Nightly / Developer Edition / ESR.** Only these builds let you disable
signature verification — on regular Firefox Release the setting is ignored.

1. `about:config` → find `xpinstall.signatures.required` → set to `false`
2. `about:addons` → gear icon → **Install Add-on From File…** → pick `swipetab.xpi`

**Signing via AMO** works on any Firefox, including Release. On
[addons.mozilla.org/developers](https://addons.mozilla.org/developers/addon/submit/distribution),
upload the XPI choosing **"On your own"** distribution (unlisted). This kind of
submission skips manual review: the signed file is issued almost immediately, and can
then be installed via **Install Add-on From File…**.

The extension is deliberately built on **Manifest V2**: under MV3, Firefox doesn't grant
host permissions at install time, and the content script doesn't get injected until the
permission is enabled manually in `about:addons` — for a temporary add-on that would mean
doing it on every browser restart.

## Configuration

There's no settings page — the tunables live at the top of [`content.js`](content.js),
in the "Config" block. Reload the extension in `about:debugging` after editing.

- `HOLD_MS` — how long to hold the button before a gesture starts. The main knob: lower
  is more responsive, but intercepts text selection more often.
- `HOLD_TOLERANCE_PX` — how much the cursor may drift during the hold.
- `GESTURE_MIN_PX` — the boundary between a click and a gesture.
- `SHOW_INDICATOR` — the ring with arrows and action icons.
- `INDICATOR_AT_CURSOR` — show the ring at the cursor (`true`) or centered on the window
  (`false`).
- `ARROW_W` / `ARROW_H` — arrow dimensions.
- `DEBUG` — log the offset and recognized direction to the page console.

To open links directly in the active tab instead of the background, see `FOCUS_NEW_TAB`
in [`background.js`](background.js).

## How it works

A timer starts on left-button-down. If the cursor moves more than `HOLD_TOLERANCE_PX`
before it fires, the gesture is cancelled — the user is selecting text or dragging an
element. Once the hold completes, gesture mode kicks in: `selectstart` and `dragstart`
are suppressed, and on `mouseup` the direction is read from the cursor offset. A gesture
that fires also suppresses the following `click`, otherwise a gesture started on a link
would also navigate to it.

The right button is handled by a single `contextmenu` listener, and only over links.

Gestures used to be recognized from `wheel` events — two-finger swipes without a button.
That was dropped: a sharp swipe is physically indistinguishable from fast scrolling, and
tab switching kept firing accidentally while scrolling long pages. Neither
velocity/magnitude thresholds nor requiring three flicks in a row fixed it. With the
button held down, false positives are impossible by construction.

## Limitations

- Right-clicking a link no longer opens the context menu, see above.
- Gestures don't work on pages Firefox won't inject content scripts into: `about:*`
  (including the new tab page), `view-source:`, the built-in PDF viewer,
  `addons.mozilla.org`.
- A gesture started in one frame and finished in another isn't recognized.
- Dragging elements after the hold doesn't work — that gesture is already taken.
- Gestures are disabled on form fields, sliders (`role="slider"`, `<progress>`,
  `<meter>`) and on the whole of `<video controls>` / `<audio controls>`: native player
  controls can't be told apart from the video itself.
- Scrollbars are detected as a 20 px strip along the edge of the window and of every
  scrollable box, so gestures don't start within that strip either.

## Development

[`test/manual.html`](test/manual.html) is a manual test page: it has scrollbars, form
controls, sliders and media, a live "gesture ring shown/hidden" badge, and an event log.
With the extension loaded, open it in Firefox (a `file://` URL works) and hold the left
button in each zone.

## Structure

```
manifest.json     MV2, content script on all pages
content.js        gesture recognition and the indicator UI
background.js     tab operations via the tabs API
test/manual.html  manual test page
```
