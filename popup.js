/* FocusLock popup v3 — state-based UI on the design system.
 * States: FIRST_RUN, IDLE, SETUP, FOCUS, PAUSED, BREAK, COMPLETED(debrief).
 * Message contract (background.js) is unchanged: GET_STATUS, START_SESSION,
 * PIN_STUDY_TAB, UNPIN_STUDY_TAB, FOCUS_TAB, PAUSE_SESSION, RESUME_SESSION,
 * END_SESSION, SKIP_BREAK, PARK_URGE, SAVE_SETTINGS, SAVE_NEXT_GOAL,
 * COMPLETE_ONBOARDING, GET_BLOCKLIST.
 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const { esc, fmtClock, ago, initTheme, toast, dialog, icon, fav } = window.FL;

  // ---------- setup draft (survives popup close) ----------
  const draft = { goal: "", minutes: 25 };

  let cached = null;      // last GET_STATUS
  let uiState = "IDLE";   // FIRST_RUN | IDLE | SETUP | FOCUS | PAUSED | BREAK | COMPLETED
  let setupStudyTabs = []; // study-tabs snapshot shown inside SETUP
  let lastHistoryLen = -1;
  let currentView = "focus";

  async function status() {
    try { cached = await chrome.runtime.sendMessage({ type: "GET_STATUS" }); }
    catch { /* worker asleep — keep cache */ }
    return cached;
  }

  function phaseInfo(s) {
    const phases = Array.isArray(s.phases) ? s.phases : [{ type: "focus", minutes: s.plannedMinutes || 25 }];
    const idx = Math.min(s.phaseIndex || 0, phases.length - 1);
    const focuses = phases.filter((p) => p.type === "focus").length;
    const focusNo = phases.slice(0, idx + 1).filter((p) => p.type === "focus").length;
    return { phases, idx, cur: phases[idx], focuses, focusNo };
  }

  function planText(minutes) {
    if (minutes <= 25) return `${minutes} min single block, no break.`;
    if (minutes < 70) return `${minutes} min · 25 focus, 5 break, ${minutes - 30} focus.`;
    return `${minutes} min · 50 focus, 10 break, ${minutes - 60} focus.`;
  }

  // ---------- tabs ----------
  document.querySelectorAll("nav.tabs button").forEach((b) => {
    b.onclick = () => switchView(b.dataset.view);
  });
  function switchView(v) {
    currentView = v;
    for (const name of ["focus", "journal", "sites"]) {
      $("view-" + name).classList.toggle("on", name === v);
      $("tab-" + name).setAttribute("aria-selected", name === v ? "true" : "false");
    }
  }

  $("gearBtn").innerHTML = icon("gear");
  $("gearBtn").onclick = () => chrome.runtime.openOptionsPage();
  $("editSites").onclick = () => chrome.runtime.openOptionsPage();

  // ---------- main render ----------
  async function refresh() {
    const st = await status();
    if (!st) return;
    applyThemeSetting(st);
    // A session that ended while the popup was closed: show the debrief once.
    const hlen = (st.history || []).length;
    if (!st.session && lastHistoryLen >= 0 && hlen > lastHistoryLen) {
      uiState = "COMPLETED";
    }
    lastHistoryLen = hlen;
    const next = computeState(st);
    // COMPLETED persists until the user acts (Save & finish / Study again).
    if (next === "COMPLETED" || (uiState === "COMPLETED" && !st.session)) {
      uiState = "COMPLETED";
      renderHead(st);
      renderDebrief(st);
      renderJournal(st);
      renderSites(st);
      return;
    }
    uiState = next;
    renderHead(st);
    renderFocus(st);
    renderJournal(st);
    renderSites(st);
  }

  function computeState(st) {
    if (!st.session) {
      if (uiState === "COMPLETED" && lastHistoryLen === (st.history || []).length) return "COMPLETED";
      if (st.settings && st.settings.onboarded === false &&
          (!st.history || !st.history.length) && lastHistoryLen <= 0) return "FIRST_RUN";
      if (uiState === "SETUP") return "SETUP";
      return "IDLE";
    }
    if (st.session.pausedAt) return "PAUSED";
    const { cur } = phaseInfo(st.session);
    return cur.type === "break" ? "BREAK" : "FOCUS";
  }

  function applyThemeSetting(st) {
    const t = (st.settings && st.settings.theme) || "system";
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }

  function renderHead(st) {
    const live = !!st.session;
    $("liveDot").style.visibility = live ? "visible" : "hidden";
    $("headSub").textContent =
      uiState === "FIRST_RUN" ? "Welcome" :
      uiState === "SETUP" ? "Start a session" :
      uiState === "PAUSED" ? "Paused" :
      uiState === "BREAK" ? "Break" :
      uiState === "COMPLETED" ? "Session summary" :
      live ? "Study session" : "Ready to focus?";
  }

  // ---------- FOCUS view ----------
  function renderFocus(st) {
    const host = $("stateHost");
    if (uiState === "FIRST_RUN") return void (host.innerHTML = viewFirstRun(st));
    if (uiState === "IDLE") return void (host.innerHTML = viewIdle(st));
    if (uiState === "SETUP") return void (host.innerHTML = viewSetup(st));
    if (uiState === "COMPLETED") return; // debrief renders itself
    host.innerHTML = viewActive(st);
    wireActive(st);
  }

  function viewFirstRun(st) {
    setTimeout(() => {
      const b = $("frStart");
      if (b) b.onclick = () => { uiState = "SETUP"; awaitRefresh(); };
      const c = $("frSkip");
      if (c) c.onclick = async () => {
        await chrome.runtime.sendMessage({ type: "COMPLETE_ONBOARDING" });
        uiState = "IDLE";
        refresh();
      };
    }, 0);
    return `
      <section class="section" aria-label="Welcome">
        <h2>FocusLock</h2>
        <h1 style="font-size:19px">Protect your study time.</h1>
        <p class="lede">A simple guard for the sites that pull you away. I&rsquo;ve got you. Let&rsquo;s focus.</p>
        <div class="controls">
          <button class="btn btn-primary" id="frStart">Get started</button>
          <button class="btn btn-quiet" id="frSkip">Skip</button>
        </div>
      </section>
      <section class="section" aria-label="Recent">
        <h2>How it works</h2>
        <div class="hint">Pin your lecture. Start a timer. Shorts and feeds wait until you&rsquo;re done.</div>
      </section>`;
  }

  function historyRows(history, max) {
    const rows = (history || []).slice(-(max || 3)).reverse();
    if (!rows.length) return `<div class="empty">No sessions yet. Your recent focus will appear here.</div>`;
    return rows.map((h) => {
      const d = new Date(h.endedAt);
      const label = d.toLocaleDateString(undefined, { weekday: "short" });
      const dur = h.focusedMinutes ? `${h.focusedMinutes} min` : `${h.planned} min`;
      const tail = h.completed ? `${h.switches} switches` : "ended early";
      return `<div class="recent-row"><span>${label} · ${esc(h.goal || "Focus")}</span><span class="m">${dur} · ${tail}</span></div>`;
    }) .join("");
  }

  function viewIdle(st) {
    const lastGoal = (st.settings && (draft.goal || st.settings.lastGoal || st.settings.nextGoal)) || "";
    const dm = (st.settings && st.settings.defaultMinutes) || 25;
    const mins = [25, 50, 120];
    setTimeout(() => {
      const g = $("goalInput");
      if (g) { g.value = lastGoal; g.oninput = () => { draft.goal = g.value; }; }
      document.querySelectorAll("#setupSec .seg button").forEach((b) => {
        b.onclick = () => {
          draft.minutes = parseInt(b.dataset.min, 10);
          document.querySelectorAll("#setupSec .seg button").forEach((x) =>
            x.setAttribute("aria-pressed", x === b ? "true" : "false"));
        };
      });
      $("startBtn").onclick = startFromIdle;
      const pin = $("pinIdleBtn");
      if (pin) pin.onclick = pinCurrentTab;
    }, 0);
    const tray = (st.pendingPins || []);
    return `
      <section class="section" id="setupSec" aria-label="Ready to focus">
        <h2>Ready to focus?</h2>
        <p class="lede">A distraction-free block for your next study session.</p>
        <div class="field"><label for="goalInput">Goal</label>
          <input class="input" id="goalInput" type="text" maxlength="120" placeholder="Operating Systems — revision" autocomplete="off"></div>
        <div class="field"><label id="durLabel">Duration</label>
          <div class="seg" role="group" aria-labelledby="durLabel">
            ${mins.map((m) => `<button data-min="${m}" aria-pressed="${(draft.minutes || dm) === m}">${m}<small>${m <= 25 ? "sprint" : m <= 50 ? "deep" : "marathon"}</small></button>`).join("")}
          </div></div>
        <div class="controls">
          <button class="btn btn-secondary" id="pinIdleBtn">Pin this tab</button>
          <button class="btn btn-primary" id="startBtn">Start session</button>
        </div>
        ${tray.length ? `<div class="hint">${tray.length} pinned for next session — see Sites.</div>` : ""}
      </section>
      <section class="section" aria-label="Recent">
        <h2>Recent</h2>
        ${historyRows(st.history, 3)}
      </section>`;
  }

  function viewSetup(st) {
    const dm = (st.settings && st.settings.defaultMinutes) || 25;
    if (![25, 50, 120].includes(draft.minutes)) draft.minutes = dm;
    setTimeout(async () => {
      const g = $("goalInput2");
      if (g) { g.value = draft.goal; g.oninput = () => { draft.goal = g.value; }; g.focus(); }
      document.querySelectorAll("#setupFull .seg button").forEach((b) => {
        b.onclick = () => {
          draft.minutes = parseInt(b.dataset.min, 10);
          document.querySelectorAll("#setupFull .seg button").forEach((x) =>
            x.setAttribute("aria-pressed", x === b ? "true" : "false"));
          $("setupPlan").textContent = planText(draft.minutes);
        };
      });
      $("backIdle").onclick = () => { uiState = "IDLE"; refresh(); };
      $("startBtn2").onclick = startFromIdle;
      try {
        const cur = await chrome.tabs.query({ active: true, currentWindow: true });
        const t = cur && cur[0];
        setupStudyTabs = t && t.url ? [{ title: t.title || "", url: t.url, host: "", favIcon: t.favIconUrl || "" }] : [];
      } catch { setupStudyTabs = []; }
      const box = $("setupTabs");
      if (box) {
        box.innerHTML = setupStudyTabs.length
          ? `<div class="rowline">${fav(setupStudyTabs[0])}<div class="grow"><div class="t">${esc(setupStudyTabs[0].title || "Current tab")}</div><div class="s">Joins the session if it passes the guard</div></div></div>`
          : `<div class="empty"><b>No study pages yet.</b><br>Open your lecture and pin it here.</div>`;
      }
      const bl = await chrome.runtime.sendMessage({ type: "GET_BLOCKLIST" }).catch(() => null);
      const n = bl ? (bl.defaults || []).length + (bl.customs || []).length : 0;
      const nb = $("setupBlocked");
      if (nb) nb.textContent = n ? `${n} sites paused` : "Distraction list is empty";
    }, 0);
    return `
      <section class="section" id="setupFull" aria-label="Start a session">
        <div style="display:flex;align-items:center;gap:8px">
          <button class="icon-btn" id="backIdle" aria-label="Back">${icon("back")}</button>
          <h1 style="font-size:15px">Start a session</h1>
        </div>
        <div class="field"><label for="goalInput2">What are you studying?</label>
          <input class="input" id="goalInput2" type="text" maxlength="120" placeholder="Database Management Systems" autocomplete="off"></div>
        <div class="field"><label id="durLabel2">How long?</label>
          <div class="seg" role="group" aria-labelledby="durLabel2">
            ${[25, 50, 120].map((m) => `<button data-min="${m}" aria-pressed="${(draft.minutes || dm) === m}">${m}<small>${m <= 25 ? "sprint" : m <= 50 ? "deep" : "marathon"}</small></button>`).join("")}
          </div>
          <div class="hint" id="setupPlan">${planText(draft.minutes || dm)}</div></div>
        <div class="field"><label>Study pages</label><div id="setupTabs"></div></div>
        <div class="field"><label>Distractions</label><div class="hint" id="setupBlocked">…</div></div>
        <div class="controls"><button class="btn btn-primary btn-block" id="startBtn2">Start</button></div>
      </section>`;
  }

  function viewActive(st) {
    const s = st.session;
    const { phases, idx, cur, focuses, focusNo } = phaseInfo(s);
    const isBreak = cur.type === "break";
    const paused = !!s.pausedAt;
    const anchor = isBreak ? s.phaseEndsAt : s.endsAt;
    const upcoming = phases.slice(idx + 1).map((p) => `${p.minutes}m ${p.type}`).join(" · ");
    const phaseLabel = paused ? "Paused" : isBreak ? "Break" : focuses > 1 ? `Focus ${focusNo} of ${focuses}` : "Focus";
    const tabs = st.studyTabs || [];
    const leftMs = paused ? Math.max(0, anchor - s.pausedAt) : Math.max(0, anchor - Date.now());
    return `
      <section class="card timer-wrap" aria-label="Session timer" aria-live="polite">
        <div class="phase">${esc(phaseLabel)}</div>
        <div class="timer-big" id="bigTime">${fmtClock(Math.max(0, leftMs))}</div>
        <div class="progress" aria-hidden="true"><i id="bigBar"></i></div>
        ${s.goal ? `<div class="goal">Studying: ${esc(s.goal)}</div>` : ""}
        <div class="next" id="nextLine">${nextLine(st, isBreak, paused, upcoming)}</div>
      </section>
      <section class="section" aria-label="Session controls">
        <div class="controls">
          ${paused
            ? `<button class="btn btn-primary" id="resumeBtn">${icon("play", 14)} Resume</button>`
            : isBreak
              ? `<button class="btn btn-secondary" id="finishBreakEarly">Finish break early</button>`
              : `<button class="btn btn-secondary" id="pauseBtn">${icon("pause", 14)} Pause</button>`}
          <button class="btn btn-secondary" id="endBtn">End session</button>
        </div>
      </section>
      <section class="section" aria-label="Current study">
        <h2>Current study</h2>
        <div id="studyList">${studyRows(tabs)}</div>
      </section>
      <section class="stats" aria-label="Session stats" style="border:1px solid var(--border);border-radius:var(--radius-sm)">
        <div><b>${st.switches || 0}</b><span>switches</span></div>
        <div><b>${st.urgeCount || 0}</b><span>parked</span></div>
        <div><b>${st.blocked || 0}</b><span>paused</span></div>
      </section>`;
  }

  function nextLine(st, isBreak, paused, upcoming) {
    if (paused) return "Paused — the clock is frozen.";
    const s = st.session;
    if (isBreak) return `Next: focus${upcoming ? " · " + esc(upcoming) : ""}`;
    const left = Math.max(0, Math.round(((s.phaseEndsAt || s.endsAt) - Date.now()) / 60000));
    if (upcoming) return `Next break in ${left} min · then ${esc(upcoming)}`;
    return `Ends ${new Date(s.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }

  function studyRows(tabs) {
    if (!tabs.length) return `<div class="empty"><b>No study pages yet.</b><br>Open your lecture and pin it here.</div>`;
    const rows = tabs.slice(0, 5).map((t) => `
      <div class="rowline" data-key="${esc(t.key || t.id)}" role="button" tabindex="0" title="Go to this tab" aria-label="Go to ${esc(t.title || t.host || "study tab")}">
        ${fav(t)}
        <div class="grow">
          <div class="t">${esc(t.title || t.host || "Untitled tab")}</div>
          <div class="s">${t.closed ? "Closed — reopen the URL and it rejoins" : `${esc(t.host || "")} · Protected`}</div>
        </div>
        <span class="dot-live" aria-hidden="true"></span>
        <button class="icon-btn" data-unpin="${esc(t.key || t.id)}" aria-label="Unpin ${esc(t.title || t.host || "tab")}">${icon("x")}</button>
      </div>`).join("");
    const more = tabs.length > 5 ? `<div class="hint">${tabs.length} protected pages</div>` : tabs.length > 1 ? `<div class="hint">${tabs.length} protected pages</div>` : "";
    return rows + more;
  }

  function wireActive(st) {
    const pause = $("pauseBtn");
    if (pause) pause.onclick = async () => {
      await chrome.runtime.sendMessage({ type: "PAUSE_SESSION" });
      toast("Session paused");
      refresh();
    };
    const resume = $("resumeBtn");
    if (resume) resume.onclick = async () => {
      await chrome.runtime.sendMessage({ type: "RESUME_SESSION" });
      toast("Session resumed");
      refresh();
    };
    const end = $("endBtn");
    if (end) end.onclick = () => {
      const s = st.session;
      const mins = s ? Math.max(0, Math.round((Math.min(Date.now(), s.endsAt) - s.startedAt) / 60000)) : 0;
      dialog({
        title: "End this session?",
        bodyHTML: `<p class="lede">You&rsquo;ve focused for ${mins} minutes.</p>`,
        actions: [
          { label: "Keep studying", kind: "primary" },
          { label: "End session", kind: "danger", onClick: async () => {
            await chrome.runtime.sendMessage({ type: "END_SESSION" });
            uiState = "IDLE";
            refresh();
            // History writes async — re-check so the debrief appears promptly.
            setTimeout(refresh, 1500);
          } },
        ],
      });
    };
    document.querySelectorAll("#studyList .rowline").forEach((row) => {
      const key = row.dataset.key;
      const go = async () => {
        const r = await chrome.runtime.sendMessage({ type: "FOCUS_TAB", key }).catch(() => null);
        if (!r || !r.ok) toast("That tab is closed — reopen the URL and it rejoins");
      };
      row.onclick = (e) => { if (!e.target.closest("[data-unpin]")) go(); };
      row.onkeydown = (e) => { if (e.key === "Enter" && !e.target.closest("[data-unpin]")) go(); };
    });
    document.querySelectorAll("[data-unpin]").forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        await chrome.runtime.sendMessage({ type: "UNPIN_STUDY_TAB", key: b.dataset.unpin });
        refresh();
      };
    });
    // Break view gets its own skip wiring when present.
    // (finishBreakEarly is rendered inline in viewActive during BREAK.)
    const brk = $("finishBreakEarly");
    if (brk) brk.onclick = async () => {
      await chrome.runtime.sendMessage({ type: "SKIP_BREAK" });
      refresh();
    };
  }

  // ---------- BREAK ----------
  // BREAK reuses viewActive (which renders "Finish break early" inline
  // during break phases) with a break-specific next line.
  function renderBreakInto(st) {
    const host = $("stateHost");
    host.innerHTML = viewActive(st);
    const next = $("nextLine");
    if (next) next.textContent = "Step away: water, stretch, eyes off the screen.";
    wireActive(st);
  }

  // ---------- JOURNAL ----------
  function renderJournal(st) {
    const history = st.history || [];
    const totalMin = history.reduce((a, h) => a + (h.focusedMinutes || h.planned || 0), 0);
    const hrs = Math.floor(totalMin / 60), mins = totalMin % 60;
    $("weekSummary").textContent = history.length
      ? `This week · ${history.length} sessions · ${hrs ? hrs + "h " : ""}${mins}m focused`
      : "No sessions yet. Your week will appear here.";
    const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
    const byDay = {};
    for (const h of history) { const k = dayKey(h.endedAt); (byDay[k] = byDay[k] || []).push(h); }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const rows = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today.getTime() - i * 86400000);
      const list = byDay[`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`] || [];
      if (!list.length) continue;
      const m = list.reduce((a, h) => a + (h.focusedMinutes || h.planned || 0), 0);
      const sw = list.reduce((a, h) => a + (h.switches || 0), 0);
      const label = i === 0 ? "Today" : i === 1 ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      const bars = `<div class="weekbars" aria-hidden="true">${list.map((h) => `<i class="${h.completed ? "done" : ""}"></i>`).join("")}</div>`;
      rows.push(`<div class="day-row"><div class="top"><b>${label}</b><span class="m">${m} min · ${sw} switches</span></div>${bars}</div>`);
    }
    $("journalList").innerHTML = rows.length ? rows.join("") : `<div class="empty">Nothing this week yet.</div>`;
    // Consistency (rest-day friendly).
    const seq = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400000);
      seq.push((byDay[`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`] || []).some((h) => h.completed));
    }
    let idx = seq.length - 1;
    if (!seq[idx]) idx -= 1;
    let streak = 0;
    for (; idx >= 0 && seq[idx]; idx--) streak++;
    const activeDays = seq.filter(Boolean).length;
    $("consistency").innerHTML = streak >= 2
      ? `<b style="color:var(--text)">${streak} active study days.</b><br>You studied on ${activeDays} of the last 7 days. Rest days are fine.`
      : activeDays
        ? `You studied on ${activeDays} of the last 7 days. Rest days are fine.`
        : "Finish a session to start tracking consistency. Rest days are fine.";
    const badge = $("streakBadge");
    if (streak >= 2) { badge.style.display = ""; badge.textContent = `${streak} days`; }
    else badge.style.display = "none";
  }

  // ---------- SITES ----------
  function renderSites(st) {
    const tabs = st.studyTabs || [];
    const box = $("sitesStudy");
    if (!st.session && !(st.pendingPins || []).length && !tabs.length) {
      box.innerHTML = `<div class="empty"><b>No study pages yet.</b><br>Open your lecture and pin it here.</div>`;
    } else {
      const list = st.session ? tabs : (st.pendingPins || []);
      box.innerHTML = list.length ? list.map((t) => `
        <div class="rowline">${fav(t)}
          <div class="grow"><div class="t">${esc(t.title || t.host || "Untitled tab")}</div>
          <div class="s">${st.session ? (t.closed ? "Closed — reopen the URL and it rejoins" : `${esc(t.host || "")} · Protected`) : `${esc(t.host || "")} · joins on start`}</div></div>
          <button class="icon-btn" data-unsite="${esc(t.key || t.id)}" aria-label="Unpin">${icon("x")}</button>
        </div>`).join("") : `<div class="empty"><b>No study pages yet.</b><br>Open your lecture and pin it here.</div>`;
      box.querySelectorAll("[data-unsite]").forEach((b) => {
        b.onclick = async () => {
          await chrome.runtime.sendMessage({ type: "UNPIN_STUDY_TAB", key: b.dataset.unsite });
          refresh();
        };
      });
    }
    const urges = (st.urges || []).slice(-5).reverse();
    $("sitesUrges").innerHTML = urges.length
      ? urges.map((u) => `<div class="rowline"><div class="grow"><div class="t">${esc(u.text)}</div><div class="s">${ago(u.at)} · returns after session</div></div></div>`).join("")
      : `<div class="empty">Nothing parked. Name the urge instead of opening it.</div>`;
    const bl = cachedBl;
    $("sitesBlocked").textContent = bl == null ? "Loading…" : bl === 0 ? "Distraction list is empty." : `${bl} sites paused during sessions. Lectures stay open.`;
  }

  let cachedBl = null;
  async function refreshBlockCount() {
    try {
      const bl = await chrome.runtime.sendMessage({ type: "GET_BLOCKLIST" });
      cachedBl = (bl.defaults || []).length + (bl.customs || []).length;
    } catch { cachedBl = null; }
  }

  // ---------- DEBRIEF (COMPLETED) ----------
  function renderDebrief(st) {
    const last = (st.history || [])[(st.history || []).length - 1];
    const host = $("stateHost");
    if (!last) { uiState = "IDLE"; refresh(); return; }
    const focusTxt = last.focusedMinutes != null
      ? (last.focusedMinutes >= 60 ? `${Math.floor(last.focusedMinutes / 60)}h ${last.focusedMinutes % 60}m` : `${last.focusedMinutes}m`)
      : `${last.planned}m`;
    setTimeout(() => {
      const next = $("nextGoalInput");
      if (next) {
        next.value = (st.settings && st.settings.nextGoal) || "";
        $("saveFinish").onclick = async () => {
          await chrome.runtime.sendMessage({ type: "SAVE_NEXT_GOAL", goal: next.value.trim() });
          await chrome.runtime.sendMessage({ type: "COMPLETE_ONBOARDING" });
          uiState = "IDLE";
          toast("Saved");
          refresh();
        };
      }
      const again = $("againBtn");
      if (again) again.onclick = () => { uiState = "SETUP"; refresh(); };
    }, 0);
    host.innerHTML = `
      <section class="card card-pad" aria-label="Session complete" style="text-align:center">
        <div class="kicker">Session ${last.completed ? "complete" : "ended early"}</div>
        ${last.goal ? `<h1>${esc(last.goal)}</h1>` : `<h1>Session summary</h1>`}
        <div class="timer-big" style="font-size:40px">${esc(focusTxt)}</div>
        <div class="hint">focused${last.blocked ? ` · stayed through ${last.blocked} distraction${last.blocked === 1 ? "" : "s"}` : ""}</div>
      </section>
      <section class="stats" aria-label="Session stats" style="border:1px solid var(--border);border-radius:var(--radius-sm)">
        <div><b>${last.planned}m</b><span>planned</span></div>
        <div><b>${last.switches}</b><span>switches</span></div>
        <div><b>${last.urges}</b><span>parked</span></div>
      </section>
      ${(last.top && last.top.length) ? `
      <section class="section" aria-label="What pulled your attention">
        <h2>What pulled your attention?</h2>
        ${last.top.map(([s, c]) => `<div class="recent-row"><span>${esc(s)}</span><span class="m">×${c}</span></div>`).join("")}
      </section>` : ""}
      <section class="section" aria-label="Tomorrow">
        <h2>Tomorrow</h2>
        <div class="field"><label for="nextGoalInput">What will you study next?</label>
          <input class="input" id="nextGoalInput" type="text" maxlength="120" placeholder="e.g. DBMS transactions" autocomplete="off"></div>
        <div class="controls">
          <button class="btn btn-primary" id="saveFinish">Save &amp; finish</button>
          <button class="btn btn-secondary" id="againBtn">Study again</button>
        </div>
      </section>`;
  }

  // ---------- actions ----------
  function curTabMeta() {
    return chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => {
      if (!t) return null;
      return { id: t.id, title: t.title || "", url: t.url || "", favIcon: t.favIconUrl || "" };
    });
  }

  async function startFromIdle() {
    const minutes = draft.minutes || 25;
    const goal = draft.goal || "";
    if (goal) chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings: { lastGoal: goal } }).catch(() => {});
    const whitelist = []; // per-session allowlist now lives in Settings; popup stays focused
    const meta = await curTabMeta();
    const res = await chrome.runtime.sendMessage({
      type: "START_SESSION", minutes, whitelist, goal,
      studyTabs: meta ? [meta] : [],
    }).catch(() => null);
    if (res && res.ok) {
      if (res.pinned === 0 && meta && meta.url && meta.url.startsWith("http")) {
        toast("Current tab paused by guard — pin a lecture");
      } else {
        toast("Session started");
      }
      await chrome.runtime.sendMessage({ type: "COMPLETE_ONBOARDING" }).catch(() => {});
      uiState = "FOCUS";
    }
    refresh();
  }

  async function pinCurrentTab() {
    const meta = await curTabMeta();
    if (!meta || !meta.url) return;
    const res = await chrome.runtime.sendMessage({ type: "PIN_STUDY_TAB", ...meta }).catch(() => null);
    if (res && !res.ok && res.reason === "blocked-site") {
      toast(`“${res.host || "This site"}” pauses during focus`);
    } else if (res && !res.ok) {
      toast("That tab can't be pinned");
    } else {
      toast(res && res.pending ? "Pinned for next session" : "Study page protected");
    }
    refresh();
  }

  $("urgeBtn").onclick = parkUrge;
  $("urgeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") parkUrge(); });

  async function parkUrge() {
    const text = $("urgeInput").value.trim();
    if (!text) return;
    const res = await chrome.runtime.sendMessage({ type: "PARK_URGE", text }).catch(() => null);
    $("urgeInput").value = "";
    if (res && res.ok) toast("Urge parked — we'll remind you after");
    refresh();
  }

  async function awaitRefresh() { refresh(); }

  // ---------- 1s tick: countdown + progress only ----------
  setInterval(() => {
    try {
      if (!cached || !cached.session || uiState === "COMPLETED") return;
      const s = cached.session;
      if (s.pausedAt) {
        const el = $("bigTime");
        if (el) el.textContent = fmtClock(Math.max(0, s.phaseEndsAt - s.pausedAt));
        return;
      }
      const isBreak = Array.isArray(s.phases) && s.phases[s.phaseIndex]?.type === "break";
      const anchor = isBreak ? s.phaseEndsAt : s.endsAt;
      if (s.endsAt - Date.now() <= 0 || anchor - Date.now() <= 0) { refresh(); return; }
      const el = $("bigTime");
      if (el) el.textContent = fmtClock(anchor - Date.now());
      const bar = $("bigBar");
      if (bar) {
        const denom = isBreak
          ? Math.max(1, anchor - (s.phaseStartedAt || (anchor - 10 * 60000)))
          : Math.max(1, s.endsAt - s.startedAt);
        bar.style.width = Math.min(100, Math.max(0, ((denom - (anchor - Date.now())) / denom) * 100)) + "%";
      }
    } catch { /* ignore */ }
  }, 1000);
  setInterval(refresh, 60000);

  (async function init() {
    await initTheme();
    await refreshBlockCount();
    // Prefill draft from settings.
    try {
      if (cached && cached.settings) {
        draft.minutes = cached.settings.defaultMinutes || 25;
        draft.goal = cached.settings.lastGoal || cached.settings.nextGoal || "";
      }
    } catch { /* ignore */ }
    await refresh();
    if (cached && cached.settings) {
      draft.minutes = cached.settings.defaultMinutes || 25;
      if (!draft.goal) draft.goal = cached.settings.lastGoal || cached.settings.nextGoal || "";
      if (uiState === "IDLE") refresh();
    }
  })();
})();
