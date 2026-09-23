/* FocusLock shared UI helpers — theme init, toast, dialog, icons, esc, time.
 * Included by every HTML page BEFORE its own script. No business logic here.
 */
(function () {
  "use strict";

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fmtClock(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const mm = String(m).padStart(2, "0"), ss = String(r).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
  }

  function ago(ts) {
    const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    return `${Math.floor(m / 60)}h ${m % 60}m ago`;
  }

  // Theme: stored preference wins; default "system" follows the OS.
  async function initTheme() {
    let theme = "system";
    try {
      const st = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
      theme = (st && st.settings && st.settings.theme) || "system";
    } catch { /* pages without SW access fall back to OS */ }
    if (theme === "light" || theme === "dark") {
      document.documentElement.dataset.theme = theme;
    } else {
      delete document.documentElement.dataset.theme;
    }
    return theme;
  }

  function toast(text, ms) {
    let host = document.querySelector(".toast-host");
    if (!host) {
      host = document.createElement("div");
      host.className = "toast-host";
      host.setAttribute("aria-live", "polite");
      document.body.appendChild(host);
    }
    host.innerHTML = "";
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = text;
    host.appendChild(el);
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { host.innerHTML = ""; }, ms || 2800);
  }

  // Accessible inline dialog. Returns a close() fn. ESC + backdrop close.
  function dialog({ title, bodyHTML, actions }) {
    closeDialog();
    const back = document.createElement("div");
    back.className = "dialog-back";
    const d = document.createElement("div");
    d.className = "dialog";
    d.setAttribute("role", "dialog");
    d.setAttribute("aria-modal", "true");
    d.setAttribute("aria-label", title);
    const h = document.createElement("h3");
    h.textContent = title;
    d.appendChild(h);
    const body = document.createElement("div");
    body.innerHTML = bodyHTML || "";
    d.appendChild(body);
    const row = document.createElement("div");
    row.className = "actions";
    let firstBtn = null;
    for (const a of actions || []) {
      const b = document.createElement("button");
      b.className = "btn " + (a.kind === "primary" ? "btn-primary" : a.kind === "danger" ? "btn-danger" : "btn-secondary");
      b.textContent = a.label;
      b.onclick = () => { closeDialog(); if (a.onClick) a.onClick(); };
      row.appendChild(b);
      if (!firstBtn) firstBtn = b;
    }
    d.appendChild(row);
    back.appendChild(d);
    back.addEventListener("mousedown", (e) => { if (e.target === back) closeDialog(); });
    document.body.appendChild(back);
    document.addEventListener("keydown", escClose);
    if (firstBtn) firstBtn.focus();
    return closeDialog;
  }
  function escClose(e) { if (e.key === "Escape") closeDialog(); }
  function closeDialog() {
    document.querySelectorAll(".dialog-back").forEach((n) => n.remove());
    document.removeEventListener("keydown", escClose);
  }

  // Tiny inline SVG icon set — no emoji, no remote assets.
  const ICONS = {
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09A1.7 1.7 0 0 0 10.1 3.4V3a2 2 0 1 1 4 0v.09c0 .68.4 1.3 1.01 1.55.61.26 1.32.11 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09c.26.61.87 1.01 1.55 1.01H21a2 2 0 1 1 0 4h-.09c-.68 0-1.3.4-1.51 1.01z"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    play: '<path d="M7 4.5v15l13-7.5z"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    back: '<path d="M19 12H5m6-7-7 7 7 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    shield: '<path d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z"/>',
    book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>',
    check: '<path d="M4 12.5 9.5 18 20 6.5"/>',
    ext: '<path d="M14 4h6v6M20 4 11 13"/><path d="M20 14v6H4V4h6"/>',
  };
  function icon(name, size) {
    return `<svg viewBox="0 0 24 24" width="${size || 16}" height="${size || 16}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  }

  // Local favicon fallback: letter tile, never a remote fetch.
  function fav(t) {
    const letter = esc((t.host || "?").charAt(0).toUpperCase());
    if (t.favIcon) {
      return `<img class="fav" src="${esc(t.favIcon)}" alt="" onerror="this.outerHTML='<span class=&quot;fav-fallback&quot; aria-hidden=&quot;true&quot;>${letter}</span>'">`;
    }
    return `<span class="fav-fallback" aria-hidden="true">${letter}</span>`;
  }

  window.FL = { esc, fmtClock, ago, initTheme, toast, dialog, closeDialog, icon, fav };
})();
