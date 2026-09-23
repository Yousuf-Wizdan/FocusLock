/* FocusLock break page — reads ?wait= minutes; pulls session context for the
 * "You've completed N minutes" line and the next-block preview. */
(function () {
  "use strict";
  const { initTheme } = window.FL;
  initTheme();

  const mins = parseInt(new URLSearchParams(location.search).get("wait"), 10) || 10;
  document.getElementById("bMins").textContent = mins;

  (async function context() {
    try {
      const st = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
      const s = st && st.session;
      if (!s || !Array.isArray(s.phases)) return;
      const done = s.phases.slice(0, s.phaseIndex).filter((p) => p.type === "focus")
        .reduce((a, p) => a + p.minutes, 0);
      if (done > 0) document.getElementById("bDone").textContent = `You've completed ${done} minutes.`;
      const next = s.phases.slice(s.phaseIndex + 1).map((p) => `${p.minutes}m ${p.type}`).join(" · ");
      if (next) document.getElementById("bNext").textContent = next;
    } catch { /* standalone countdown still works */ }
  })();

  let s = mins * 60;
  const el = document.getElementById("bClock");
  const pad = (n) => String(n).padStart(2, "0");
  function draw() { el.textContent = `${Math.floor(s / 60)}:${pad(s % 60)}`; }
  draw();
  const t = setInterval(() => {
    s = Math.max(0, s - 1);
    draw();
    if (s <= 0) { clearInterval(t); el.textContent = "Back to study"; }
  }, 1000);

  document.getElementById("bSkip").onclick = async () => {
    try { await chrome.runtime.sendMessage({ type: "SKIP_BREAK" }); } catch { /* worker asleep */ }
    window.close();
  };
})();
