// In-page bounce mirror of the background guard. Runs at document_start,
// before the page paints. Uses the same matcher table as background.js —
// keep the two files in sync when adding hosts.
(async () => {
  try {
    const st = await chrome.storage.local.get(["session", "blocklist", "blocklistVersion"]);
    if (!st.session) return;
    const BLOCKLIST = st.blocklist && st.blocklist.length ? st.blocklist : [
      "instagram.com", "x.com", "twitter.com", "threads.net", "reddit.com",
      "facebook.com", "netflix.com", "hotstar.com", "chess.com", "lichess.org",
      "cricbuzz.com", "amazon.in", "flipkart.com", "zomato.com", "swiggy.com",
    ];
    const host = location.hostname.toLowerCase().replace(/^www\.|^m\./, "");
    const wl = st.session.whitelist || [];
    if (wl.some((w) => host === w || host.endsWith("." + w))) return;
    if (BLOCKLIST.some((b) => host === b || host.endsWith("." + b))) {
      location.replace(chrome.runtime.getURL("blocked.html") + "?from=" + encodeURIComponent(location.href));
      return;
    }
    // YouTube study guard: /watch, /playlist, /embed, /results stay open.
    // Shorts, home feed, trending, explore, gaming, podcasts bounce.
    if (["youtube.com", "youtu.be", "music.youtube.com"].includes(host) && host !== "youtu.be") {
      if (/^\/$/.test(location.pathname) && !location.search.includes("list=")) {
        location.replace(chrome.runtime.getURL("blocked.html") + "?from=" + encodeURIComponent(location.href) + "&why=yt");
      } else if (/^\/shorts(\/|$)/.test(location.pathname)
        || /^\/feed(\/|$)/.test(location.pathname)
        || /^\/(trending|explore|gaming|podcasts)/.test(location.pathname)) {
        location.replace(chrome.runtime.getURL("blocked.html") + "?from=" + encodeURIComponent(location.href) + "&why=yt");
      }
    }
  } catch { /* ignore */ }
})();
