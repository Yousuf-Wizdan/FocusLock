// FocusLock background service worker — sessions with enforced breaks,
// tab-switch jail, blocklist + YouTube study guard, search-spiral tripwire.

const BLOCKLIST_VERSION = 2;
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

// ---- phases (break enforcement) ----
// 120-min default -> 50 focus, 10 break, 60 focus. Shorter sessions scale down;
// under 60 min is a single focus block with no break.
function buildPhases(minutes) {
  if (minutes >= 70) return [
    { type: "focus", minutes: 50 },
    { type: "break", minutes: 10 },
    { type: "focus", minutes: minutes - 60 },
  ];
  return [{ type: "focus", minutes }];
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
    chrome.notifications.create({
      type: "basic", iconUrl: "icon128.png",
      title: "FocusLock — break time",
      message: `50 minutes done. Step away for 10 — no tabs, no phone. Switching is free during break; blocks stay on.`,
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
      const phases = buildPhases(minutes);
      const session = {
        startedAt: now, endsAt: now + minutes * 60 * 1000, plannedMinutes: minutes,
        whitelist, studyTabs, urgeLog: [], searchLog: [],
        phases, phaseIndex: 0, phaseEndsAt: now + phases[0].minutes * 60 * 1000,
        phaseStartedAt: now,
        lastSearchNudgeAt: 0, breakTabId: null,
      };
      await chrome.storage.local.set({ session, switches: 0 });
      await chrome.alarms.clearAll();
      chrome.alarms.create("phase", { when: session.phaseEndsAt });
      chrome.alarms.create("focusEnd", { when: session.endsAt });
      chrome.alarms.create("tick", { periodInMinutes: 1 });
      updateBadge();
      const plan = phases.map((p) => `${p.minutes}m ${p.type}`).join(" → ");
      sendResponse({ ok: true, plan });
    } else if (msg.type === "PIN_STUDY_TAB") {
      const st = await getState();
      if (!st.session) { sendResponse({ ok: false, reason: "no-session" }); return; }
      const tabs = studyList(st.session);
      if (Number.isInteger(msg.tabId) && !tabs.some((t) => t.id === msg.tabId)) {
        let meta = { title: msg.title || "", url: msg.url || "", favIcon: msg.favIcon || "" };
        if ((!meta.url || !meta.title) && Number.isInteger(msg.tabId)) {
          try {
            const t = await chrome.tabs.get(msg.tabId);
            meta = { title: t.title || meta.title, url: t.url || meta.url, favIcon: t.favIconUrl || meta.favIcon };
          } catch { /* ignore */ }
        }
        tabs.push({ id: msg.tabId, title: meta.title, url: meta.url, host: msg.host || hostOf(meta.url || ""), favIcon: meta.favIcon, closed: false });
        st.session.studyTabs = tabs;
        await chrome.storage.local.set({ session: st.session });
      }
      sendResponse({ ok: true, studyTabs: studyList(st.session) });
    } else if (msg.type === "UNPIN_STUDY_TAB") {
      const st = await getState();
      if (st.session) {
        st.session.studyTabs = studyList(st.session).filter((t) => t.id !== msg.tabId);
        await chrome.storage.local.set({ session: st.session });
      }
      sendResponse({ ok: true });
    } else if (msg.type === "END_SESSION") {
      const st = await getState();
      if (st.session) await closeBreakTab(st.session);
      await chrome.storage.local.set({ session: null });
      await chrome.alarms.clearAll();
      await chrome.action.setBadgeText({ text: "" }).catch(() => {});
      sendResponse({ ok: true });
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
      sendResponse({ session: cur.session, switches: cur.switches, blocklist: cur.blocklist });
    }
  })();
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "tick") { updateBadge(); return; }
  if (alarm.name === "phase") { advancePhase("timer"); return; }
  if (alarm.name === "focusEnd") {
    const st = await getState();
    if (st.session) await closeBreakTab(st.session);
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
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

// Match a host against the blocklist. Suffix match covers subdomains
// (m., new., old., pro.), but bare "facebook" in a hostname only counts
// when it is the registrable domain — mobile.facebook.com yes,
// notfacebook.com and myfacebookclone.com no.
function hostBlocked(host, st) {
  for (const b of st.blocklist) {
    if (host === b || host.endsWith("." + b)) return b;
    const base = b.split(".")[0];
    if (base.length >= 4 && host.includes(base)) {
      // Suspicious lookalikes (m.facebook.com.attacker.com): still check the
      // registrable tail — block only when the tail itself is the entry.
      const tail = host.split(".").slice(-b.split(".").length).join(".");
      if (tail === b) return b;
    }
  }
  return null;
}

function isAllowed(url, st) {
  const host = hostOf(url);
  if (!host) return true;
  if (!hostBlocked(host, st)) return true;
  if (st.session && st.session.whitelist.some((w) => host === w || host.endsWith("." + w))) return true;
  return false;
}

// True while the session is in its enforced break (jail + counting paused, blocks stay on).
function inBreak(st) {
  if (!st.session) return false;
  const s = ensurePhases(st.session);
  return s.phases[s.phaseIndex].type === "break";
}

async function enforce(tabId, url, st) {
  st = st || (await getState());
  if (!st.session || !url) return;
  if (!isAllowed(url, st)) {
    await chrome.tabs.update(tabId, { url: chrome.runtime.getURL("blocked.html") + "?from=" + encodeURIComponent(url) });
  } else if (ytDistraction(url)) {
    // YouTube study guard: watch/search stay open, Shorts/feed/trending bounce.
    await chrome.tabs.update(tabId, { url: chrome.runtime.getURL("blocked.html") + "?from=" + encodeURIComponent(url) + "&why=yt" });
  }
}

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
  if (url && !isAllowed(url, st)) { enforce(tabId, url, st); return; }
  if (url && ytDistraction(url)) { enforce(tabId, url, st); return; }
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
