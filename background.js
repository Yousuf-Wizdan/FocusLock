// FocusLock service worker — authoritative state + single enforcement pipeline.
// Shared verdict logic lives in policy.js, state in store.js. No matcher
// regexes here: every decision goes through FocusLockPolicy.decide().
// No volatile session state: jail/bounce/completion all reconstruct from storage.
importScripts("policy.js", "store.js");

const P = globalThis.FocusLockPolicy;
const Store = globalThis.FocusLockStore;

const SEARCH_WINDOW_MS = 5 * 60 * 1000;
const SEARCH_THRESHOLD = 4;
const SEARCH_NUDGE_COOLDOWN_MS = 10 * 60 * 1000;
const PASS_MS = 2 * 60 * 1000;

// In-flight bounce tokens (per-process only, for debounce — recovery-safe
// because every bounce is also guarded by the ?fl= marker + storage stamp).
const bouncing = new Set();       // tabId currently being redirected
const lastBounceAt = new Map();   // tabId -> timestamp (debounce 1500ms)

/* ---------- phases ---------- */
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

function inBreak(st) {
  const s = st.session;
  return !!(s && Array.isArray(s.phases) && s.phases[s.phaseIndex]?.type === "break");
}

async function withCtx(st) {
  const blocklist = await Store.getBlocklist();
  const ctx = {
    sessionActive: !!st.session,
    blocklist,
    whitelist: st.session?.whitelist || [],
    passUntil: st.pass?.until || 0,
    passHost: st.pass?.host || "",
  };
  ctx.youtubeGuard = st.settings.youtubeGuard !== false;
  return ctx;
}

// decide() wrapper honoring the youtubeGuard setting.
function decideUrl(url, ctx) {
  if (!ctx.sessionActive) return { verdict: "open" };
  const v = P.decide(url, ctx);
  if (v.verdict === "blocked" && v.rule === "youtube" && ctx.youtubeGuard === false) {
    return { verdict: "open" };
  }
  return v;
}

/* ---------- badge ---------- */
function fmtLeft(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `${m}m`;
}

async function updateBadge(st) {
  try {
    st = st || (await Store.loadState()).state;
    if (!st.session) { await chrome.action.setBadgeText({ text: "" }); return; }
    await chrome.action.setBadgeBackgroundColor({ color: inBreak(st) ? "#B45309" : "#15803D" });
    await chrome.action.setBadgeText({ text: fmtLeft(st.session.phaseEndsAt - Date.now()) });
  } catch { /* ignore */ }
}

/* ---------- history / completion (exactly-once) ---------- */
async function completeSession(id, completed) {
  const { state: st } = await Store.loadState();
  if (!st.session || st.session.id !== id) return { ok: false, reason: "stale" };
  st._done = st._done || [];
  if (st._done.includes(id)) return { ok: false, reason: "already" };
  st._done.push(id);
  st._done = st._done.slice(-10);
  const s = st.session;
  st.history.push({
    id, endedAt: Date.now(), goal: s.goal || "",
    planned: s.plannedMinutes || 0, completed: !!completed,
    switches: st.switchCount || 0, urges: st.urges.length || 0,
    blocked: st.blockedCount || 0, breakSkipped: !!s.breakSkipped,
  });
  await closeBreakTab(s);
  st.session = null;
  st.pass = null;
  await Store.saveState(st);
  await chrome.alarms.clearAll();
  await chrome.action.setBadgeText({ text: "" }).catch(() => {});
  chrome.notifications.create({
    type: "basic", iconUrl: "icon128.png",
    title: "FocusLock — session complete",
    message: completed
      ? "Session complete. Take a real break — you earned it."
      : "Session ended. Your parked urges are in the popup.",
  });
  return { ok: true };
}

async function closeBreakTab(s) {
  if (s && Number.isInteger(s.breakTabId)) {
    try { await chrome.tabs.remove(s.breakTabId); } catch { /* closed */ }
  }
}

async function advancePhase() {
  const { state: st } = await Store.loadState();
  if (!st.session) return;
  const s = st.session;
  await closeBreakTab(s);
  s.breakTabId = null;
  s.phaseIndex += 1;
  if (s.phaseIndex >= s.phases.length) {
    await completeSession(s.id, true);
    return;
  }
  const phase = s.phases[s.phaseIndex];
  const now = Date.now();
  s.phaseStartedAt = now;
  s.phaseEndsAt = now + phase.minutes * 60 * 1000;
  await Store.saveState(st);
  chrome.alarms.create("phase", { when: s.phaseEndsAt });
  updateBadge(st);
  if (phase.type === "break") {
    chrome.notifications.create({
      type: "basic", iconUrl: "icon128.png",
      title: "FocusLock — break time",
      message: `Step away for ${phase.minutes} minutes. Switching is free during break; blocks stay on.`,
    });
    try {
      const t = await chrome.tabs.create({
        url: chrome.runtime.getURL("break.html") + "?fl=break&wait=" + phase.minutes, active: true,
      });
      s.breakTabId = t.id;
      const { state: st2 } = await Store.loadState();
      if (st2.session && st2.session.id === s.id) {
        st2.session.breakTabId = t.id;
        await Store.saveState(st2);
      }
    } catch { /* ignore */ }
  } else {
    chrome.notifications.create({
      type: "basic", iconUrl: "icon128.png",
      title: "FocusLock — break over",
      message: "Break over. Back to your study tab.",
    });
  }
}

/* ---------- enforcement: ONE pipeline ---------- */
// FocusLock pages carry ?fl=<kind> so every layer recognizes them idempotently.
function isOwnPage(url) {
  return !!url && url.startsWith(chrome.runtime.getURL(""));
}

function ownPage(kind, params) {
  return chrome.runtime.getURL(kind + ".html") + "?fl=" + kind + params;
}

// Last known good study tab — the safe "Back to study" target.
async function lastStudyTabId(st) {
  const tabs = st.studyTabs.filter((t) => Number.isInteger(t.id));
  const sorted = [...tabs].sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  for (const t of sorted) {
    try {
      const live = await chrome.tabs.get(t.id);
      if (live && live.url && !isOwnPage(live.url)) return t.id;
    } catch { /* dead */ }
  }
  return null;
}

async function enforce(tabId, url) {
  if (!url || isOwnPage(url)) return; // idempotent: never bounce our own pages
  const now = Date.now();
  if (bouncing.has(tabId)) return;
  if (now - (lastBounceAt.get(tabId) || 0) < 1500) return; // debounce races
  const { state: st } = await Store.loadState();
  if (!st.session) return;
  const ctx = await withCtx(st);
  const v = decideUrl(url, ctx);
  if (v.verdict !== "blocked") {
    healStudyTab(st, tabId, url); // reopened lecture heals its identity
    return;
  }
  bouncing.add(tabId);
  lastBounceAt.set(tabId, now);
  try {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url && isOwnPage(tab.url)) return;
    } catch { return; /* tab gone */ }
    st.blockedCount = (st.blockedCount || 0) + 1;
    await Store.saveState(st);
    const back = await lastStudyTabId(st);
    const dest = ownPage("blocked", `&rule=${v.rule || "blocklist"}&from=${encodeURIComponent(url)}&entry=${encodeURIComponent(v.entry || "")}${back ? `&back=${back}` : ""}`);
    await chrome.tabs.update(tabId, { url: dest });
  } catch { /* ignore */ }
  finally { setTimeout(() => bouncing.delete(tabId), 2000); }
}

// A pinned tab reopened under a new tab id reclaims its entry by canonical key.
async function healStudyTab(st, tabId, url) {
  const key = P.studyKey(url);
  if (!key) return false;
  const entry = st.studyTabs.find((t) => t.key === key);
  if (!entry || entry.id === tabId) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    entry.id = tabId;
    entry.url = url;
    entry.host = P.hostOf(url);
    entry.title = tab.title || entry.title;
    entry.favIcon = tab.favIconUrl || entry.favIcon;
    entry.lastSeenAt = Date.now();
    await Store.saveState(st);
    return true;
  } catch { return false; }
}

// Authoritative net: webNavigation sees SPA commits + bfcache + prerender swaps.
function wireNavigation() {
  if (!chrome.webNavigation?.onCommitted) return;
  const bounce = (details) => {
    if (details.frameId !== 0) return;
    enforce(details.tabId, details.url).catch(() => {});
  };
  chrome.webNavigation.onCommitted.addListener(bounce);
  chrome.webNavigation.onHistoryStateUpdated.addListener(bounce);
}

// Fallback for anything webNavigation misses (kept, debounced by enforce()).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url;
  if (changeInfo.url || changeInfo.status === "complete") {
    enforce(tabId, url).catch(() => {});
    if (changeInfo.url) logSearch(changeInfo.url).catch(() => {});
  }
});

// Search-spiral tripwire (navigation events only — no double count).
async function logSearch(url) {
  const query = P.ytSearchQuery(url);
  if (!query) return;
  const { state: st } = await Store.loadState();
  if (!st.session) return;
  const s = st.session;
  s.searchLog = (s.searchLog || []).filter((e) => Date.now() - e.at < SEARCH_WINDOW_MS);
  s.searchLog.push({ at: Date.now(), query });
  let nudged = false;
  if (s.searchLog.length >= SEARCH_THRESHOLD &&
      Date.now() - (s.lastSearchNudgeAt || 0) > SEARCH_NUDGE_COOLDOWN_MS) {
    s.lastSearchNudgeAt = Date.now();
    nudged = true;
  }
  await Store.saveState(st);
  if (nudged) {
    chrome.notifications.create({
      type: "basic", iconUrl: "icon128.png",
      title: "FocusLock — still studying?",
      message: `${s.searchLog.length} YouTube searches in 5 min ("${query}"). Lecture-driven is fine; spirals aren't.`,
    });
  }
}

/* ---------- tab-switch jail (persisted, SW-death-safe) ---------- */
function jailMsFor(n) {
  return Math.min(3000 + Math.floor(n / 5) * 2000, 20000);
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const { state: st } = await Store.loadState();
  if (!st.session) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab ? tab.url : null;
  if (!url || isOwnPage(url)) return;
  const ctx = await withCtx(st);
  if (decideUrl(url, ctx).verdict === "blocked") { enforce(tabId, url); return; }
  if (inBreak(st)) return;
  // Free: pinned study tab (by live id OR healed canonical key).
  const key = P.studyKey(url);
  const pinned = st.studyTabs.find((t) => t.id === tabId || (key && t.key === key));
  if (pinned) {
    pinned.id = tabId;
    pinned.lastSeenAt = Date.now();
    await Store.saveState(st);
    return;
  }
  if (!url.startsWith("http")) return; // extension/settings/internal pages are free
  st.switchCount = (st.switchCount || 0) + 1;
  const n = st.switchCount;
  st.switches.push({ at: Date.now(), fromHost: P.hostOf(url), rule: "switch", jailed: true });
  const jailMs = jailMsFor(n);
  st.jail = { until: Date.now() + jailMs, n }; // persisted — survives SW death
  await Store.saveState(st);
  const back = await lastStudyTabId(st);
  const dest = ownPage("jail", `&n=${n}&until=${st.jail.until}&from=${encodeURIComponent(P.hostOf(url) || "a new tab")}&curl=${encodeURIComponent(url)}${back ? `&back=${back}` : ""}`);
  chrome.tabs.update(tabId, { url: dest }).catch(() => {});
});

/* ---------- messages ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const { state: st } = await Store.loadState();

    if (msg.type === "START_SESSION") {
      const now = Date.now();
      const minutes = Math.min(240, Math.max(5, msg.minutes || 25));
      const whitelist = (msg.whitelist || []).map((h) => String(h).trim().toLowerCase()).filter(Boolean);
      const ctx = {
        sessionActive: true, blocklist: await Store.getBlocklist(), whitelist,
        passUntil: 0, passHost: "",
      };
      // Validate EVERYTHING against the verdict: current tab, tray, extras.
      const candidates = [];
      for (const t of [...(msg.studyTabs || []), ...st.pendingPins]) {
        const e = Store.normTab(t);
        if (e && e.url && decideUrl(e.url, ctx).verdict === "open") candidates.push(e);
      }
      const seen = new Set();
      const studyTabs = candidates.filter((t) => {
        if (seen.has(t.key)) return false;
        seen.add(t.key);
        return true;
      }).slice(0, 25);
      const phases = buildPhases(minutes);
      st.session = {
        id: "s-" + now + "-" + Math.floor(Math.random() * 1e6),
        goal: String(msg.goal || "").slice(0, 120),
        startedAt: now, endsAt: now + minutes * 60 * 1000, plannedMinutes: minutes,
        phases, phaseIndex: 0, phaseStartedAt: now,
        phaseEndsAt: now + phases[0].minutes * 60 * 1000,
        whitelist, breakTabId: null, lastSearchNudgeAt: 0,
        searchLog: [], breakSkipped: false,
      };
      st.studyTabs = studyTabs;
      st.pendingPins = [];
      st.switchCount = 0;
      st.switches = [];
      st.urges = [];
      st.emergencyPasses = st.emergencyPasses || [];
      st.pass = null;
      st.blockedCount = 0;
      st.jail = null;
      await Store.saveState(st);
      await chrome.alarms.clearAll();
      chrome.alarms.create("phase", { when: st.session.phaseEndsAt });
      chrome.alarms.create("focusEnd", { when: st.session.endsAt });
      chrome.alarms.create("tick", { periodInMinutes: 1 });
      updateBadge(st);
      sendResponse({ ok: true, pinned: studyTabs.length, id: st.session.id });
      return;
    }

    if (msg.type === "PIN_STUDY_TAB") {
      const entry = Store.normTab({
        id: msg.tabId, title: msg.title, url: msg.url,
        host: msg.host, favIcon: msg.favIcon,
      });
      if (!entry || !entry.url || isOwnPage(entry.url)) {
        sendResponse({ ok: false, reason: "blocked-page" }); return;
      }
      if ((!entry.title || !entry.host) && Number.isInteger(entry.id)) {
        try {
          const t = await chrome.tabs.get(entry.id);
          entry.title = entry.title || t.title || "";
          entry.url = entry.url || t.url || "";
          entry.host = P.hostOf(entry.url);
          entry.favIcon = entry.favIcon || t.favIconUrl || "";
          entry.key = P.studyKey(entry.url);
        } catch { /* tab gone */ }
      }
      // Blocked pages can NEVER be pinned — check against live verdict.
      const ctx = st.session
        ? await withCtx(st)
        : { sessionActive: true, blocklist: await Store.getBlocklist(), whitelist: [], passUntil: 0, passHost: "" };
      const v = decideUrl(entry.url, ctx);
      if (v.verdict === "blocked") {
        sendResponse({ ok: false, reason: "blocked-site", host: entry.host }); return;
      }
      if (st.session) {
        if (!st.studyTabs.some((t) => t.key === entry.key)) {
          st.studyTabs.push({ ...entry, lastSeenAt: Date.now() });
          await Store.saveState(st);
        }
        sendResponse({ ok: true, pending: false });
      } else {
        if (!st.pendingPins.some((t) => t.key === entry.key)) {
          st.pendingPins.push({ ...entry, lastSeenAt: Date.now() });
          await Store.saveState(st);
        }
        sendResponse({ ok: true, pending: true });
      }
      return;
    }

    if (msg.type === "UNPIN_STUDY_TAB") {
      const key = msg.key || "";
      const id = msg.tabId;
      const drop = (t) => (key ? t.key !== key : t.id !== id);
      st.studyTabs = st.studyTabs.filter(drop);
      st.pendingPins = st.pendingPins.filter(drop);
      await Store.saveState(st);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "END_SESSION") {
      if (st.session) {
        const r = await completeSession(st.session.id, false);
        sendResponse(r);
      } else sendResponse({ ok: false, reason: "no-session" });
      return;
    }

    if (msg.type === "SKIP_BREAK") {
      if (!st.session || !inBreak(st)) { sendResponse({ ok: false }); return; }
      st.session.breakSkipped = true;
      await Store.saveState(st);
      await advancePhase();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "PARK_URGE") {
      const text = String(msg.text || "").slice(0, 200);
      if (!text) { sendResponse({ ok: false }); return; }
      st.urges.push({ at: Date.now(), text, site: P.siteOf(text) });
      await Store.saveState(st);
      sendResponse({ ok: true, count: st.urges.length });
      return;
    }

    if (msg.type === "REQUEST_PASS") {
      if (!st.session || st.settings.emergencyPass === false) {
        sendResponse({ ok: false }); return;
      }
      const host = P.hostOf(msg.url || "");
      const reason = String(msg.reason || "").slice(0, 140);
      if (!host || !reason) { sendResponse({ ok: false }); return; }
      const until = Date.now() + PASS_MS;
      st.pass = { host, until };
      st.emergencyPasses.push({ at: Date.now(), host, reason, until });
      await Store.saveState(st);
      sendResponse({ ok: true, until });
      return;
    }

    if (msg.type === "GET_STATUS") {
      if (st.session) {
        st.session.searchLog = (st.session.searchLog || [])
          .filter((e) => Date.now() - e.at < SEARCH_WINDOW_MS);
        for (const p of st.studyTabs) {
          if (!Number.isInteger(p.id)) continue;
          try {
            const t = await chrome.tabs.get(p.id);
            if (t.url && P.studyKey(t.url) === p.key) {
              p.title = t.title || p.title;
              p.favIcon = t.favIconUrl || p.favIcon;
              p.url = t.url;
              p.lastSeenAt = Date.now();
            }
          } catch { /* closed — key survives for healing */ }
        }
        await Store.saveState(st);
      }
      const liveIds = new Set();
      try {
        const all = await chrome.tabs.query({});
        for (const t of all) liveIds.add(t.id);
      } catch { /* ignore */ }
      const tabs = st.studyTabs.map((t) => ({
        ...t, closed: Number.isInteger(t.id) ? !liveIds.has(t.id) : true,
      }));
      sendResponse({
        session: st.session, studyTabs: tabs,
        pendingPins: st.pendingPins,
        switches: st.switchCount || 0, switchLog: (st.switches || []).slice(-10),
        urges: st.urges.slice(-10), urgeCount: st.urges.length,
        blocked: st.blockedCount || 0,
        history: st.history.slice(-30),
        settings: st.settings,
        jail: st.jail || null,
        inBreak: inBreak(st),
      });
      return;
    }

    if (msg.type === "SAVE_SETTINGS") {
      st.settings = Object.assign(st.settings || {}, msg.settings || {});
      await Store.saveState(st);
      sendResponse({ ok: true, settings: st.settings });
      return;
    }

    if (msg.type === "SET_BLOCKLIST") {
      const defs = new Set(P.DEFAULT_BLOCKLIST);
      const customs = [...new Set((msg.customs || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))]
        .filter((d) => !defs.has(d) && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
      const removed = [...defs].filter((d) => !(msg.defaults || []).includes(d));
      await chrome.storage.local.set({ customBlocklist: customs, removedDefaults: removed });
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "GET_BLOCKLIST") {
      const got = await chrome.storage.local.get(["customBlocklist", "removedDefaults"]);
      sendResponse({
        defaults: P.DEFAULT_BLOCKLIST.filter((d) => !(got.removedDefaults || []).includes(d)),
        customs: got.customBlocklist || [],
        removed: got.removedDefaults || [],
        allDefaults: P.DEFAULT_BLOCKLIST,
      });
      return;
    }

    if (msg.type === "CLEAR_HISTORY") {
      st.history = [];
      await Store.saveState(st);
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, reason: "unknown" });
  })();
  return true;
});

/* ---------- alarms ---------- */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "tick") { updateBadge(); return; }
  const { state: st } = await Store.loadState();
  if (!st.session) { await chrome.alarms.clearAll(); return; }
  if (alarm.name === "phase") { advancePhase(); return; }
  if (alarm.name === "focusEnd") { completeSession(st.session.id, true); return; }
});

/* ---------- recovery on SW startup ---------- */
(async function recover() {
  wireNavigation();
  try {
    const { state: st } = await Store.loadState();
    if (!st.session) return;
    const now = Date.now();
    if (st.session.endsAt <= now) {
      await completeSession(st.session.id, true);
      return;
    }
    if (st.session.phaseEndsAt <= now) {
      await advancePhase();
      const { state: st2 } = await Store.loadState();
      updateBadge(st2);
      if (st2.session) {
        await chrome.alarms.clearAll();
        chrome.alarms.create("phase", { when: st2.session.phaseEndsAt });
        chrome.alarms.create("focusEnd", { when: st2.session.endsAt });
        chrome.alarms.create("tick", { periodInMinutes: 1 });
      }
      return;
    }
    await chrome.alarms.clearAll();
    chrome.alarms.create("phase", { when: st.session.phaseEndsAt });
    chrome.alarms.create("focusEnd", { when: st.session.endsAt });
    chrome.alarms.create("tick", { periodInMinutes: 1 });
    updateBadge(st);
  } catch { /* fail safe: blocker defaults to open when state is unreadable */ }
})();
