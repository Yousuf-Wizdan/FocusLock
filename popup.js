/* FocusLock popup — no alert()/confirm(). All dialogs are inline.
 * State shape v2: GET_STATUS returns { session, studyTabs, pendingPins,
 * switches, urges, urgeCount, blocked, history, settings, inBreak }.
 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function fmtClock(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
      : `${m}:${String(r).padStart(2, "0")}`;
  }

  function ago(ts) {
    const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
  }

  function showNotice(text, sticky) {
    const n = $("notice");
    n.textContent = text;
    n.classList.add("show");
    clearTimeout(showNotice.t);
    if (!sticky) showNotice.t = setTimeout(() => n.classList.remove("show"), 6000);
  }

  function setVisible(id, show) { $(id).style.display = show ? "" : "none"; }

  function tabIcon(t) {
    if (t.favIcon) return `<img src="${esc(t.favIcon)}" alt="" onerror="this.style.display='none'">`;
    const letter = (t.host || "?").charAt(0).toUpperCase();
    return `<span aria-hidden="true" style="width:16px;height:16px;border-radius:3px;background:#8884;font-size:10px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex:none">${esc(letter)}</span>`;
  }

  function phaseInfo(s) {
    const phases = Array.isArray(s.phases) ? s.phases : [{ type: "focus", minutes: s.plannedMinutes || 25 }];
    const idx = Math.min(s.phaseIndex || 0, phases.length - 1);
    const focuses = phases.filter((p) => p.type === "focus").length;
    const focusNo = phases.slice(0, idx + 1).filter((p) => p.type === "focus").length;
    return { phases, idx, cur: phases[idx], focuses, focusNo };
  }

  let cached = null;

  async function status() {
    try {
      cached = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    } catch { /* worker asleep — keep old cache */ }
    return cached;
  }

  async function refresh() {
    const st = await status();
    if (!st) return;
    render(st);
    renderJournal(st.history || []);
    renderDebrief(st);
  }

  function render(st) {
    const session = st.session;
    const live = !!session;
    const dot = $("dot");
    dot.className = "dot" + (live ? " live" : "");

    setVisible("setupSec", !live);
    setVisible("traySec", !live);
    setVisible("activeSec", live);
    setVisible("studySec", live);
    setVisible("parkSec", live);

    if (!live) {
      dot.classList.remove("rest");
      $("phaseName").textContent = "Ready";
      $("sTime").textContent = "–";
      $("sTimeK").textContent = "left";
      $("goalLine").style.display = "none";
      $("sSwitch").textContent = "0";
      $("sUrge").textContent = "0";
      $("sBlocked").textContent = "0";
      $("bar").style.width = "0%";
      $("phaseLine").innerHTML = "";
      $("searchNote").style.display = "none";
      $("eta").textContent = "";
      $("planLine").textContent = "Lectures open · feeds paused";
      if (st.settings && st.settings.defaultMinutes) {
        const m = $("minutes");
        if (document.activeElement !== m) m.value = st.settings.defaultMinutes;
        const g = $("goal");
        if (g && !g.value && st.settings.lastGoal) g.value = st.settings.lastGoal;
      }
      renderTray(st.pendingPins || []);
      return;
    }

    const s = session;
    const { phases, idx, cur, focuses, focusNo } = phaseInfo(s);
    const isBreak = cur.type === "break";
    const anchor = isBreak ? s.phaseEndsAt : s.endsAt;
    const denom = isBreak
      ? Math.max(1, s.phaseEndsAt - (s.phaseStartedAt || (s.phaseEndsAt - 10 * 60000)))
      : Math.max(1, s.endsAt - s.startedAt);

    dot.classList.toggle("rest", isBreak);
    $("phaseName").textContent = isBreak ? "Break" : focuses > 1 ? `Focus ${focusNo} of ${focuses}` : "Focus";
    $("sTimeK").textContent = isBreak ? "break left" : "session left";
    $("sTime").textContent = fmtClock(anchor - Date.now());
    $("sSwitch").textContent = st.switches || 0;
    $("sUrge").textContent = st.urgeCount || 0;
    $("sBlocked").textContent = st.blocked || 0;
    $("bar").style.width = Math.min(100, Math.max(0, ((denom - (anchor - Date.now())) / denom) * 100)) + "%";
    $("eta").textContent = `ends ${new Date(s.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;

    const gl = $("goalLine");
    if (s.goal) { gl.style.display = ""; gl.textContent = s.goal; }
    else gl.style.display = "none";

    const upcoming = phases.slice(idx + 1).map((p) => `${p.minutes}m ${p.type}`).join(" · ");
    const phaseLeft = fmtClock((s.phaseEndsAt || s.endsAt) - Date.now());
    $("phaseLine").innerHTML = isBreak
      ? `<div class="phase">${phaseLeft} — step away from the screen.<span class="next">${upcoming ? "Then " + esc(upcoming) : ""} · switching free, pauses stay on</span></div>
         <div class="row"><button class="btn" id="skipBreak" style="background:transparent">Skip break</button></div>`
      : `<div class="phase">${phaseLeft} in this block.<span class="next">${upcoming ? "Then " + esc(upcoming) : "Final stretch."}</span></div>`;
    const skipBtn = $("skipBreak");
    if (skipBtn) skipBtn.onclick = () => inlineConfirm(skipBtn, "Skip this break?", async () => {
      await chrome.runtime.sendMessage({ type: "SKIP_BREAK" });
      refresh();
    });

    const slog = (s.searchLog || []).filter((e) => Date.now() - e.at < 5 * 60000);
    const sbox = $("searchNote");
    if (slog.length >= 2) {
      sbox.style.display = "";
      sbox.textContent = `${slog.length} YouTube searches in 5 min. Lecture-driven is fine; spirals aren't.`;
    } else sbox.style.display = "none";

    $("planLine").textContent = `Plan: ${phases.map((p) => `${p.minutes}m ${p.type}`).join(" · ")}`;

    const tabs = st.studyTabs || [];
    $("pinCount").textContent = tabs.length ? `(${tabs.length})` : "";
    $("studyList").innerHTML = tabs.length
      ? tabs.map((t) => `
        <div class="studytab">
          ${tabIcon(t)}
          <div class="t">
            <b title="${esc(t.url || "")}">${esc(t.title || t.host || "Untitled tab")}</b>
            <span>${t.closed ? "Closed — reopen the URL and it rejoins" : `${esc(t.host || "pinned")} · switching free`}</span>
          </div>
          <button data-unpin="${esc(t.key || t.id)}" title="Unpin this tab" aria-label="Unpin ${esc(t.title || t.host || "tab")}">×</button>
        </div>`).join("")
      : `<div class="empty">No study tabs pinned. Open your lecture tab, then pin it.</div>`;

    const urges = st.urges || [];
    $("urges").innerHTML = urges.length
      ? urges.slice(-6).reverse().map((u) => `
        <div class="urge">
          <div><b>${esc(u.text)}</b></div>
          <span class="ago">${ago(u.at)}</span>
        </div>`).join("")
      : `<div class="empty">Nothing parked. Name the urge instead of opening it.</div>`;
  }

  function renderTray(tray) {
    $("trayCount").textContent = tray.length ? `(${tray.length})` : "";
    $("trayList").innerHTML = tray.length
      ? tray.map((t) => `
        <div class="studytab">
          ${tabIcon(t)}
          <div class="t">
            <b title="${esc(t.url || "")}">${esc(t.title || t.host || "Untitled tab")}</b>
            <span>${esc(t.host || "pinned")} · joins on start</span>
          </div>
          <button data-untray="${esc(t.key || t.id)}" title="Unpin this tab" aria-label="Unpin ${esc(t.title || t.host || "tab")}">×</button>
        </div>`).join("")
      : `<div class="empty">Nothing pinned yet. Pin your lecture tabs now — Start pulls them in.</div>`;
  }

  // Inline two-tap confirm — replaces confirm().
  function inlineConfirm(btn, label, action) {
    if (btn.dataset.armed) { action(); return; }
    btn.dataset.armed = "1";
    const orig = btn.textContent;
    btn.textContent = label + " (click again)";
    setTimeout(() => { btn.dataset.armed = ""; btn.textContent = orig; }, 4000);
  }

  function renderDebrief(st) {
    const box = $("debrief");
    const last = (st.history || [])[(st.history || []).length - 1];
    // Show the most recent session summary when idle and it ended < 1h ago.
    if (st.session || !last || Date.now() - last.endedAt > 3600000) {
      box.style.display = "none";
      box.innerHTML = "";
      return;
    }
    box.style.display = "";
    box.innerHTML = `
      <p class="sec-label">Last session</p>
      <div style="font-size:13px;font-weight:650">${last.completed ? "Session complete." : "Session ended early."}</div>
      <div class="muted">${last.planned} min planned${last.goal ? ` · “${esc(last.goal)}”` : ""} · ${last.switches} switches · ${last.blocked} paused · ${last.urges} parked${last.breakSkipped ? " · break skipped" : ""}</div>
      <div class="hint">What helped? One thing to continue tomorrow.</div>`;
  }

  function renderJournal(history) {
    if (!history.length) return;
    $("journalDetails").style.display = "";
    const box = $("journal");
    const dayKey = (ts) => {
      const d = new Date(ts);
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    };
    const byDay = {};
    for (const h of history) {
      const k = dayKey(h.endedAt);
      (byDay[k] = byDay[k] || []).push(h);
    }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400000);
      days.push({ d, list: byDay[`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`] || [] });
    }
    const seq = days.map((x) => x.list.some((h) => h.completed));
    let idx = seq.length - 1;
    if (!seq[idx]) idx -= 1; // today may still be in progress — don't break the streak
    let streak = 0;
    for (; idx >= 0 && seq[idx]; idx--) streak++;
    // Rest-day rule: a single gap doesn't reset the visible streak.
    if (streak >= 2) {
      $("streak").style.display = "";
      $("streak").textContent = `${streak}-day streak`;
    }
    const label = (d, i) => i === 6 ? "Today" : i === 5 ? "Yesterday"
      : d.toLocaleDateString(undefined, { weekday: "short" });
    box.innerHTML = days.map(({ d, list }, i) => {
      const done = list.filter((h) => h.completed).length;
      const n = list.length ? `${list.length} session${list.length > 1 ? "s" : ""} · ${done} done` : "rest";
      const bars = list.length
        ? `<div class="bars" aria-hidden="true">${list.map((h) =>
            `<i class="${h.completed ? "done" : "quit"}" title="${h.planned} min, ${h.switches} switches"></i>`).join("")}</div>`
        : "";
      return `<div class="jday"><div class="top"><b>${label(d, i)}</b><span class="n">${n}</span></div>${bars}</div>`;
    }).join("");
    $("journalHint").style.display = "";
    $("journalHint").textContent = streak >= 2
      ? `Streak: ${streak} days with a finished session. Rest days are fine.`
      : "Finish a session to start a streak. Rest days are fine.";
  }

  /* ---------- actions ---------- */
  document.querySelector("#trayList").addEventListener("click", async (e) => {
    const key = e.target?.dataset?.untray;
    if (!key) return;
    await chrome.runtime.sendMessage({ type: "UNPIN_STUDY_TAB", key });
    refresh();
  });

  document.querySelector("#studyList").addEventListener("click", async (e) => {
    const key = e.target?.dataset?.unpin;
    if (!key) return;
    await chrome.runtime.sendMessage({ type: "UNPIN_STUDY_TAB", key });
    refresh();
  });

  function curTabMeta() {
    return chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => {
      if (!t) return null;
      return { id: t.id, title: t.title || "", url: t.url || "", favIcon: t.favIconUrl || "" };
    });
  }

  function planText(minutes) {
    if (minutes <= 25) return `${minutes} min single block, no break.`;
    if (minutes < 70) return `${minutes} min: 25 focus, 5 break, ${minutes - 30} focus.`;
    return `${minutes} min: 50 focus, 10 break, ${minutes - 60} focus.`;
  }

  async function startWith(minutes) {
    const whitelist = $("whitelist").value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    const goal = $("goal").value.trim();
    if (goal) {
      chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings: { lastGoal: goal } }).catch(() => {});
    }
    const meta = await curTabMeta();
    const res = await chrome.runtime.sendMessage({
      type: "START_SESSION", minutes, whitelist, goal,
      studyTabs: meta ? [meta] : [],
    }).catch(() => null);
    if (res && res.ok && res.pinned === 0 && meta && meta.url?.startsWith("http")) {
      showNotice("Heads up: the current tab didn't pass the guard, so the session started with no study tabs. Pin a lecture tab.");
    } else if (res && res.ok) {
      showNotice(planText(minutes) + " Session started.");
    }
    refresh();
  }

  $("start").onclick = () => {
    startWith(Math.min(240, Math.max(5, parseInt($("minutes").value) || 25)));
  };

  document.querySelectorAll(".preset").forEach((b) => {
    b.onclick = () => {
      const m = parseInt(b.dataset.min, 10);
      $("minutes").value = m;
      startWith(m);
    };
  });

  async function pinCurrentTab() {
    const meta = await curTabMeta();
    if (!meta || !meta.url) return;
    const res = await chrome.runtime.sendMessage({ type: "PIN_STUDY_TAB", ...meta }).catch(() => null);
    if (res && !res.ok && res.reason === "blocked-site") {
      showNotice(`“${res.host || "This site"}” pauses during focus, so it can't be a study tab.`, true);
    } else if (res && !res.ok) {
      showNotice("That tab can't be pinned (browser or extension page).", true);
    }
    refresh();
  }

  $("pin").onclick = pinCurrentTab;
  $("pinIdle").onclick = pinCurrentTab;

  $("stop").onclick = async () => {
    inlineConfirm($("stop"), "End session?", async () => {
      await chrome.runtime.sendMessage({ type: "END_SESSION" });
      refresh();
    });
  };

  $("park").onclick = async () => {
    const text = $("urge").value.trim();
    if (!text) return;
    await chrome.runtime.sendMessage({ type: "PARK_URGE", text });
    $("urge").value = "";
    refresh();
  };
  $("urge").addEventListener("keydown", (e) => { if (e.key === "Enter") $("park").click(); });

  $("gear").onclick = () => chrome.runtime.openOptionsPage();

  // 1s tick: countdown + progress only (no re-render, no flicker).
  setInterval(() => {
    try {
      if (!cached || !cached.session) return;
      const s = cached.session;
      const isBreak = Array.isArray(s.phases) && s.phases[s.phaseIndex]?.type === "break";
      const anchor = isBreak ? s.phaseEndsAt : s.endsAt;
      if (s.endsAt - Date.now() <= 0 || anchor - Date.now() <= 0) { refresh(); return; }
      $("sTime").textContent = fmtClock(anchor - Date.now());
      const denom = isBreak
        ? Math.max(1, anchor - (s.phaseStartedAt || (anchor - 10 * 60000)))
        : Math.max(1, s.endsAt - s.startedAt);
      $("bar").style.width = Math.min(100, Math.max(0, ((denom - (anchor - Date.now())) / denom) * 100)) + "%";
    } catch { /* ignore */ }
  }, 1000);
  // Slow re-render only (60s — was 15s + per-tick storage writes).
  setInterval(refresh, 60000);

  refresh();
})();
