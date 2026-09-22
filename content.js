// Injected early on every page: instantly bounce blocked pages + YT distractions during a session.
(async () => {
  try {
    const st = await chrome.storage.local.get(["session", "blocklist"]);
    if (!st.session) return;
    const host = location.hostname.toLowerCase().replace(/^www\.|^m\./, "");
    const wl = st.session.whitelist || [];
    if (wl.some((w) => host === w || host.endsWith("." + w))) return;
    const bl = st.blocklist || [];
    if (bl.some((b) => host === b || host.endsWith("." + b))) {
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
