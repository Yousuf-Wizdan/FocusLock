/* FocusLock jail page — states: WAITING, RETURNING. Neutral tone, calm timer.
 * Same contract: ?n=&until=&from=&curl=&back=. Countdown derives from the
 * persisted absolute `until` timestamp, so SW restarts can't corrupt it.
 */
(function () {
  "use strict";
  const { initTheme, toast } = window.FL;
  const q = new URLSearchParams(location.search);
  const n = parseInt(q.get("n") || "1", 10) || 1;
  const until = parseInt(q.get("until") || "0", 10);
  const backId = parseInt(q.get("back") || "", 10);
  const host = q.get("from") || "a new tab";

  initTheme();

  document.getElementById("jN").textContent = "#" + n;
  document.getElementById("jHost").textContent = host;
  document.getElementById("jLetter").textContent = (host || "?").charAt(0).toUpperCase();
  document.getElementById("jTotal").textContent =
    n === 1 ? "First switch this session. Noted — nothing more." : `${n} switches this session.`;

  const btn = document.getElementById("jBack");
  const el = document.getElementById("jClock");

  function remaining() { return Math.max(0, Math.ceil((until - Date.now()) / 1000)); }
  function draw() {
    const s = remaining();
    el.textContent = s;
    if (s <= 0) {
      clearInterval(t);
      btn.disabled = false;
      btn.textContent = "Back to study";
      btn.focus();
    } else {
      btn.textContent = `Back to study (${s})`;
    }
  }
  draw();
  const t = setInterval(draw, 250);

  async function backToStudy() {
    document.getElementById("st-waiting").hidden = true;
    document.getElementById("st-returning").hidden = false;
    if (Number.isInteger(backId)) {
      try { await chrome.tabs.update(backId, { active: true }); window.close(); return; }
      catch { /* fall through */ }
    }
    try {
      const st = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
      for (const tab of ((st && st.studyTabs) || [])) {
        try { await chrome.tabs.update(tab.id, { active: true }); window.close(); return; }
        catch { /* try next */ }
      }
    } catch { /* ignore */ }
    history.back();
  }
  btn.onclick = backToStudy;

  document.getElementById("jPark").onclick = async () => {
    try {
      await chrome.runtime.sendMessage({ type: "PARK_URGE", text: "check " + host });
      toast("Urge parked — we'll remind you after");
    } catch { /* ignore */ }
    setTimeout(backToStudy, 600);
  };
})();
