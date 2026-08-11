(() => {
  const TRANSCODER_URL = "https://rundatranscoder.fly.dev";

  const video = document.getElementById("video");
  const playerStatic = document.getElementById("playerStatic");
  const onAirBadge = document.getElementById("onAirBadge");
  const fixBtn = document.getElementById("fixBtn");
  const debugLog = document.getElementById("debugLog");
  const npNumber = document.getElementById("npNumber");
  const npName = document.getElementById("npName");
  const npGroup = document.getElementById("npGroup");
  const grid = document.getElementById("channelGrid");
  const guideStatus = document.getElementById("guideStatus");
  const tabs = document.getElementById("tabs");
  const worldPicker = document.getElementById("worldPicker");
  const searchInput = document.getElementById("searchInput");

  let currentTab = "tanzania";
  let currentCountry = "tz";
  let currentChannels = [];
  let hls = null;
  let searchDebounce = null;
  let currentChannel = null;

  // ---------------- Debug log (inaonyesha moja kwa moja skrini-ni,
  // kwa sababu simu haina urahisi wa kufungua browser console) ----------------
  function dlog(msg) {
    const ts = new Date().toLocaleTimeString();
    debugLog.textContent += `[${ts}] ${msg}\n`;
    debugLog.scrollTop = debugLog.scrollHeight;
  }
  function clearLog() {
    debugLog.textContent = "";
  }

  // ---------------- Player ----------------
  let videoCheckTimer = null;

  function clearVideoCheck() {
    if (videoCheckTimer) {
      clearTimeout(videoCheckTimer);
      videoCheckTimer = null;
    }
  }

  function playChannel(channel, index, useTranscoder) {
    if (!channel.url) return;
    currentChannel = channel;
    clearLog();
    dlog(`Kucheza: ${channel.name} | url=${channel.url}`);

    document.querySelectorAll(".channel-card").forEach((el) => el.classList.remove("playing"));
    const card = grid.querySelector(`[data-index="${index}"]`);
    if (card) card.classList.add("playing");

    npNumber.textContent = String(index + 1).padStart(3, "0");
    npName.textContent = channel.name || "Bila jina";
    npGroup.textContent = channel.group || channel.country || "";
    playerStatic.hidden = true;
    fixBtn.hidden = true;
    onAirBadge.hidden = false;

    clearVideoCheck();
    if (hls) {
      hls.destroy();
      hls = null;
    }

    if (useTranscoder) {
      playViaTranscoder(channel, index);
      return;
    }

    if (window.Hls && window.Hls.isSupported()) {
      dlog("HLS.js inatumika (MSE)");
      hls = new window.Hls({ maxBufferLength: 30 });
      hls.loadSource(channel.url);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, (_e, data) => {
        dlog(`MANIFEST_PARSED: levels=${data.levels.length}`);
      });
      hls.on(window.Hls.Events.LEVEL_LOADED, (_e, data) => {
        dlog(`LEVEL_LOADED: ${JSON.stringify(data.details && data.details.live)}`);
      });
      hls.on(window.Hls.Events.FRAG_LOADED, () => {
        dlog(`FRAG_LOADED videoWidth=${video.videoWidth} videoHeight=${video.videoHeight} readyState=${video.readyState}`);
      });
      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        dlog(`HLS ERROR type=${data.type} details=${data.details} fatal=${data.fatal}`);
        if (!data.fatal) return;
        console.warn("Stream error:", channel.name, data.type, data.details);
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          showError("Imeshindikana kufikia stream (mtandao au chanzo kimefungwa) — jaribu chaneli nyingine", index);
        } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          showError("Video ya chaneli hii imeharibika au codec haiungwi mkono — bonyeza 'Rekebisha video' hapo chini", index, true);
        } else {
          showError("Stream hii haipatikani kwa sasa — jaribu chaneli nyingine", index);
        }
      });
      video.play().then(() => dlog("video.play() imefanikiwa")).catch((e) => dlog(`video.play() KATAA: ${e.message}`));
      scheduleVideoCheck(index);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      dlog("Native HLS (Safari) inatumika");
      video.src = channel.url;
      video.play().catch(() => {});
      scheduleVideoCheck(index);
    } else {
      showError("Browser yako haiwezi kucheza stream hii", index);
    }
  }

  // Inapiga runda-transcoder (Fly.io) ili kubadilisha HEVC -> H.264 live,
  // kisha inacheza playlist mpya inayotoka huko.
  async function playViaTranscoder(channel, index) {
    if (!TRANSCODER_URL) {
      showError("Transcoder haijasanidiwa bado (TRANSCODER_URL tupu kwenye app.js)", index);
      return;
    }
    guideStatus.hidden = false;
    playerStatic.hidden = false;
    playerStatic.querySelector(".static-msg").textContent = "Inarekebisha video (transcoding)… subiri sekunde chache";
    fixBtn.hidden = true;

    try {
      const res = await fetch(`${TRANSCODER_URL}/start?url=${encodeURIComponent(channel.url)}`);
      const data = await res.json();
      if (!res.ok) {
        showError(data.error || "Transcoder imeshindwa kuanzisha stream hii", index);
        return;
      }
      playerStatic.hidden = true;
      onAirBadge.hidden = false;
      const playlistUrl = `${TRANSCODER_URL}${data.playlist}`;
      hls = new window.Hls({ maxBufferLength: 30 });
      hls.loadSource(playlistUrl);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.ERROR, (_evt, d) => {
        if (d.fatal) showError("Transcoded stream imesimama — jaribu tena", index);
      });
      video.play().catch(() => {});
    } catch (err) {
      console.error(err);
      showError("Imeshindikana kufikia transcoder — angalia kama Fly.io service inaendesha", index);
    }
  }

  // Baada ya sekunde 6, angalia kama video ina picha kweli (videoWidth > 0).
  function scheduleVideoCheck(index) {
    videoCheckTimer = setTimeout(() => {
      if (video.paused || video.ended) return;
      if (video.videoWidth === 0) {
        showError("Sauti inasikika lakini video haionekani (codec H.265/HEVC). Bonyeza 'Rekebisha video' kubadilisha kiotomatiki.", index, true);
      }
    }, 6000);
  }

  function showError(message, index, offerFix) {
    clearVideoCheck();
    playerStatic.hidden = false;
    onAirBadge.hidden = true;
    playerStatic.querySelector(".static-msg").textContent =
      message || "Stream hii haipatikani kwa sasa — jaribu chaneli nyingine";
    fixBtn.hidden = !offerFix;
    if (offerFix && currentChannel) {
      fixBtn.onclick = () => playChannel(currentChannel, index, true);
    }
  }

  // ---------------- Rendering ----------------
  function renderChannels(channels) {
    currentChannels = channels;
    grid.innerHTML = "";

    if (!channels.length) {
      guideStatus.hidden = false;
      guideStatus.textContent = "Hakuna chaneli zilizopatikana kwa sasa. Jaribu kundi lingine.";
      return;
    }
    guideStatus.hidden = true;

    const frag = document.createDocumentFragment();
    channels.forEach((ch, i) => {
      const card = document.createElement("button");
      card.className = "channel-card";
      card.dataset.index = i;
      card.innerHTML = `
        <div class="card-top">
          <span class="card-number">${String(i + 1).padStart(3, "0")}</span>
          ${ch.logo ? `<img class="card-logo" src="${ch.logo}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : ""}
        </div>
        <span class="card-name">${escapeHtml(ch.name || "Bila jina")}</span>
        <span class="card-group">${escapeHtml(ch.group || ch.country || "")}</span>
      `;
      card.addEventListener("click", () => playChannel(ch, i));
      frag.appendChild(card);
    });
    grid.appendChild(frag);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------------- Fetching ----------------
  async function loadTab(tab) {
    currentTab = tab;
    grid.innerHTML = "";
    guideStatus.hidden = false;
    guideStatus.textContent = "Inapakia chaneli…";
    searchInput.value = "";

    let url;
    if (tab === "tanzania") {
      url = "/api/tanzania";
    } else if (tab === "world") {
      url = `/api/country/${currentCountry}`;
    } else {
      url = `/api/category/${tab}`;
    }

    try {
      const res = await fetch(url);
      const data = await res.json();
      guideStatus.textContent = `${data.count} chaneli zimepatikana`;
      renderChannels(data.channels || []);
    } catch (err) {
      guideStatus.textContent = "Imeshindikana kupakia chaneli. Angalia mtandao wako.";
      console.error(err);
    }
  }

  // ---------------- Tabs ----------------
  tabs.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    tabs.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");

    const tab = btn.dataset.tab;
    worldPicker.hidden = tab !== "world";
    loadTab(tab);
  });

  worldPicker.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    worldPicker.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    currentCountry = chip.dataset.country;
    loadTab("world");
  });

  // ---------------- Search ----------------
  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    const q = searchInput.value.trim();
    searchDebounce = setTimeout(async () => {
      if (!q) {
        loadTab(currentTab);
        return;
      }
      const scope = currentTab === "world" ? currentCountry : currentTab;
      guideStatus.hidden = false;
      guideStatus.textContent = "Inatafuta…";
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&scope=${scope}`);
        const data = await res.json();
        guideStatus.textContent = `${data.count} matokeo kwa "${q}"`;
        renderChannels(data.channels || []);
      } catch (err) {
        console.error(err);
      }
    }, 350);
  });

  // ---------------- Init ----------------
  loadTab("tanzania");
})();
