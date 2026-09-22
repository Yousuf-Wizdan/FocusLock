// FocusLock background service worker — sessions with enforced breaks,
// tab-switch jail, blocklist + YouTube study guard, search-spiral tripwire.

const BLOCKLIST_VERSION = 3;
const DEFAULT_BLOCKLIST = [
  // Social / doomscroll
  "instagram.com", "x.com", "twitter.com", "threads.net",
  "reddit.com", "facebook.com", "snapchat.com", "pinterest.com",
  "pinterest.in", "quora.com", "medium.com", "tumblr.com",
  "9gag.com", "imgur.com", "discord.com", "linkedin.com",
  // Video / OTT (YouTube handled by the study guard, not the list)
  "netflix.com", "hotstar.com", "jiohotstar.com", "primevideo.com",
  "sonyliv.com", "zee5.com", "mxplayer.in", "dailymotion.com",
  "hulu.com", "twitch.tv",
  // Chess, cricket, shopping, food — the "5-minute check" traps
  "chess.com", "lichess.org",
  "cricbuzz.com", "espncricinfo.com", "cricinfo.com",
  "amazon.com", "amazon.in", "flipkart.com", "myntra.com",
  "meesho.com", "ajio.com", "snapdeal.com", "olx.in",
  "zomato.com", "swiggy.com", "dream11.com",
];

const DEFAULT_STATE = {
  session: null, // { startedAt, endsAt, plannedMinutes, whitelist, studyTabs, urgeLog,
                 //   searchLog: [{at, query}], phases: [{type, minutes}], phaseIndex,
                 //   phaseEndsAt, lastSearchNudgeAt, breakTabId }
  switches: 0,   // switches TO pinned study tabs are free, never counted; no jail during breaks
  blocklist: [...DEFAULT_BLOCKLIST],
  blocklistVersion: 0,
  pendingPins: [], // tabs pinned while idle — merged into the session on Start, then cleared
  history: [],   // [{endedAt, planned, switches, urges, searches, completed, top:[{site,count}]}] — last 30
};

// Hosts that are study sources: never fully blocked, only their
// distraction paths are (Shorts, home feed, trending...). Watch,
// playlist, embed and search pages always stay open.
const STUDY_GUARD_HOSTS = ["youtube.com", "youtu.be", "music.youtube.com"];

// YouTube paths that are pure distraction (blocked during sessions).
// Everything else (/watch, /playlist, /embed, /results, /live, channels) stays open.
const YT_DISTRACTION_PATHS = [/^\/$/, /^\/shorts(\/|$)/, /^\/feed(\/|$)/, /^\/trending/, /^\/explore/, /^\/gaming/, /^\/podcasts/];

// Search-spiral tripwire: >N YouTube searches inside WINDOW_MS = "still studying?" nudge.
const SEARCH_WINDOW_MS = 5 * 60 * 1000;
const SEARCH_THRESHOLD = 4;
const SEARCH_NUDGE_COOLDOWN_MS = 10 * 60 * 1000;

function ytDistraction(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, "");
  if (!STUDY_GUARD_HOSTS.includes(host)) return false;
  if (host === "youtu.be") return false; // share links resolve to watch pages
  return YT_DISTRACTION_PATHS.some((re) => re.test(u.pathname));
}

// Extract a YouTube search query from a /results URL, "" if not a search page.
function ytSearchQuery(url) {
  let u;
  try { u = new URL(url); } catch { return ""; }
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, "");
  if (host !== "youtube.com" && host !== "music.youtube.com") return "";
  if (!u.pathname.startsWith("/results")) return "";
  return (u.searchParams.get("search_query") || "").trim().slice(0, 120);
}

function fmtLeft(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `${m}m`;
}

// Pull a domain-looking token out of free text ("check instagram", "youtube.com shorts").
function siteOf(text) {
  const m = String(text || "").toLowerCase().match(/([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}/);
  return m ? m[0].replace(/^www\./, "") : "";
}

// Write-once summary when a session ends (complete OR quit early).
// Kept to the last 30 so storage stays tiny forever.
async function recordHistory(session, switches, completed) {
  try {
    const urges = (session.urgeLog || []).length;
    const searches = (session.searchLog || []).length;
    const counts = {};
    for (const u of session.urgeLog || []) {
      const key = u.site || (u.text || "").slice(0, 40) || "unnamed";
      counts[key] = (counts[key] || 0) + 1;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([site, count]) => ({ site, count }));
    const stored = await chrome.storage.local.get(["history"]);
    const history = Array.isArray(stored.history) ? stored.history : [];
    history.push({
      endedAt: Date.now(), planned: session.plannedMinutes || 0,
      switches: switches || 0, urges, searches, completed: !!completed, top,
    });
    await chrome.storage.local.set({ history: history.slice(-30) });
  } catch { /* history is best-effort */ }
}

async function getState() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_STATE));
  const st = { ...DEFAULT_STATE, ...stored };
  // Auto-grow the blocklist for users who stored the old short list:
  // merge in any new defaults while keeping their custom entries.
  if ((stored.blocklistVersion || 0) < BLOCKLIST_VERSION) {
    const merged = new Set([...(stored.blocklist || []), ...DEFAULT_BLOCKLIST]);
    st.blocklist = [...merged];
    st.blocklistVersion = BLOCKLIST_VERSION;
    try { await chrome.storage.local.set({ blocklist: st.blocklist, blocklistVersion: BLOCKLIST_VERSION }); } catch { /* ignore */ }
  }
  return st;
}

// Migrate legacy sessions that stored bare tab-id arrays.
function studyList(session) {
  if (!session) return [];
  if (Array.isArray(session.studyTabs)) return session.studyTabs;
  if (Array.isArray(session.studyTabIds)) {
    session.studyTabs = session.studyTabIds
      .filter((n) => Number.isInteger(n))
      .map((id) => ({ id, title: "", url: "", host: "", favIcon: "", closed: false }));
    return session.studyTabs;
  }
  return [];
}

// ---- phases: micro-sprints for low attention spans ----
// 15 min -> single 15 block, no break. 25 -> single 25, no break.
// 35–69 -> 25 focus + 5 break + rest focus (gentle on-ramp).
// 70+ -> classic 50 focus + 10 break + rest focus.
function buildPhases(minutes) {
  if (minutes <= 25) return [{ type: "focus", minutes }];
  if (minutes < 70) return [
    { type: "focus", minutes: 25 },
    { type: "break", minutes: 5 },
    { type: "focus", minutes: minutes - 30 },
  ];
  return [
    { type: "focus", minutes: 50 },
    { type: "break", minutes: 10 },
    { type: "focus", minutes: minutes - 60 },
  ];
}

// Normalize legacy / partial sessions so every reader can assume phases exist.
function ensurePhases(session) {
  if (!session) return null;
  if (!Array.isArray(session.phases) || !session.phases.length) {
    const remaining = Math.max(1, Math.round((session.endsAt - Date.now()) / 60000));
    session.phases = [{ type: "focus", minutes: remaining }];
    session.phaseIndex = 0;
    session.phaseEndsAt = session.endsAt;
  }
  if (!Number.isInteger(session.phaseIndex) || session.phaseIndex >= session.phases.length) {
    session.phaseIndex = session.phases.length - 1;
  }
  if (!session.phaseEndsAt) session.phaseEndsAt = session.endsAt;
  if (!Array.isArray(session.searchLog)) session.searchLog = [];
  return session;
}

function phaseLabel(session) {
  const focuses = session.phases.filter((p) => p.type === "focus").length;
  const cur = session.phases[session.phaseIndex];
  if (cur.type === "break") return { kind: "break", text: "☕ Break" };
  const n = session.phases.slice(0, session.phaseIndex + 1).filter((p) => p.type === "focus").length;
  return { kind: "focus", text: focuses > 1 ? `🟢 Focus ${n} of ${focuses}` : "🟢 Focus" };
}

async function updateBadge() {
  try {
    const st = await getState();
    if (!st.session) { await chrome.action.setBadgeText({ text: "" }); return; }
    ensurePhases(st.session);
    const breaking = st.session.phases[st.session.phaseIndex].type === "break";
    await chrome.action.setBadgeBackgroundColor({ color: breaking ? "#f59e0b" : "#16a34a" });
    await chrome.action.setBadgeText({ text: fmtLeft(st.session.phaseEndsAt - Date.now()) });
  } catch { /* ignore */ }
}

async function closeBreakTab(session) {
  if (session && Number.isInteger(session.breakTabId)) {
    try { await chrome.tabs.remove(session.breakTabId); } catch { /* already closed */ }
    session.breakTabId = null;
  }
}

async function advancePhase(reason) {
  const st = await getState();
  if (!st.session) return;
  const s = ensurePhases(st.session);
  await closeBreakTab(s);
  s.phaseIndex += 1;
  if (s.phaseIndex >= s.phases.length) {
    // Session complete.
    await recordHistory(s, st.switches, true);
    await chrome.storage.local.set({ session: null });
    await chrome.alarms.clearAll();
    await chrome.action.setBadgeText({ text: "" }).catch(() => {});
    chrome.notifications.create({
      type: "basic", iconUrl: "icon128.png",
      title: "FocusLock — session complete",
      message: `Done${reason === "skipped-break" ? " (break skipped)" : ""}. ${st.switches} tab-switches. Take a real break, you earned it.`,
    });
    return;
  }
  const phase = s.phases[s.phaseIndex];
  s.phaseEndsAt = Date.now() + phase.minutes * 60 * 1000;
  s.phaseStartedAt = Date.now();
  await chrome.storage.local.set({ session: s });
  chrome.alarms.create("phase", { when: s.phaseEndsAt });
  updateBadge();
  if (phase.type === "break") {
    const focusDone = s.phases.slice(0, s.phaseIndex).filter((p) => p.type === "focus")
      .reduce((a, p) => a + p.minutes, 0);
    chrome.notifications.create({
      type: "basic", iconUrl: "icon128.png",
      title: "FocusLock — break time",
      message: `${focusDone} minutes done. Step away for ${phase.minutes} — no tabs, no phone. Switching is free during break; blocks stay on.`,
    });
    try {
      const t = await chrome.tabs.create({ url: chrome.runtime.getURL("break.html") + "?wait=" + phase.minutes, active: true });
      s.breakTabId = t.id;
      await chrome.storage.local.set({ session: s });
    } catch { /* popup-less contexts */ }
  } else {
    chrome.notifications.create({
      type: "basic", iconUrl: "icon128.png",
      title: "FocusLock — break over",
      message: reason === "skipped-break" ? "Break skipped. Back to study — jail is on." : "Break over. Back to your study tab — jail is on.",
    });
  }
}

// ---- session lifecycle ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "START_SESSION") {
      const now = Date.now();
      const minutes = msg.minutes || 120;
      const whitelist = (msg.whitelist || []).map((h) => h.trim().toLowerCase()).filter(Boolean);
      const studyTabs = Array.isArray(msg.studyTabs)
        ? msg.studyTabs.filter((t) => t && Number.isInteger(t.id))
            .map((t) => ({ id: t.id, title: t.title || "", url: t.url || "", host: t.host || "", favIcon: t.favIcon || "", closed: false }))
        : [];
      const legacyIds = Array.isArray(msg.studyTabIds) ? msg.studyTabIds.filter((n) => Number.isInteger(n)) : [];
      for (const id of legacyIds) {
        if (studyTabs.some((t) => t.id === id)) continue;
        let meta = { title: "", url: "", favIcon: "" };
        try {
          const t = await chrome.tabs.get(id);
          meta = { title: t.title || "", url: t.url || "", favIcon: t.favIconUrl || "" };
        } catch { /* tab gone */ }
        studyTabs.push({ id, title: meta.title, url: meta.url, host: hostOf(meta.url || ""), favIcon: meta.favIcon, closed: false });
      }
      // Merge tabs pinned while idle, then clear the tray.
      const stored = await chrome.storage.local.get(["pendingPins"]);
      for (const p of Array.isArray(stored.pendingPins) ? stored.pendingPins : []) {
        if (p && Number.isInteger(p.id) && !studyTabs.some((t) => t.id === p.id)) studyTabs.push(p);
      }
      const phases = buildPhases(minutes);
      const session = {
        startedAt: now, endsAt: now + minutes * 60 * 1000, plannedMinutes: minutes,
        whitelist, studyTabs, urgeLog: [], searchLog: [],
        phases, phaseIndex: 0, phaseEndsAt: now + phases[0].minutes * 60 * 1000,
        phaseStartedAt: now,
        lastSearchNudgeAt: 0, breakTabId: null,
      };
      await chrome.storage.local.set({ session, switches: 0, pendingPins: [] });
      await chrome.alarms.clearAll();
      chrome.alarms.create("phase", { when: session.phaseEndsAt });
      chrome.alarms.create("focusEnd", { when: session.endsAt });
      chrome.alarms.create("tick", { periodInMinutes: 1 });
      updateBadge();
      const plan = phases.map((p) => `${p.minutes}m ${p.type}`).join(" → ");
      sendResponse({ ok: true, plan });
    } else if (msg.type === "PIN_STUDY_TAB") {
      const st = await getState();
      const entry = {
        id: msg.tabId,
        title: msg.title || "",
        url: msg.url || "",
        host: msg.host || hostOf(msg.url || ""),
        favIcon: msg.favIcon || "",
        closed: false,
      };
      if (!Number.isInteger(entry.id)) { sendResponse({ ok: false, reason: "bad-tab" }); return; }
      // Fill in missing identity from the live tab — pinning must name the
      // tab even if the caller only passed an id.
      if (!entry.url || !entry.title) {
        try {
          const t = await chrome.tabs.get(entry.id);
          entry.title = entry.title || t.title || "";
          entry.url = entry.url || t.url || "";
          entry.host = entry.host || hostOf(entry.url);
          entry.favIcon = entry.favIcon || t.favIconUrl || "";
        } catch { /* tab gone */ }
      }
      // Blocked pages can never be pinned: the redirect target (blocked.html)
      // would otherwise launder a distraction into an allowed tab.
      if (!entry.url || /(^|\/)blocked\.html($|[?#])/.test(entry.url)) {
        sendResponse({ ok: false, reason: "blocked-page" });
        return;
      }
      const entryHost = entry.host || hostOf(entry.url);
      if (st.session) {
        // Live session: pin straight into it, but only if the page is allowed.
        // decide() is the same single verdict the blockers use.
        if (decide(entry.url, st).verdict === "blocked") {
          sendResponse({ ok: false, reason: "blocked-site", host: entryHost });
          return;
        }
        // Live session: pin straight into it.
        const tabs = studyList(st.session);
        if (!tabs.some((t) => t.id === entry.id)) {
          tabs.push(entry);
          st.session.studyTabs = tabs;
          await chrome.storage.local.set({ session: st.session });
        }
        sendResponse({ ok: true, studyTabs: studyList(st.session), pending: false });
      } else {
        // Idle: check against the stored blocklist so a distraction pinned now
        // can't sneak into the next session via the tray.
        const bl = st.blocklist || [];
        const blockedEntry = bl.some((b) => entryHost === b || entryHost.endsWith("." + b));
        if (blockedEntry || ytDistraction(entry.url)) {
          sendResponse({ ok: false, reason: "blocked-site", host: entryHost });
          return;
        }
        // Idle: hold it in the tray until Start merges it in.
        const stored = await chrome.storage.local.get(["pendingPins"]);
        const tray = Array.isArray(stored.pendingPins) ? stored.pendingPins : [];
        if (!tray.some((t) => t.id === entry.id)) {
          tray.push(entry);
          await chrome.storage.local.set({ pendingPins: tray });
        }
        sendResponse({ ok: true, studyTabs: tray, pending: true });
      }
    } else if (msg.type === "UNPIN_STUDY_TAB") {
      const st = await getState();
      if (st.session) {
        st.session.studyTabs = studyList(st.session).filter((t) => t.id !== msg.tabId);
        await chrome.storage.local.set({ session: st.session });
      } else {
        const stored = await chrome.storage.local.get(["pendingPins"]);
        const tray = Array.isArray(stored.pendingPins) ? stored.pendingPins : [];
        await chrome.storage.local.set({ pendingPins: tray.filter((t) => t && t.id !== msg.tabId) });
      }
      sendResponse({ ok: true });
    } else if (msg.type === "END_SESSION") {
      const st = await getState();
      if (st.session) {
        await recordHistory(st.session, st.switches, false);
        await closeBreakTab(st.session);
      }
      await chrome.storage.local.set({ session: null });
      await chrome.alarms.clearAll();
      await chrome.action.setBadgeText({ text: "" }).catch(() => {});
      sendResponse({ ok: true });
    } else if (msg.type === "GET_HISTORY") {
      const stored = await chrome.storage.local.get(["history"]);
      sendResponse({ history: Array.isArray(stored.history) ? stored.history : [] });
    } else if (msg.type === "SKIP_BREAK") {
      const st = await getState();
      if (!st.session) { sendResponse({ ok: false }); return; }
      ensurePhases(st.session);
      if (st.session.phases[st.session.phaseIndex].type !== "break") { sendResponse({ ok: false, reason: "not-in-break" }); return; }
      await advancePhase("skipped-break");
      sendResponse({ ok: true });
    } else if (msg.type === "PARK_URGE") {
      const st = await getState();
      if (st.session) {
        const text = String(msg.text || "").slice(0, 200);
        st.session.urgeLog.push({ at: Date.now(), text, site: siteOf(text) });
        await chrome.storage.local.set({ session: st.session });
        sendResponse({ ok: true, count: st.session.urgeLog.length });
      } else sendResponse({ ok: false });
    } else if (msg.type === "GET_STATUS") {
      const st = await getState();
      if (st.session) {
        ensurePhases(st.session);
        // Prune search log outside the tripwire window.
        st.session.searchLog = (st.session.searchLog || []).filter((e) => Date.now() - e.at < SEARCH_WINDOW_MS);
        // Refresh pinned-tab identities live; mark closed tabs instead of dropping them.
        const fresh = [];
        for (const p of studyList(st.session)) {
          try {
            const t = await chrome.tabs.get(p.id);
            fresh.push({
              id: p.id,
              title: t.title || p.title || "",
              url: t.url || p.url || "",
              host: hostOf(t.url || p.url || ""),
              favIcon: t.favIconUrl || p.favIcon || "",
              closed: false,
            });
          } catch {
            fresh.push({ ...p, closed: true });
          }
        }
        st.session.studyTabs = fresh;
        await chrome.storage.local.set({ session: st.session });
      }
      const cur = await getState();
      sendResponse({ session: cur.session, switches: cur.switches, blocklist: cur.blocklist, pendingPins: cur.pendingPins || [] });
    }
  })();
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "tick") { updateBadge(); return; }
  if (alarm.name === "phase") { advancePhase("timer"); return; }
  if (alarm.name === "focusEnd") {
    const st = await getState();
    if (st.session) {
      await recordHistory(st.session, st.switches, true);
      await closeBreakTab(st.session);
    }
    await chrome.storage.local.set({ session: null });
    await chrome.alarms.clearAll();
    await chrome.action.setBadgeText({ text: "" }).catch(() => { });
    chrome.notifications.create({
      type: "basic", iconUrl: "icon128.png",
      title: "FocusLock — session complete",
      message: "2 hours done. Take a real break, you earned it.",
    });
  }
});

// ---- enforcement: blocklist + Tab-Switch Jail ----
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase()
      .replace(/^www\./, "")
      .replace(/^(m|mobile|new|old|beta|touch|i)\./, "");
  } catch { return ""; }
}

// Exact-or-subdomain match only. Suffix matching on the full entry
// ("facebook.com") already covers every real subdomain (m., mobile., new.,
// pro., touch.). Anything outside that is either open or a different domain —
// never match on bare substrings, so notfacebook.com stays open.
function hostBlocked(host, st) {
  for (const b of st.blocklist) {
    if (host === b || host.endsWith("." + b)) return b;
  }
  return null;
}

// One verdict for every URL. Single source of truth — background tabs events,
// webNavigation events, and content.js all apply the same answer:
// { verdict: "open" } or { verdict: "blocked", rule: "blocklist"|"youtube", entry? }.
function decide(url, st) {
  if (!st.session || !url) return { verdict: "open" };
  const host = hostOf(url);
  if (!host) return { verdict: "open" };
  if (hostBlocked(host, st) && !whitelisted(host, st)) {
    return { verdict: "blocked", rule: "blocklist", entry: hostBlocked(host, st) };
  }
  if (ytDistraction(url)) return { verdict: "blocked", rule: "youtube" };
  return { verdict: "open" };
}

function whitelisted(host, st) {
  return st.session && st.session.whitelist.some((w) => host === w || host.endsWith("." + w));
}

function blockedPage(rule, url) {
  return chrome.runtime.getURL("blocked.html") + "?from=" + encodeURIComponent(url) + (rule === "youtube" ? "&why=yt" : "");
}

function isAllowed(url, st) {
  return decide(url, st).verdict === "open";
}

// True while the session is in its enforced break (jail + counting paused, blocks stay on).
function inBreak(st) {
  if (!st.session) return false;
  const s = ensurePhases(st.session);
  return s.phases[s.phaseIndex].type === "break";
}

async function enforce(tabId, url, st) {
  st = st || (await getState());
  const v = decide(url, st);
  if (v.verdict === "blocked") {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url && tab.url.startsWith(chrome.runtime.getURL("blocked.html"))) return; // already bounced
    } catch { /* tab gone */ }
    await chrome.tabs.update(tabId, { url: blockedPage(v.rule, url) });
  }
}

// Covers navigations tabs.onUpdated misses: back/forward restores, prerender
// swaps, single-page-app history pushes, new-tab commits. Tabs events stay as
// the fallback; this is the authoritative net (needs "webNavigation" permission).
function wireNavigation() {
  if (!chrome.webNavigation || !chrome.webNavigation.onCommitted) return false;
  const bounce = (details) => {
    if (details.frameId !== 0) return; // top frame only
    (async () => {
      const st = await getState();
      const v = decide(details.url, st);
      if (v.verdict === "blocked") {
        try {
          const tab = await chrome.tabs.get(details.tabId);
          if (tab.url && tab.url.startsWith(chrome.runtime.getURL("blocked.html"))) return;
        } catch { /* tab gone */ }
        chrome.tabs.update(details.tabId, { url: blockedPage(v.rule, details.url) }).catch(() => {});
      }
    })();
  };
  chrome.webNavigation.onCommitted.addListener(bounce);
  chrome.webNavigation.onHistoryStateUpdated.addListener(bounce);
  return true;
}
wireNavigation();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  (async () => {
    const url = changeInfo.url || tab.url;
    if (changeInfo.url || changeInfo.status === "complete") enforce(tabId, url);
    // Search-spiral tripwire: log YouTube searches (navigation events only, no double-count).
    if (!changeInfo.url) return;
    const query = ytSearchQuery(changeInfo.url);
    if (!query) return;
    const st = await getState();
    if (!st.session) return;
    const s = ensurePhases(st.session);
    s.searchLog = (s.searchLog || []).filter((e) => Date.now() - e.at < SEARCH_WINDOW_MS);
    s.searchLog.push({ at: Date.now(), query });
    let nudged = false;
    if (s.searchLog.length >= SEARCH_THRESHOLD && Date.now() - (s.lastSearchNudgeAt || 0) > SEARCH_NUDGE_COOLDOWN_MS) {
      s.lastSearchNudgeAt = Date.now();
      nudged = true;
    }
    await chrome.storage.local.set({ session: s });
    if (nudged) {
      chrome.notifications.create({
        type: "basic", iconUrl: "icon128.png",
        title: "FocusLock — still studying?",
        message: `${s.searchLog.length} YouTube searches in 5 min (“${query}”). If the lecture sent you here, fine — otherwise, back to the video.`,
      });
    }
  })();
});

// Tab-Switch Jail: every switch during a FOCUS phase bounces back with escalating delay.
// Switches TO a pinned study tab are free (studying from 2 tabs is normal).
// During BREAK phases there is no jail and no counting — but blocklist + YT guard still apply.
let jailUntil = 0;
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const st = await getState();
  if (!st.session) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab ? tab.url : null;
  if (url && decide(url, st).verdict === "blocked") { enforce(tabId, url, st); return; }
  if (inBreak(st)) return; // break: free movement, blocks already handled above
  const pinnedIds = studyList(st.session).filter((t) => !t.closed).map((t) => t.id);
  if (pinnedIds.includes(tabId)) return; // study tab: no count, no jail
  const n = (st.switches || 0) + 1;
  await chrome.storage.local.set({ switches: n });
  if (Date.now() < jailUntil) return;
  // Jail: 3s + 2s per 5 switches, capped 20s. Feels annoying, not broken.
  const jailMs = Math.min(3000 + Math.floor(n / 5) * 2000, 20000);
  jailUntil = Date.now() + jailMs;
  const fromHost = hostOf(url || "");
  chrome.tabs.update(tabId, {
    url: chrome.runtime.getURL("jail.html") + `?n=${n}&wait=${Math.round(jailMs / 1000)}&from=` + encodeURIComponent(fromHost),
  });
});
