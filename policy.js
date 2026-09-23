/* FocusLock shared policy engine — SINGLE SOURCE OF TRUTH.
 * Loaded in BOTH the MV3 service worker (via importScripts) and the
 * content script (manifest lists policy.js BEFORE content.js), plus Node
 * tests (module.exports guard at the bottom). Never duplicate these
 * regexes anywhere else — background/popup/content must call this.
 *
 * Pipeline: canonicalizeUrl() -> classifyUrl() -> decide() -> OPEN/BLOCKED/SYSTEM
 */
(() => {
  "use strict";

  const DEFAULT_BLOCKLIST = [
    "instagram.com", "x.com", "twitter.com", "threads.net",
    "reddit.com", "facebook.com", "snapchat.com", "pinterest.com",
    "pinterest.in", "quora.com", "medium.com", "tumblr.com",
    "9gag.com", "imgur.com", "discord.com", "linkedin.com",
    "netflix.com", "hotstar.com", "jiohotstar.com", "primevideo.com",
    "sonyliv.com", "zee5.com", "mxplayer.in", "dailymotion.com",
    "hulu.com", "twitch.tv",
    "chess.com", "lichess.org",
    "cricbuzz.com", "espncricinfo.com", "cricinfo.com",
    "amazon.com", "amazon.in", "flipkart.com", "myntra.com",
    "meesho.com", "ajio.com", "snapdeal.com", "olx.in",
    "zomato.com", "swiggy.com", "dream11.com",
  ];

  const BLOCKLIST_VERSION = 4;

  // Hosts that are study sources: never fully blocked, only distraction paths.
  const STUDY_GUARD_HOSTS = ["youtube.com", "youtu.be", "music.youtube.com"];

  // Query params that never change page identity (tracking / player state).
  const TRACKING_PARAMS = new Set([
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "fbclid", "gclid", "igshid", "mc_cid", "mc_eid", "ref", "ref_src",
    "si", "feature", "pp", "ab_channel",
  ]);

  // Prefixes stripped for display/comparison only (never for security).
  const NOISE_PREFIX_RE = /^(www|m|mobile|new|old|beta|touch|i)\./;

  function normHost(hostname) {
    return String(hostname || "").toLowerCase().replace(NOISE_PREFIX_RE, "");
  }

  function hostOf(url) {
    try {
      return normHost(new URL(url).hostname);
    } catch { return ""; }
  }

  /** Canonicalize a URL for identity + verdict. Never throws. */
  function canonicalizeUrl(raw) {
    try {
      const u = new URL(raw);
      const proto = u.protocol.toLowerCase();
      if (proto !== "http:" && proto !== "https:") return null;
      let host = normHost(u.hostname);
      if (!host) return null;
      // youtu.be/<id> == youtube.com/watch?v=<id>
      if (host === "youtu.be") {
        const id = u.pathname.split("/").filter(Boolean)[0] || "";
        const t = u.searchParams.get("t") || u.searchParams.get("start") || "";
        const canon = id
          ? `https://www.youtube.com/watch?v=${id}${t ? `&t=${encodeURIComponent(t)}` : ""}`
          : "https://www.youtube.com/";
        return { canon, host: "youtube.com", pathname: id ? "/watch" : "/", kind: "youtube-share" };
      }
      // music.youtube.com behaves like youtube.com for verdict purposes.
      if (host === "music.youtube.com") host = "youtube.com";
      const path = u.pathname || "/";
      const params = new URLSearchParams();
      const keep = new Set(["v", "list", "search_query", "t", "start", "index"]);
      for (const [k, v] of u.searchParams) {
        if (keep.has(k) && !TRACKING_PARAMS.has(k)) params.append(k, v);
      }
      // Sort for stable identity.
      params.sort();
      const qs = params.toString();
      const canon = `https://${host}${path}${qs ? `?${qs}` : ""}`;
      return { canon, host, pathname: path, search: qs ? `?${qs}` : "" };
    } catch { return null; }
  }

  /** Stable study-tab identity: same lecture reopened == same study tab. */
  function studyKey(raw) {
    const c = canonicalizeUrl(raw);
    if (!c) return "";
    try {
      const u = new URL(c.canon);
      if (c.host === "youtube.com") {
        const v = u.searchParams.get("v");
        if (v) return `yt:watch:${v}`;
        const list = u.searchParams.get("list");
        if (u.pathname.startsWith("/playlist") && list) return `yt:list:${list}`;
        if (u.pathname.startsWith("/embed/")) return `yt:embed:${u.pathname.split("/")[2] || ""}`;
        if (u.pathname.startsWith("/live/")) return `yt:live:${u.pathname.split("/")[2] || ""}`;
        // Channels: canonical lowercase path, strip trailing slash.
        return `yt:${u.pathname.toLowerCase().replace(/\/+$/, "") || "/"}`;
      }
      const p = u.pathname.replace(/\/+$/, "") || "/";
      return `${c.host}${p}${u.search ? `?${u.searchParams.toString()}` : ""}`.toLowerCase();
    } catch { return c.canon.toLowerCase(); }
  }

  function matchesList(host, list) {
    for (const b of list || []) {
      const e = String(b || "").toLowerCase().trim();
      if (!e) continue;
      if (host === e || host.endsWith("." + e)) return e;
    }
    return null;
  }

  function isWhitelisted(host, whitelist) {
    return !!matchesList(host, whitelist);
  }

  /** YouTube verdict on an already-canonicalized URL. */
  function youtubeVerdict(c) {
    const path = c.pathname;
    // Any /shorts/ segment anywhere (incl. /@h/shorts, /channel/UC../shorts, /c/n/shorts).
    if (/(^|\/)shorts(\/|$)/i.test(path)) return "blocked";
    if (/^\/($)/.test(path) && !c.search.includes("list=")) return "blocked"; // home feed
    if (/^\/(feed|trending|explore|gaming|podcasts)(\/|$)/.test(path)) return "blocked";
    if (/^\/(hashtag|results|watch|playlist|embed|live|channel|c|user|@[^/]+)(\/|$|$)/.test(path)) return "open";
    if (path === "/" && c.search.includes("list=")) return "open"; // mix link on home
    // Unknown future YouTube surface: fail OPEN (study-first, don't strand lectures).
    return "open";
  }

  /**
   * THE verdict. ctx: { sessionActive, blocklist, whitelist, passUntil, passHost }
   * Returns { verdict: "open"|"blocked"|"system", rule?, entry? }.
   */
  function decide(rawUrl, ctx = {}) {
    if (!rawUrl) return { verdict: "open" };
    // Extension pages, browser internals, non-http(s): never touch.
    if (/^(chrome|edge|about|brave|opera|vivaldi|chrome-extension|moz-extension):/i.test(rawUrl)) {
      return { verdict: "system" };
    }
    const c = canonicalizeUrl(rawUrl);
    if (!c) return { verdict: "open" };
    if (!ctx.sessionActive) return { verdict: "open" };
    const wl = ctx.whitelist || [];
    if (isWhitelisted(c.host, wl)) return { verdict: "open" };
    // Emergency pass: one host bypassed for a short window.
    if (ctx.passUntil && Date.now() < ctx.passUntil && ctx.passHost &&
        (c.host === ctx.passHost || c.host.endsWith("." + ctx.passHost))) {
      return { verdict: "open" };
    }
    const hit = matchesList(c.host, ctx.blocklist || []);
    if (hit) return { verdict: "blocked", rule: "blocklist", entry: hit };
    if (STUDY_GUARD_HOSTS.includes(canonicalHost(rawUrl)) || c.host === "youtube.com") {
      if (youtubeVerdict(c) === "blocked") return { verdict: "blocked", rule: "youtube" };
    }
    return { verdict: "open" };
  }

  function canonicalHost(rawUrl) {
    const c = canonicalizeUrl(rawUrl);
    return c ? c.host : hostOf(rawUrl);
  }

  /** Pull a domain-looking token out of free text ("check instagram"). */
  function siteOf(text) {
    const m = String(text || "").toLowerCase().match(/([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}/);
    return m ? m[0].replace(/^www\./, "") : "";
  }

  /** Extract YouTube search query from a /results URL, "" if not one. */
  function ytSearchQuery(rawUrl) {
    try {
      const u = new URL(rawUrl);
      if (normHost(u.hostname) !== "youtube.com") return "";
      if (!u.pathname.startsWith("/results")) return "";
      return (u.searchParams.get("search_query") || "").trim().slice(0, 120);
    } catch { return ""; }
  }

  const api = {
    DEFAULT_BLOCKLIST, BLOCKLIST_VERSION, STUDY_GUARD_HOSTS,
    normHost, hostOf, canonicalizeUrl, studyKey, matchesList,
    isWhitelisted, youtubeVerdict, decide, siteOf, ytSearchQuery,
  };

  // Service worker (importScripts) + content script (<script> scope): global.
  if (typeof self !== "undefined") self.FocusLockPolicy = api;
  if (typeof globalThis !== "undefined") globalThis.FocusLockPolicy = api;
  // Node tests.
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
