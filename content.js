(() => {
  // ── Config ──────────────────────────────────────────────────────────────────
  // How long to hold the button still before gesture recognition starts.
  // This is what separates a gesture from text selection: a quick press-and-drag
  // still selects normally.
  const HOLD_MS = 250;
  // How far the cursor may drift during the hold without cancelling it.
  const HOLD_TOLERANCE_PX = 8;
  // Minimum cursor travel that counts as a gesture, separating it from a shaky click.
  const GESTURE_MIN_PX = 40;

  const SHOW_INDICATOR = true;
  // Where to show the indicator: at the cursor, or centered on the window.
  const INDICATOR_AT_CURSOR = true;
  // Arrow size: wide and squat.
  const ARROW_W = 28;
  const ARROW_H = 12;
  // Log the offset and recognized direction to the console instead of acting.
  const DEBUG = false;

  // Hold feedback: a progress ring shows up after this delay (so plain clicks stay
  // clean) and fills until the gesture arms.
  const PROGRESS_DELAY_MS = 70;
  // Keep the ring fully inside the window when pressed near an edge (prototype).
  const CLAMP_TO_VIEWPORT = true;
  const CLAMP_MARGIN_PX = 100;
  // Ring extras; each one can be switched off on its own.
  // A dot inside the ring that follows the cursor with a springy limit.
  const PUCK = true;
  // A dashed circle at the threshold distance plus a tether from the center.
  const THRESHOLD_GUIDE = true;
  // A soft glow over the whole 90° sector of the current direction.
  const SECTOR_GLOW = true;
  // A distinct finishing animation per action instead of one shared pulse.
  const ACTION_ANIM = true;
  // Extra lead the other axis needs to take over near a diagonal (0 = off).
  const AXIS_HYSTERESIS = 0.15;
  // ────────────────────────────────────────────────────────────────────────────

  const LEFT_BUTTON = 0;
  // Wide enough for a classic scrollbar (15-17px) and an overlay one.
  const SCROLLBAR_PX = 20;
  // Elements that handle drags themselves.
  const EDITABLE =
    "input, textarea, select, [contenteditable], " +
    "[role=slider], [role=scrollbar], [role=progressbar], " +
    "video[controls], audio[controls], progress, meter";

  let pending = null;
  let armed = null;
  let holdTimer = 0;
  let suppressClick = false;
  let progressTimer = 0;
  let progressShown = false;
  let crossed = false;
  let currentAxis = null;

  function linkUnder(target) {
    const el = target instanceof Element ? target : target?.parentElement;
    const anchor = el?.closest?.("a[href]");
    if (!anchor) return null;
    try {
      return /^https?:$/.test(new URL(anchor.href).protocol) ? anchor.href : null;
    } catch {
      return null;
    }
  }

  function isEditable(target) {
    const el = target instanceof Element ? target : target?.parentElement;
    return Boolean(el?.closest?.(EDITABLE));
  }

  // Overlay scrollbars take no layout space and Firefox doesn't expose them to
  // content, so scrollbars are detected by a fixed-width strip along the edge of
  // every scrollable box instead of by geometry.
  function inScrollEdge(event, box, el) {
    const style = el === document.documentElement ? null : getComputedStyle(el);
    const scrolls = (overflow) => !style || /auto|scroll|overlay/.test(overflow);

    const vertical =
      el.scrollHeight > el.clientHeight &&
      scrolls(style?.overflowY) &&
      event.clientX >= box.right - SCROLLBAR_PX;
    const horizontal =
      el.scrollWidth > el.clientWidth &&
      scrolls(style?.overflowX) &&
      event.clientY >= box.bottom - SCROLLBAR_PX;

    return vertical || horizontal;
  }

  function isOnScrollbar(event) {
    const root = document.documentElement;
    const viewport = { right: window.innerWidth, bottom: window.innerHeight };
    if (inScrollEdge(event, viewport, root)) return true;

    let el = event.target instanceof Element ? event.target : null;
    for (; el && el !== root && el !== document.body; el = el.parentElement) {
      if (inScrollEdge(event, el.getBoundingClientRect(), el)) return true;
    }
    return false;
  }

  function send(type, payload) {
    browser.runtime.sendMessage({ type, ...payload }).catch(() => {});
  }

  let pressTarget = null;

  // Only a scroll of the document or of the pressed element's ancestors means a scrollbar drag;
  // unrelated scrolling elsewhere on the page must not cancel the gesture.
  function onScroll(event) {
    const t = event.target;
    if (t === document || (t instanceof Node && pressTarget && t.contains(pressTarget))) reset();
  }

  function reset() {
    clearTimeout(holdTimer);
    clearTimeout(progressTimer);
    if (armed || progressShown) hideRing();
    pending = null;
    armed = null;
  }

  function onMouseDown(event) {
    if (event.button !== LEFT_BUTTON || isEditable(event.target) || isOnScrollbar(event)) return;

    reset();
    pressTarget = event.target;
    pending = { x: event.clientX, y: event.clientY };
    holdTimer = setTimeout(arm, HOLD_MS);
    progressTimer = setTimeout(() => pending && startProgress(pending.x, pending.y), PROGRESS_DELAY_MS);
  }

  function arm() {
    if (!pending) return;

    clearTimeout(progressTimer);
    armed = pending;
    pending = null;
    crossed = false;
    currentAxis = null;
    // Keep the selection when the hold started on it, so selected text can still be
    // grabbed; clear it otherwise, since the gesture would leave it half-extended.
    const selection = window.getSelection();
    if (selection && !pointInSelection(armed.x, armed.y, selection)) selection.removeAllRanges();
    showRing(armed.x, armed.y);
  }

  function pointInSelection(x, y, selection) {
    for (let i = 0; i < selection.rangeCount; i++) {
      for (const r of selection.getRangeAt(i).getClientRects()) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
      }
    }
    return false;
  }

  // Dominant axis of movement — ignores the threshold, used only for highlighting.
  function axisOf(dx, dy) {
    let vertical = Math.abs(dy) >= Math.abs(dx);
    if (AXIS_HYSTERESIS && currentAxis) {
      // Stay on the current axis until the other one leads by a clear margin.
      const wasVertical = currentAxis === "up" || currentAxis === "down";
      const [kept, other] = wasVertical ? [Math.abs(dy), Math.abs(dx)] : [Math.abs(dx), Math.abs(dy)];
      const switches = other > kept * (1 + AXIS_HYSTERESIS);
      vertical = wasVertical !== switches;
    }
    if (vertical) return dy < 0 ? "up" : "down";
    return dx < 0 ? "left" : "right";
  }

  // Gesture direction from cursor offset; null while the offset is below threshold.
  function directionOf(dx, dy) {
    if (Math.hypot(dx, dy) < GESTURE_MIN_PX) return null;
    return axisOf(dx, dy);
  }

  function onMouseMove(event) {
    if (pending) {
      const dx = event.clientX - pending.x;
      const dy = event.clientY - pending.y;
      // Movement before the hold completes means text selection or a drag.
      if (Math.hypot(dx, dy) > HOLD_TOLERANCE_PX) reset();
      return;
    }

    if (!armed) return;
    updateVisual(event.clientX - armed.x, event.clientY - armed.y);
  }

  function onMouseUp(event) {
    if (event.button !== LEFT_BUTTON) return;

    const gesture = armed;
    reset();
    if (!gesture) return;

    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    const direction = directionOf(dx, dy);

    if (DEBUG) console.debug("SwipeTab", { dx: Math.round(dx), dy: Math.round(dy), direction });

    if (!direction) {
      hideRing();
      return;
    }

    suppressClick = true;
    resolveRing(direction);

    if (direction === "up" || direction === "down") {
      send("switchTab", { dir: direction === "up" ? -1 : 1 });
      return;
    }

    send(direction === "left" ? "closeTab" : "undoCloseTab", {});
  }

  // The right button (two-finger click on a trackpad) is only handled over links.
  // Elsewhere we stay out of the way, so the context menu behaves as usual. Over a
  // link the menu is still reachable via Shift+right-click: Firefox shows it,
  // bypassing the contextmenu event.
  function onContextMenu(event) {
    const url = linkUnder(event.target);
    if (!url) return;

    event.preventDefault();
    send("openLink", { url });
    flashOpenLink(event.clientX, event.clientY);
  }

  function onSelectStart(event) {
    if (armed) event.preventDefault();
  }

  function onDragStart(event) {
    if (armed) event.preventDefault();
  }

  function onClick(event) {
    if (!suppressClick) return;

    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }

  // ── Indicator ───────────────────────────────────────────────────────────────
  // A ring with arrows at the cursor: shows that a gesture is armed and highlights
  // the direction before the button is released — you can see what's about to happen.

  // One triangle geometry, rotated four ways.
  const ARROWS = {
    up: { x: 0, y: -38, rotate: 0 },
    right: { x: 38, y: 0, rotate: 90 },
    down: { x: 0, y: 38, rotate: 180 },
    left: { x: -38, y: 0, rotate: 270 }
  };

  // Palettes for the browser's dark and light themes. Switched by subscribing to
  // prefers-color-scheme; the bubble is fully rebuilt when the theme changes.
  const THEMES = {
    dark: {
      ringBg: "rgba(18,18,20,.72)",
      ringBorder: "rgba(255,255,255,.14)",
      ringShadow: "0 6px 24px rgba(0,0,0,.32)",
      accent: "rgb(255,255,255)",
      dim: "rgba(255,255,255,.34)"
    },
    light: {
      ringBg: "rgba(250,250,252,.8)",
      ringBorder: "rgba(0,0,0,.12)",
      ringShadow: "0 6px 24px rgba(0,0,0,.22)",
      accent: "rgb(20,20,24)",
      dim: "rgba(20,20,24,.34)"
    }
  };

  const accentWithAlpha = (c, a) => c.replace(")", `,${a})`);

  // Icons are drawn as two layers: a dark outline under a light stroke. This
  // "cut out" look reads on any background — a light stroke shows on dark pages,
  // a dark outline on light ones — so icons are independent of the browser's
  // prefers-color-scheme and don't get lost when the page theme doesn't match it.
  const ICON_OUTLINE = "rgb(26,28,32)";
  const ICON_CORE = "rgb(255,255,255)";
  const ICON_OUTLINE_WIDTH = 3.4;
  const ICON_CORE_WIDTH = 1.7;
  // Idle icons sit right on the page, so they must stay readable on mid-gray backgrounds.
  const ICON_IDLE_ALPHA = 0.62;

  // Icon geometry, shared by both layers.
  const ICON_PATHS = {
    tab: '<rect x="3" y="4" width="18" height="16" rx="3"/><line x1="3" y1="8" x2="21" y2="8"/>',
    close:
      '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
    restore:
      '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/>',
    // Circle with a slash — "nothing will happen here", for the safe zone at ring center.
    cancel: '<circle cx="12" cy="12" r="7"/><line x1="7" y1="17" x2="17" y2="7"/>',
    // Arrow escaping a box — the standard "open link" glyph.
    open:
      '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>'
  };

  function dualToneIcon(paths) {
    const layer = (stroke, width) =>
      `<g fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${paths}</g>`;
    return (
      '<svg viewBox="0 0 24 24" width="20" height="20">' +
      layer(ICON_OUTLINE, ICON_OUTLINE_WIDTH) +
      layer(ICON_CORE, ICON_CORE_WIDTH) +
      "</svg>"
    );
  }

  // Which icon goes with which direction: up/down — tab, left — close, right — restore.
  const ICONS_MAP = {
    up: dualToneIcon(ICON_PATHS.tab),
    down: dualToneIcon(ICON_PATHS.tab),
    left: dualToneIcon(ICON_PATHS.close),
    right: dualToneIcon(ICON_PATHS.restore)
  };

  const ICON_POS = {
    up:    { x: 0, y: -82 },
    right: { x: 82, y: 0 },
    down:  { x: 0, y: 82 },
    left:  { x: -82, y: 0 }
  };

  const ARC_LEN = (2 * Math.PI * 58).toFixed(1);
  const PUCK_MAX_PX = GESTURE_MIN_PX + 12;
  const DARK_MQ = window.matchMedia("(prefers-color-scheme: dark)");

  let ui = null;
  let hideTimer = 0;
  let activeDirection = null;

  function buildUi() {
    const theme = THEMES[DARK_MQ.matches ? "dark" : "light"];
    // The host stays a plain page-level element (position, opacity, z-index); the visuals
    // live in a closed shadow root so site CSS (div {...}, svg {...}, * {...}) can't leak in.
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;opacity:0;perspective:300px;display:block";
    const root = wrap.attachShadow({ mode: "closed" });

    const ring = document.createElement("div");
    ring.style.cssText = [
      "position:absolute",
      "left:-62px",
      "top:-62px",
      "width:124px",
      "height:124px",
      "border-radius:50%",
      `background:${theme.ringBg}`,
      `border:1px solid ${theme.ringBorder}`,
      `box-shadow:${theme.ringShadow}`,
      "transition:transform .08s linear"
    ].join(";");

    const accentSoft = accentWithAlpha(theme.accent, 0.4);
    let glow = null;
    if (SECTOR_GLOW) {
      glow = document.createElement("div");
      glow.style.cssText =
        "position:absolute;inset:0;border-radius:50%;opacity:0;transition:opacity .1s";
      ring.appendChild(glow);
    }

    let guideLine = null;
    if (THRESHOLD_GUIDE) {
      const holder = document.createElement("div");
      holder.innerHTML =
        '<svg viewBox="-62 -62 124 124" width="124" height="124" style="position:absolute;left:0;top:0">' +
        `<circle r="${GESTURE_MIN_PX}" fill="none" stroke="${theme.dim}" stroke-width="1.2" stroke-dasharray="3 4"/>` +
        `<line x1="0" y1="0" x2="0" y2="0" stroke="${accentSoft}" stroke-width="1.5" stroke-linecap="round"/>` +
        "</svg>";
      ring.appendChild(holder.firstElementChild);
      guideLine = ring.lastElementChild.querySelector("line");
    }

    let puck = null;
    if (PUCK) {
      puck = document.createElement("div");
      puck.style.cssText = [
        "position:absolute",
        "left:50%",
        "top:50%",
        "width:8px",
        "height:8px",
        "margin:-4px 0 0 -4px",
        "border-radius:50%",
        `background:${theme.accent}`,
        `box-shadow:0 0 0 1.5px rgba(0,0,0,.45),0 0 8px ${accentSoft}`,
        "transition:scale .1s"
      ].join(";");
      ring.appendChild(puck);
    }

    const arrows = {};
    for (const dir of Object.keys(ARROWS)) {
      const arrow = document.createElement("div");
      arrow.style.cssText = [
        "position:absolute",
        "left:50%",
        "top:50%",
        "width:0",
        "height:0",
        `border-left:${ARROW_W / 2}px solid transparent`,
        `border-right:${ARROW_W / 2}px solid transparent`,
        `border-bottom:${ARROW_H}px solid ${theme.dim}`,
        "transition:border-bottom-color .1s,transform .1s"
      ].join(";");
      ring.appendChild(arrow);
      arrows[dir] = arrow;
    }

    const icons = {};
    for (const [dir, pos] of Object.entries(ICON_POS)) {
      const iconWrap = document.createElement("div");
      iconWrap.innerHTML = ICONS_MAP[dir];
      const svg = iconWrap.firstElementChild;
      svg.style.cssText = [
        "position:absolute",
        "left:50%",
        "top:50%",
        "margin-left:-10px",
        "margin-top:-10px",
        `transform:translate(${pos.x}px,${pos.y}px)`,
        `opacity:${ICON_IDLE_ALPHA}`,
        "transition:opacity .1s,transform .1s"
      ].join(";");
      ring.appendChild(svg);
      icons[dir] = svg;
    }

    const cancelWrap = document.createElement("div");
    cancelWrap.innerHTML = dualToneIcon(ICON_PATHS.cancel);
    const cancelIcon = cancelWrap.firstElementChild;
    cancelIcon.style.cssText = [
      "position:absolute",
      "left:50%",
      "top:50%",
      "margin-left:-10px",
      "margin-top:-10px",
      "transition:opacity .1s,transform .1s"
    ].join(";");
    ring.appendChild(cancelIcon);

    // Link-open confirmation badge — a separate element from the gesture ring
    // (smaller, instant), so it doesn't collide with the ring's own animation.
    const confirm = document.createElement("div");
    confirm.style.cssText = [
      "position:absolute",
      "left:-28px",
      "top:-28px",
      "width:56px",
      "height:56px",
      "border-radius:50%",
      `background:${theme.ringBg}`,
      `border:1px solid ${theme.ringBorder}`,
      `box-shadow:${theme.ringShadow}`,
      "display:flex;align-items:center;justify-content:center",
      "opacity:0"
    ].join(";");
    confirm.innerHTML = dualToneIcon(ICON_PATHS.open);

    // Hold-progress ring: same geometry as the ring, so the hand-over is seamless.
    const progress = document.createElement("div");
    progress.style.cssText = [
      "position:absolute",
      "left:-62px",
      "top:-62px",
      "width:124px",
      "height:124px",
      "border-radius:50%",
      `background:${theme.ringBg}`,
      `border:1px solid ${theme.ringBorder}`,
      `box-shadow:${theme.ringShadow}`,
      "opacity:0"
    ].join(";");
    progress.innerHTML =
      '<svg viewBox="0 0 124 124" width="124" height="124" style="position:absolute;left:0;top:0">' +
      `<circle cx="62" cy="62" r="58" fill="none" stroke="${theme.accent}" stroke-width="3" stroke-linecap="round" ` +
      `stroke-dasharray="${ARC_LEN}" stroke-dashoffset="${ARC_LEN}" transform="rotate(-90 62 62)"/>` +
      "</svg>";
    const progressArc = progress.querySelector("circle");

    root.append(progress, ring, confirm);
    (document.body || document.documentElement).appendChild(wrap);

    return { wrap, root, ring, arrows, icons, cancelIcon, confirm, progress, progressArc, glow, guideLine, puck, glowAxis: null };
  }

  function ensureUi() {
    if (!ui || !ui.wrap.isConnected) ui = buildUi();
    return ui;
  }

  // Pulls the ring center inside the window; the gesture itself is still measured
  // from the press point, the puck shows the offset relative to the ring center.
  function clampCenter(v, size) {
    const lo = Math.min(CLAMP_MARGIN_PX, size / 2);
    const hi = Math.max(size - CLAMP_MARGIN_PX, size / 2);
    return Math.min(Math.max(v, lo), hi);
  }

  function placeAt(x, y, clamp = false) {
    const { wrap } = ensureUi();
    if (INDICATOR_AT_CURSOR) {
      const fit = clamp && CLAMP_TO_VIEWPORT;
      wrap.style.left = `${fit ? clampCenter(x, window.innerWidth) : x}px`;
      wrap.style.top = `${fit ? clampCenter(y, window.innerHeight) : y}px`;
    } else {
      wrap.style.left = `${window.innerWidth / 2}px`;
      wrap.style.top = `${window.innerHeight / 2}px`;
    }
    return ui;
  }

  function currentTheme() {
    return THEMES[DARK_MQ.matches ? "dark" : "light"];
  }

  function startProgress(x, y) {
    if (!SHOW_INDICATOR) return;

    clearTimeout(hideTimer);
    const { wrap, ring, confirm, progress, progressArc } = placeAt(x, y, true);
    ring.style.opacity = "0";
    confirm.style.opacity = "0";
    progress.style.opacity = "1";
    wrap.style.opacity = "1";
    progressShown = true;

    const duration = Math.max(HOLD_MS - PROGRESS_DELAY_MS, 1);
    progress.animate(
      [
        { transform: "scale(.32)", opacity: 0.4 },
        { transform: "scale(1)", opacity: 1 }
      ],
      { duration, easing: "ease-out", fill: "both" }
    );
    progressArc.animate(
      [{ strokeDashoffset: `${ARC_LEN}px` }, { strokeDashoffset: "0px" }],
      { duration, easing: "linear", fill: "both" }
    );
  }

  function stopProgress() {
    progressShown = false;
    if (!ui) return;

    ui.progress.getAnimations().forEach((a) => a.cancel());
    ui.progressArc.getAnimations().forEach((a) => a.cancel());
    ui.progress.style.opacity = "0";
  }

  function showRing(x, y) {
    if (!SHOW_INDICATOR) return;

    clearTimeout(hideTimer);

    const { wrap, ring, confirm, arrows } = placeAt(x, y, true);
    stopProgress();
    ring.style.opacity = "1";
    // The link-open badge lives in the same wrap — hide it so it can't leak into a gesture.
    confirm.style.opacity = "0";
    // Sentinel, not null: otherwise highlight(null) would see no change and skip
    // clearing the highlight left over from a previous gesture.
    activeDirection = undefined;
    highlight(null);

    // "Click" into gesture mode: overshoot, an outline flash, arrows bursting outward.
    wrap.style.opacity = "1";
    wrap.animate(
      [
        { opacity: 0.4, transform: "scale(.6)" },
        { opacity: 1, transform: "scale(1.08)", offset: 0.6 },
        { opacity: 1, transform: "scale(1)" }
      ],
      { duration: 230, easing: "ease-out" }
    );
    const theme = currentTheme();
    ring.animate(
      [
        {
          borderColor: theme.accent,
          boxShadow: `0 0 0 5px ${accentWithAlpha(theme.accent, 0.35)}, ${theme.ringShadow}`
        },
        { borderColor: theme.ringBorder, boxShadow: theme.ringShadow }
      ],
      { duration: 380, easing: "ease-out" }
    );
    for (const dir of Object.keys(arrows)) {
      arrows[dir].animate(
        [{ transform: arrowTransform(dir, 1, 0) }, { transform: arrowTransform(dir, 1, 1) }],
        { duration: 260, easing: "cubic-bezier(.2,.9,.3,1)" }
      );
    }
  }

  function arrowTransform(dir, scale, spread) {
    const { x, y, rotate } = ARROWS[dir];
    return (
      `translate(-50%,-50%) translate(${x * spread}px,${y * spread}px)` +
      ` rotate(${rotate}deg) scale(${scale})`
    );
  }

  let currentTilt = 0;

  function paintArrows(axis, progress) {
    const theme = THEMES[DARK_MQ.matches ? "dark" : "light"];
    for (const [dir, arrow] of Object.entries(ui.arrows)) {
      const on = dir === axis;
      const alpha = on ? 0.34 + 0.66 * progress : 0.34;
      const color = on ? accentWithAlpha(theme.accent, alpha.toFixed(2)) : theme.dim;
      arrow.style.borderBottomColor = color;
      arrow.style.transform = arrowTransform(
        dir,
        on ? 1 + 0.55 * progress : 1,
        on ? 1 + 0.14 * progress : 1
      );
    }
  }

  function paintIcons(axis, progress) {
    for (const [dir, icon] of Object.entries(ui.icons)) {
      const on = dir === axis;
      const pos = ICON_POS[dir];
      const scale = on ? 1 + 0.25 * progress : 1;
      icon.style.opacity = on ? ICON_IDLE_ALPHA + (1 - ICON_IDLE_ALPHA) * progress : ICON_IDLE_ALPHA;
      icon.style.transform =
        `translate(${pos.x}px,${pos.y}px) scale(${scale.toFixed(3)})`;
    }
  }

  // Cancel icon at ring center: fully visible while the cursor is near the start
  // point, fading out as it approaches the gesture recognition threshold.
  function paintCancel(progress) {
    const opacity = Math.max(0, 1 - progress);
    ui.cancelIcon.style.opacity = opacity.toFixed(2);
    ui.cancelIcon.style.transform = `scale(${(1 - 0.45 * progress).toFixed(3)})`;
  }

  function sectorGradient(axis) {
    const from = { up: -45, right: 45, down: 135, left: 225 }[axis];
    const c = accentWithAlpha(currentTheme().accent, 0.45);
    return `conic-gradient(from ${from}deg, transparent 0deg, ${c} 30deg, ${c} 60deg, transparent 90deg, transparent 360deg)`;
  }

  function paintGlow(axis, progress) {
    if (!ui.glow) return;
    if (axis && axis !== ui.glowAxis) {
      ui.glow.style.background = sectorGradient(axis);
      ui.glowAxis = axis;
    }
    ui.glow.style.opacity = axis ? progress.toFixed(2) : "0";
  }

  // Beyond the threshold the dot slows down and saturates a little further out.
  function squash(r) {
    if (r <= GESTURE_MIN_PX) return r;
    return GESTURE_MIN_PX + (PUCK_MAX_PX - GESTURE_MIN_PX) * (1 - Math.exp(-(r - GESTURE_MIN_PX) / 30));
  }

  function paintPointer(dx, dy, progress) {
    const dist = Math.hypot(dx, dy);
    const k = dist > 0 ? squash(dist) / dist : 0;
    const px = (dx * k).toFixed(1);
    const py = (dy * k).toFixed(1);
    if (ui.puck) {
      ui.puck.style.transform = `translate(${px}px,${py}px)`;
      ui.puck.style.scale = progress >= 1 ? "1.5" : "1";
    }
    if (ui.guideLine) {
      ui.guideLine.setAttribute("x2", px);
      ui.guideLine.setAttribute("y2", py);
    }
  }

  // One-shot bump when the cursor crosses the threshold: "you can release now".
  function pulseThreshold(axis) {
    const bump = { duration: 170, easing: "ease-out" };
    ui.arrows[axis].animate([{ scale: 1 }, { scale: 1.35 }, { scale: 1 }], bump);
    ui.icons[axis].animate([{ scale: 1 }, { scale: 1.4 }, { scale: 1 }], bump);
    ui.ring.animate([{ scale: 1 }, { scale: 1.05 }, { scale: 1 }], bump);
  }

  function updateVisual(dx, dy) {
    if (!SHOW_INDICATOR || !ui) return;

    const dist = Math.hypot(dx, dy);
    const axis = axisOf(dx, dy);
    currentAxis = axis;
    const progress = Math.min(dist / GESTURE_MIN_PX, 1);

    if (dist > 0) {
      // A gentle tilt as a single rotation around the axis perpendicular to the
      // movement. One rotate3d instead of separate rotateX/rotateY: that way the
      // bubble doesn't wash out gray and the arrows don't turn into trapezoids
      // on diagonals.
      const tiltTarget = Math.min(dist / 300, 1) * 25;
      const angleRad = Math.atan2(dy, dx);
      const vx = -Math.sin(angleRad);
      const vy = Math.cos(angleRad);
      // Smoothing: tilt eases toward its target instead of snapping.
      currentTilt += (tiltTarget - currentTilt) * 0.3;

      ui.ring.style.transform =
        `rotate3d(${vx.toFixed(3)},${vy.toFixed(3)},0,${currentTilt.toFixed(1)}deg)`;
    }

    paintArrows(axis, progress);
    paintIcons(axis, progress);
    paintCancel(progress);
    paintGlow(axis, progress);
    paintPointer(dx, dy, progress);

    if (progress >= 1) {
      if (!crossed) pulseThreshold(axis);
      crossed = true;
    } else {
      crossed = false;
    }
    activeDirection = progress >= 1 ? axis : null;
  }

  function highlight(direction) {
    if (!SHOW_INDICATOR || !ui || direction === activeDirection) return;

    activeDirection = direction;
    ui.ring.style.transform = "";
    paintArrows(direction, direction ? 1 : 0);
    paintIcons(direction, direction ? 1 : 0);
    paintCancel(direction ? 1 : 0);
    paintGlow(direction, direction ? 1 : 0);
    paintPointer(0, 0, 0);
  }

  function hideRing() {
    if (!ui) return;

    clearTimeout(hideTimer);
    ui.wrap.style.opacity = "0";
    // The ring is already invisible, so reset its transform right away — otherwise
    // the next gesture would start by "flying in" from the previous position.
    ui.ring.style.transform = "";
    stopProgress();
    currentTilt = 0;
    activeDirection = null;
    crossed = false;
  }

  // The gesture fired: the ring collapses; the chosen icon plays its own exit.
  function resolveRing(direction) {
    if (!SHOW_INDICATOR || !ui) return;

    const { wrap, ring } = ui;
    wrap.style.opacity = "1";

    const pulled = ring.style.transform;
    ring.animate(
      [
        { transform: `${pulled} scale(1)`, opacity: 1 },
        { transform: `${pulled} scale(1.22)`, opacity: 0 }
      ],
      { duration: 220, easing: "ease-out" }
    );
    ring.style.opacity = "0";
    if (ACTION_ANIM && direction) playActionFx(direction);

    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideRing, 700);
  }

  // A detached copy of the chosen icon, so it can outlive the fading ring:
  // the tab flies off, the cross collapses, the restore arrow spins back.
  function playActionFx(direction) {
    const holder = document.createElement("div");
    holder.innerHTML = ICONS_MAP[direction];
    const fx = holder.firstElementChild;
    fx.style.cssText = "position:absolute;left:-10px;top:-10px";
    ui.root.appendChild(fx);

    const { x, y } = ICON_POS[direction];
    const at = (dy, scale, rotate) =>
      `translate(${x}px,${y + dy}px) rotate(${rotate}deg) scale(${scale})`;
    let frames;
    if (direction === "up" || direction === "down") {
      const away = direction === "up" ? -54 : 54;
      frames = [
        { transform: at(0, 1.25, 0), opacity: 1 },
        { transform: at(away, 1.6, 0), opacity: 0 }
      ];
    } else if (direction === "left") {
      frames = [
        { transform: at(0, 1.25, 0), opacity: 1 },
        { transform: at(0, 0, 90), opacity: 0 }
      ];
    } else {
      frames = [
        { transform: at(0, 1.25, 0), opacity: 1 },
        { transform: at(0, 1.5, -360), opacity: 0 }
      ];
    }
    fx.animate(frames, { duration: 400, easing: "cubic-bezier(.3,.7,.4,1)" }).onfinish = () =>
      fx.remove();
  }

  // "Open in new tab" badge — confirms a right-click on a link. A separate
  // element from the gesture ring, so it doesn't touch its animation.
  function flashOpenLink(x, y) {
    if (!SHOW_INDICATOR) return;

    clearTimeout(hideTimer);
    const { wrap, ring, confirm } = placeAt(x, y);

    ring.style.opacity = "0";
    wrap.style.opacity = "1";
    confirm.style.opacity = "1";
    confirm.animate(
      [
        { opacity: 0, transform: "scale(.7)" },
        { opacity: 1, transform: "scale(1)" }
      ],
      { duration: 140, easing: "cubic-bezier(.2,.9,.3,1)" }
    );

    hideTimer = setTimeout(hideRing, 900);
  }

  // Browser theme change — rebuild the bubble on the fly; if a ring is already
  // open, recreate it in place so it doesn't jump on screen.
  function applyTheme() {
    if (ui) {
      if (ui.wrap.isConnected) ui.wrap.remove();
      ui = null;
      if (armed) showRing(armed.x, armed.y);
    }
  }
  DARK_MQ.addEventListener?.("change", applyTheme);

  window.addEventListener("mousedown", onMouseDown, true);
  window.addEventListener("mousemove", onMouseMove, true);
  window.addEventListener("mouseup", onMouseUp, true);
  window.addEventListener("contextmenu", onContextMenu, true);
  window.addEventListener("selectstart", onSelectStart, true);
  window.addEventListener("dragstart", onDragStart, true);
  window.addEventListener("click", onClick, true);
  // A lost mouseup would leave a started gesture stuck.
  window.addEventListener("blur", reset);
  // Dragging a scrollbar thumb scrolls the page; drop the gesture if it slipped through.
  window.addEventListener("scroll", onScroll, true);

  console.debug("SwipeTab active");
})();
