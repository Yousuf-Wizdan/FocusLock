// FocusLock content guard — thin SPA mirror. Verdict logic is NOT here:
// it calls globalThis.FocusLockPolicy (loaded as the first content script
// in manifest.json). Event-driven only: history patch + popstate/hashchange
// + pageshow + MutationObserver URL check. No setInterval polling.
(() => {
  "use strict";
  if (window.__flGuard) return;
  window.__flGuard = true;

  const P = globalThis.FocusLockPolicy;
  if (!P) return;

  function isOwnPage(href) {
    try {
      return href.startsWith(chrome.runtime.getURL(""));
    } catch { return false; }
  }

  async function snapshot() {
    try {
      const got = await chrome.storage.local.get(
        ["fl_state_v2", "customBlocklist", "removedDefaults"]
      );
      const st = got.fl_state_v2;
      if (!st || !st.session) return null;
      const removed = new Set(got.removedDefaults || []);
      const list = P.DEFAULT_BLOCKLIST.filter((d) => !removed.has(d))
        .concat(got.customBlocklist || []);
      return {
        sessionActive: true,
        blocklist: [...new Set(list)],
        whitelist: st.session.whitelist || [],
        passUntil: st.pass?.until || 0,
        passHost: st.pass?.host || "",
        youtubeGuard: st.settings?.youtubeGuard !== false,
      };
    } catch { return null; }
  }

  function verdict(url, ctx) {
    const v = P.decide(url, ctx);
    if (v.verdict === "blocked" && v.rule === "youtube" && ctx.youtubeGuard === false) {
      return { verdict: "open" };
    }
    return v;
  }

  let checking = false;
  async function check() {
    if (checking) return;
    const href = location.href;
    if (!href || !href.startsWith("http") || isOwnPage(href)) return;
    checking = true;
    try {
      const ctx = await snapshot();
      if (!ctx) return;
      const v = verdict(href, ctx);
      if (v.verdict === "blocked") {
        const dest = chrome.runtime.getURL("blocked.html") +
          "?fl=blocked&rule=" + encodeURIComponent(v.rule || "blocklist") +
          "&from=" + encodeURIComponent(href) +
          "&entry=" + encodeURIComponent(v.entry || "");
        location.replace(dest);
      }
    } catch { /* ignore */ }
    finally { checking = false; }
  }

  // SPA: YouTube/Instagram/X rewrite history without reloading.
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  function queueCheck() {
    if (queueCheck.queued) return;
    queueCheck.queued = true;
    requestAnimationFrame(() => { queueCheck.queued = false; check(); });
  }
  history.pushState = function (...a) { origPush.apply(this, a); queueCheck(); };
  history.replaceState = function (...a) { origReplace.apply(this, a); queueCheck(); };
  window.addEventListener("popstate", queueCheck);
  window.addEventListener("hashchange", queueCheck);
  window.addEventListener("pageshow", queueCheck); // bfcache / back-forward restore
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) queueCheck();
  });

  // MutationObserver URL watcher: fires only when the SPA mutates the DOM
  // AND the URL actually changed (YouTube title-swap navigations included).
  let lastUrl = location.href;
  let moQueued = false;
  const mo = new MutationObserver(() => {
    if (location.href === lastUrl || moQueued) return;
    moQueued = true;
    requestAnimationFrame(() => {
      moQueued = false;
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        check();
      }
    });
  });
  function armObserver() {
    lastUrl = location.href;
    if (document.documentElement) {
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }
  }
  if (document.documentElement) armObserver();
  else document.addEventListener("DOMContentLoaded", armObserver, { once: true });
  // Observer is only needed while a session is active; disconnect when idle.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.fl_state_v2) {
      const st = changes.fl_state_v2.newValue;
      if (!st || !st.session) { try { mo.disconnect(); } catch { /* ignore */ } }
      else { try { armObserver(); } catch { /* ignore */ } }
    }
  });

  check();
})();
