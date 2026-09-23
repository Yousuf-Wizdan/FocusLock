/* FocusLock storage layer — versioned state, migration, bounded arrays.
 * Loaded via importScripts AFTER policy.js in the service worker.
 * Key: "fl_state_v2". v1 keys (session/switches/blocklist/history/pendingPins)
 * are migrated once, then deleted.
 */
(() => {
  "use strict";

  const STATE_KEY = "fl_state_v2";
  const V1_KEYS = ["session", "switches", "blocklist", "blocklistVersion", "pendingPins", "history"];
  const MAX_HISTORY = 30;
  const MAX_URGES = 200;
  const MAX_STUDY_TABS = 25;

  function defaultSettings() {
    return {
      defaultMinutes: 25,
      youtubeGuard: true,   // false = allow all YouTube in sessions
      emergencyPass: true,  // allow a deliberate 2-min pass with logged reason
      theme: "system",      // light | dark | system
      reduceMotion: false,
    };
  }

  function blankState() {
    return {
      version: 2,
      session: null,      // { id, goal, startedAt, endsAt, plannedMinutes,
                          //   phases, phaseIndex, phaseStartedAt, phaseEndsAt,
                          //   whitelist, breakTabId, lastSearchNudgeAt,
                          //   searchLog, breakSkipped }
      studyTabs: [],      // [{ id, key, url, urlCanon, host, title, favIcon, lastSeenAt }]
      pendingPins: [],    // same shape, idle tray
      switches: 0,        // [{ at, fromHost, rule, jailed }]
      switchCount: 0,
      urges: [],          // [{ at, text, site }]
      emergencyPasses: [],// [{ at, host, reason, until }]
      pass: null,         // { host, until } — active emergency pass
      history: [],        // [{ id, endedAt, goal, planned, completed, switches,
                          //   urges, blocked, breakSkipped }]
      blockedCount: 0,
      settings: defaultSettings(),
    };
  }

  function asArray(v) { return Array.isArray(v) ? v : []; }

  // tab shape normalizer — always produce { id, key, url, host, title, favIcon }.
  function normTab(t) {
    if (!t) return null;
    const P = globalThis.FocusLockPolicy;
    const url = t.url || t.urlCanon || "";
    const host = t.host || (P ? P.hostOf(url) : "");
    const entry = {
      id: Number.isInteger(t.id) ? t.id : null,
      key: t.key || (P ? P.studyKey(url) : url) || "",
      url,
      host,
      title: t.title || "",
      favIcon: t.favIcon || "",
      lastSeenAt: t.lastSeenAt || Date.now(),
    };
    if (!entry.key && !entry.url) return null;
    return entry;
  }

  function migrateV1(v1) {
    const P = globalThis.FocusLockPolicy;
    const st = blankState();
    if (!v1) return st;
    const s = v1.session;
    if (s && typeof s === "object") {
      st.session = {
        id: "mig-" + Date.now(),
        goal: "",
        startedAt: s.startedAt || Date.now(),
        endsAt: s.endsAt || (Date.now() + 25 * 60000),
        plannedMinutes: s.plannedMinutes || 25,
        phases: Array.isArray(s.phases) && s.phases.length
          ? s.phases : [{ type: "focus", minutes: s.plannedMinutes || 25 }],
        phaseIndex: Number.isInteger(s.phaseIndex) ? s.phaseIndex : 0,
        phaseStartedAt: s.phaseStartedAt || s.startedAt || Date.now(),
        phaseEndsAt: s.phaseEndsAt || s.endsAt || (Date.now() + 25 * 60000),
        whitelist: asArray(s.whitelist),
        breakTabId: Number.isInteger(s.breakTabId) ? s.breakTabId : null,
        lastSearchNudgeAt: s.lastSearchNudgeAt || 0,
        searchLog: asArray(s.searchLog),
        breakSkipped: false,
      };
      const rawTabs = asArray(s.studyTabs).concat(
        asArray(s.studyTabIds).map((id) => ({ id }))
      );
      st.studyTabs = rawTabs.map(normTab).filter(Boolean).slice(0, MAX_STUDY_TABS);
    }
    st.pendingPins = asArray(v1.pendingPins).map(normTab).filter(Boolean).slice(0, MAX_STUDY_TABS);
    // v1 switches was a bare number; keep the count, drop fake detail rows.
    st.switchCount = typeof v1.switches === "number" ? v1.switches : 0;
    st.switches = [];
    // v1 urgeLog lived on the session.
    const urgeLog = (s && asArray(s.urgeLog)) || [];
    st.urges = urgeLog.map((u) => ({
      at: u.at || Date.now(), text: String(u.text || "").slice(0, 200),
      site: u.site || (P ? P.siteOf(u.text) : ""),
    })).slice(-MAX_URGES);
    st.history = asArray(v1.history).map((h) => ({
      id: "mig-" + (h.endedAt || Date.now()) + "-" + Math.floor(Math.random() * 1e6),
      endedAt: h.endedAt || Date.now(), goal: "",
      planned: h.planned || 0, completed: !!h.completed,
      switches: h.switches || 0, urges: h.urges || 0,
      blocked: 0, breakSkipped: false,
    })).slice(-MAX_HISTORY);
    // Merge blocklist: user customs + new defaults.
    const P2 = globalThis.FocusLockPolicy;
    const merged = new Set(asArray(v1.blocklist));
    for (const d of (P2 ? P2.DEFAULT_BLOCKLIST : [])) merged.add(d);
    st._migratedBlocklist = [...merged];
    return st;
  }

  async function loadState() {
    const got = await chrome.storage.local.get([STATE_KEY, ...V1_KEYS]);
    if (got[STATE_KEY] && typeof got[STATE_KEY] === "object" && got[STATE_KEY].version === 2) {
      const st = Object.assign(blankState(), got[STATE_KEY]);
      st.settings = Object.assign(defaultSettings(), st.settings || {});
      return { state: st, migrated: false };
    }
    // Migrate v1 (or blank).
    const hasV1 = V1_KEYS.some((k) => got[k] !== undefined);
    const st = migrateV1(hasV1 ? got : null);
    if (st._migratedBlocklist) {
      try {
        const cur = await chrome.storage.local.get(["customBlocklist"]);
        const extra = new Set([...(cur.customBlocklist || []), ...st._migratedBlocklist]);
        // Store only user-added entries beyond defaults as custom.
        const P = globalThis.FocusLockPolicy;
        const defs = new Set(P ? P.DEFAULT_BLOCKLIST : []);
        await chrome.storage.local.set({
          customBlocklist: [...extra].filter((d) => !defs.has(d)),
        });
      } catch { /* best effort */ }
      delete st._migratedBlocklist;
    }
    await chrome.storage.local.set({ [STATE_KEY]: st });
    try { await chrome.storage.local.remove(V1_KEYS); } catch { /* ignore */ }
    return { state: st, migrated: true };
  }

  // Effective blocklist = defaults + user customs. Customs in separate key
  // so options page edits never clobber default updates.
  async function getBlocklist() {
    const P = globalThis.FocusLockPolicy;
    const defs = P ? P.DEFAULT_BLOCKLIST : [];
    try {
      const got = await chrome.storage.local.get(["customBlocklist", "removedDefaults"]);
      const removed = new Set(got.removedDefaults || []);
      const list = defs.filter((d) => !removed.has(d)).concat(got.customBlocklist || []);
      return [...new Set(list)];
    } catch { return [...defs]; }
  }

  async function saveState(st) {
    // Enforce bounds (quota-safe forever).
    st.history = asArray(st.history).slice(-MAX_HISTORY);
    st.urges = asArray(st.urges).slice(-MAX_URGES);
    st.studyTabs = asArray(st.studyTabs).slice(0, MAX_STUDY_TABS);
    st.pendingPins = asArray(st.pendingPins).slice(0, MAX_STUDY_TABS);
    st.switchCount = st.switchCount || asArray(st.switches).length;
    await chrome.storage.local.set({ [STATE_KEY]: st });
  }

  const api = { STATE_KEY, MAX_HISTORY, blankState, normTab, loadState, getBlocklist, saveState };
  if (typeof self !== "undefined") self.FocusLockStore = api;
  if (typeof globalThis !== "undefined") globalThis.FocusLockStore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
