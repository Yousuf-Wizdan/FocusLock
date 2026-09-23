/* FocusLock onboarding — 4 screens max. No data collected; the study-style
 * answer only presets the first session length. Ends by marking onboarded
 * (COMPLETE_ONBOARDING) so the popup leaves FIRST_RUN. */
(function () {
  "use strict";
  const { initTheme, toast } = window.FL;
  initTheme();

  let step = 1, style = "mixed", minutes = 25;
  const body = document.getElementById("obBody");

  function paint() {
    for (let i = 1; i <= 4; i++) document.getElementById("s" + i).classList.toggle("on", i <= step);
  }

  function render() {
    paint();
    if (step === 1) {
      body.innerHTML = `
        <h1 id="obTitle">Protect your study time.</h1>
        <p class="lede" style="margin:8px 0 16px">A simple guard for the sites that pull you away. Study pages stay open. Distractions wait.</p>
        <div class="controls" style="display:flex"><button class="btn btn-primary btn-block" id="o1">Get started</button></div>`;
      document.getElementById("o1").onclick = () => { step = 2; render(); };
    } else if (step === 2) {
      const opts = [["lectures", "YouTube lectures", "Shorts and feeds pause; watch pages stay open"], ["reading", "Reading / documentation", "Docs, LMS, PDFs stay open"], ["coding", "Coding", "Editors, docs and references stay open"], ["mixed", "Mixed", "Pin whatever you study from"]];
      body.innerHTML = `
        <h1 id="obTitle">How do you usually study?</h1>
        <div style="margin:12px 0" role="group" aria-label="Study style">
          ${opts.map(([v, t, s]) => `<button class="opt" data-v="${v}" aria-pressed="${style === v}"><span class="r"></span><span><b>${t}</b><br><span class="hint">${s}</span></span></button>`).join("")}
        </div>
        <div class="controls" style="display:flex"><button class="btn btn-primary btn-block" id="o2">Continue</button></div>`;
      body.querySelectorAll(".opt").forEach((b) => {
        b.onclick = () => {
          style = b.dataset.v;
          body.querySelectorAll(".opt").forEach((x) => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
        };
      });
      if (style === "lectures") minutes = 25;
      document.getElementById("o2").onclick = () => { step = 3; render(); };
    } else if (step === 3) {
      body.innerHTML = `
        <h1 id="obTitle">Your first session — 25 minutes.</h1>
        <p class="lede" style="margin:8px 0 16px">We&rsquo;ll protect your study page and pause your selected distractions.</p>
        <div class="field"><label for="oGoal">What will you study? (optional)</label>
          <input class="input" id="oGoal" type="text" maxlength="120" placeholder="e.g. Operating Systems" autocomplete="off"></div>
        <div class="controls" style="display:flex"><button class="btn btn-primary btn-block" id="o3">Choose study page</button></div>`;
      document.getElementById("oGoal").focus();
      document.getElementById("o3").onclick = () => {
        window._obGoal = document.getElementById("oGoal").value.trim();
        step = 4;
        render();
      };
    } else {
      body.innerHTML = `
        <h1 id="obTitle">You&rsquo;re ready.</h1>
        <div class="hint" style="margin:8px 0 4px">Open your lecture. Pin it. Start focusing.</div>
        <ol class="hint" style="margin:0 0 16px;padding-left:18px">
          <li>Open the page you study from.</li>
          <li>Click FocusLock → Pin this tab.</li>
          <li>Press Start.</li>
        </ol>
        <div class="controls" style="display:flex;flex-direction:column;gap:8px">
          <button class="btn btn-primary btn-block" id="o4">Start 25-minute session</button>
          <button class="btn btn-quiet btn-block" id="oLater">I&rsquo;ll start later</button>
        </div>`;
      document.getElementById("o4").onclick = async () => {
        let meta = null;
        try {
          const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (t) meta = { id: t.id, title: t.title || "", url: t.url || "", favIcon: t.favIconUrl || "" };
        } catch { /* ignore */ }
        const res = await chrome.runtime.sendMessage({
          type: "START_SESSION", minutes: 25, whitelist: [], goal: window._obGoal || "",
          studyTabs: meta ? [meta] : [],
        }).catch(() => null);
        await chrome.runtime.sendMessage({ type: "COMPLETE_ONBOARDING" }).catch(() => {});
        toast(res && res.ok ? "Session started" : "Saved — start from the popup");
        window.close();
      };
      document.getElementById("oLater").onclick = async () => {
        await chrome.runtime.sendMessage({ type: "COMPLETE_ONBOARDING" }).catch(() => {});
        window.close();
      };
    }
  }
  render();
})();
