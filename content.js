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
    if (armed) hideRing();
    pending = null;
    armed = null;
  }

  function onMouseDown(event) {
    if (event.button !== LEFT_BUTTON || isEditable(event.target) || isOnScrollbar(event)) return;

    reset();
    pressTarget = event.target;
    pending = { x: event.clientX, y: event.clientY };
    holdTimer = setTimeout(arm, HOLD_MS);
  }

  function arm() {
    if (!pending) return;

    armed = pending;
    pending = null;
    window.getSelection()?.removeAllRanges();
    showRing(armed.x, armed.y);
  }

  // Dominant axis of movement — ignores the threshold, used only for highlighting.
  function axisOf(dx, dy) {
    if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? "up" : "down";
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
    resolveRing();

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

  const DARK_MQ = window.matchMedia("(prefers-color-scheme: dark)");

  let ui = null;
  let hideTimer = 0;
  let activeDirection = null;

  function buildUi() {
    const theme = THEMES[DARK_MQ.matches ? "dark" : "light"];
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;opacity:0;perspective:300px";

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
      "transition:opacity .16s,transform .08s linear"
    ].join(";");

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
        "opacity:.34",
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

    wrap.append(ring, confirm);
    (document.body || document.documentElement).appendChild(wrap);

    return { wrap, ring, arrows, icons, cancelIcon, confirm };
  }

  function ensureUi() {
    if (!ui || !ui.wrap.isConnected) ui = buildUi();
    return ui;
  }

  function placeAt(x, y) {
    const { wrap } = ensureUi();
    if (INDICATOR_AT_CURSOR) {
      wrap.style.left = `${x}px`;
      wrap.style.top = `${y}px`;
    } else {
      wrap.style.left = `${window.innerWidth / 2}px`;
      wrap.style.top = `${window.innerHeight / 2}px`;
    }
    return ui;
  }

  function showRing(x, y) {
    if (!SHOW_INDICATOR) return;

    clearTimeout(hideTimer);

    const { wrap, ring, confirm } = placeAt(x, y);
    ring.style.opacity = "1";
    // The link-open badge lives in the same wrap — hide it so it can't leak into a gesture.
    confirm.style.opacity = "0";
    // Sentinel, not null: otherwise highlight(null) would see no change and skip
    // clearing the highlight left over from a previous gesture.
    activeDirection = undefined;
    highlight(null);

    wrap.style.opacity = "1";
    wrap.animate(
      [
        { opacity: 0, transform: "scale(.72)" },
        { opacity: 1, transform: "scale(1)" }
      ],
      { duration: 170, easing: "cubic-bezier(.2,.9,.3,1)" }
    );
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
      icon.style.opacity = on ? 0.34 + 0.66 * progress : 0.34;
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

  function updateVisual(dx, dy) {
    if (!SHOW_INDICATOR || !ui) return;

    const dist = Math.hypot(dx, dy);
    const axis = axisOf(dx, dy);
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
    activeDirection = progress >= 1 ? axis : null;
  }

  function highlight(direction) {
    if (!SHOW_INDICATOR || !ui || direction === activeDirection) return;

    activeDirection = direction;
    ui.ring.style.transform = "";
    paintArrows(direction, direction ? 1 : 0);
    paintIcons(direction, direction ? 1 : 0);
    paintCancel(direction ? 1 : 0);
  }

  function hideRing() {
    if (!ui) return;

    clearTimeout(hideTimer);
    ui.wrap.style.opacity = "0";
    // The ring is already invisible, so reset its transform right away — otherwise
    // the next gesture would start by "flying in" from the previous position.
    ui.ring.style.transform = "";
    currentTilt = 0;
    activeDirection = null;
  }

  // The gesture fired: the ring collapses.
  function resolveRing() {
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

    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideRing, 700);
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
