// In-page bounce mirror of the background guard. Runs at document_start,
// before the page paints, and re-checks on every single-page-app navigation
// (YouTube Shorts-from-watch, Instagram reels, X) because those never reload
// the document. Matchers mirror background.js decide() — keep in sync.
(() => {
  const BLOCKLIST_FALLBACK = [
    "instagram.com", "x.com", "twitter.com", "threads.net", "reddit.com",
    "facebook.com", "netflix.com", "hotstar.com", "chess.com", "lichess.org",
    "cricbuzz.com", "amazon.in", "flipkart.com", "zomato.com", "swiggy.com",
  ];
  const YT_BAD = [/^\/$/, /^\/shorts(\/|$)/, /^\/feed(\/|$)/, /^\/trending/, /^\/explore/, /^\/gaming/, /^\/podcasts/];

  const norm = (h) => h.toLowerCase().replace(/^www\./, "").replace(/^(m|mobile|new|old|beta|touch|i)\./, "");

  function decide(href, st) {
    if (!st || !st.session || !href) return null;
    let u;
    try { u = new URL(href); } catch { return null; }
    const host = norm(u.hostname);
    if (!host) return null;
    const wl = st.session.whitelist || [];
    if (wl.some((w) => host === w || host.endsWith("." + w))) return null;
    const bl = st.blocklist && st.blocklist.length ? st.blocklist : BLOCKLIST_FALLBACK;
    if (bl.some((b) => host === b || host.endsWith("." + b))) return "blocklist";
    if ((host === "youtube.com" || host === "music.youtube.com") && host !== "youtu.be"
      && YT_BAD.some((re) => re.test(u.pathname))
      && !(u.pathname === "/" && u.search.includes("list="))) return "youtube";
    if (host === "youtu.be") return null;
    return null;
  }

  async function check() {
    try {
      const st = await chrome.storage.local.get(["session", "blocklist", "blocklistVersion", "whitelist"]);
      const rule = decide(location.href, { session: st.session, whitelist: (st.session && st.session.whitelist) || [], blocklist: st.blocklist });
      if (rule) {
        location.replace(chrome.runtime.getURL("blocked.html") + "?from=" + encodeURIComponent(location.href) + (rule === "youtube" ? "&why=yt" : ""));
      }
    } catch { /* ignore */ }
  }

  check();
  // SPA navigations: YouTube/Instagram/X rewrite history without reloading.
  const origPush = history.pushState, origReplace = history.replaceState;
  history.pushState = function (...a) { origPush.apply(this, a); setTimeout(check, 0); };
  history.replaceState = function (...a) { origReplace.apply(this, a); setTimeout(check, 0); };
  window.addEventListener("popstate", () => setTimeout(check, 0));
  // Backstop for frameworks that mutate the URL without history calls.
  let last = location.href;
  setInterval(() => { if (location.href !== last) { last = location.href; check(); } }, 1000);
})();
