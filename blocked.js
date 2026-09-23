/* FocusLock blocked page — states: BLOCKED, EMERGENCY_REQUEST, EMERGENCY_ACTIVE.
 * Same contract as before: ?rule=&from=&entry=&back=. No history.back() traps:
 * "Back to study" focuses a real study tab id (?back=) or any live study tab.
 */
(function () {
  "use strict";
  const { esc, initTheme, toast } = window.FL;
  const q = new URLSearchParams(location.search);
  const raw = q.get("from") || "";
  const rule = q.get("rule") || (q.get("why") === "yt" ? "youtube" : "blocklist");
  const backId = parseInt(q.get("back") || "", 10);
  let host = "";
  try { host = new URL(raw).hostname.replace(/^www\./, ""); } catch { host = raw; }

  initTheme();

  function show(id) {
    for (const s of ["st-blocked", "st-em-request", "st-em-active"]) {
      document.getElementById(s).hidden = s !== id;
    }
  }

  async function sessionInfo() {
    try {
      const st = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
      return st;
    } catch { return null; }
  }

  async function backToStudy() {
    if (Number.isInteger(backId)) {
      try { await chrome.tabs.update(backId, { active: true }); window.close(); return; }
      catch { /* fall through */ }
    }
    try {
      const st = await sessionInfo();
      for (const t of ((st && st.studyTabs) || [])) {
        try { await chrome.tabs.update(t.id, { active: true }); window.close(); return; }
        catch { /* try next */ }
      }
    } catch { /* ignore */ }
    history.back();
  }

  (async function init() {
    document.getElementById("flHost").textContent = host || "this page";
    document.getElementById("flLetter").textContent = (host || "?").charAt(0).toUpperCase();
    const st = await sessionInfo();
    const s = st && st.session;
    if (s) {
      const bits = [];
      if (s.goal) bits.push(`You're currently protecting: ${s.goal}.`);
      const left = Math.max(0, Math.round((s.endsAt - Date.now()) / 60000));
      bits.push(`You planned to focus for ${left} more minute${left === 1 ? "" : "s"}.`);
      document.getElementById("flGoal").textContent = bits.join(" ");
      document.getElementById("flLeft").textContent = `Paused · session ends ${new Date(s.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    } else {
      document.getElementById("flGoal").textContent = "No session is running — this page was paused by an earlier session.";
      document.getElementById("flLeft").textContent = "Paused";
    }
    const why = document.getElementById("flWhy");
    if (rule === "youtube") {
      document.getElementById("flKicker").textContent = "YouTube study guard";
      document.getElementById("flTitle").textContent = "Shorts can wait. The lecture can't.";
      why.textContent = "This YouTube surface (Shorts, home, trending, explore, gaming, podcasts) is paused during sessions. Lectures, search, playlists, live streams and channels stay open.";
    } else if (q.get("entry")) {
      why.textContent = `This site (${q.get("entry")}) is on your distraction list and your focus session is active. It reopens when the session ends.`;
    } else {
      why.textContent = "You left a study tab during a focus block, so this page is on hold. Your study tabs are untouched.";
    }
    // Emergency pass availability mirrors the SW setting.
    if (st && st.settings && st.settings.emergencyPass === false) {
      document.getElementById("flPass").style.display = "none";
    }
  })();

  document.getElementById("flBack").onclick = backToStudy;

  document.getElementById("flPark").onclick = async () => {
    const text = host ? ("check " + host) : raw;
    try { await chrome.runtime.sendMessage({ type: "PARK_URGE", text }); toast("Urge parked — we'll remind you after"); }
    catch { /* worker asleep */ }
    setTimeout(backToStudy, 600);
  };

  document.getElementById("flPass").onclick = () => {
    show("st-em-request");
    document.getElementById("emReason").focus();
  };
  document.getElementById("emCancel").onclick = () => show("st-blocked");

  async function submitPass() {
    const reason = document.getElementById("emReason").value.trim();
    if (!reason) { document.getElementById("emReason").focus(); return; }
    try {
      const res = await chrome.runtime.sendMessage({ type: "REQUEST_PASS", url: raw, reason });
      if (res && res.ok) {
        enterActive(res.until);
        return;
      }
    } catch { /* ignore */ }
    toast("Emergency access isn't available right now");
    show("st-blocked");
  }
  document.getElementById("emGo").onclick = submitPass;
  document.getElementById("emReason").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitPass();
    if (e.key === "Escape") show("st-blocked");
  });

  function enterActive(until) {
    show("st-em-active");
    document.getElementById("acHost").textContent = `${host} · reason logged in your session`;
    const el = document.getElementById("acClock");
    const tick = () => {
      const s = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      if (s <= 0) { clearInterval(t); el.textContent = "Ended"; }
    };
    tick();
    const t = setInterval(tick, 500);
    document.getElementById("acOpen").onclick = () => { clearInterval(t); location.replace(raw); };
  }
})();
