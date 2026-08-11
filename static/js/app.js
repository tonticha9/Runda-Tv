(() => {
  const TRANSCODER_URL = "https://rundatranscoder.fly.dev";

  const video = document.getElementById("video");
  const playerStatic = document.getElementById("playerStatic");
  const onAirBadge = document.getElementById("onAirBadge");
  const fixBtn = document.getElementById("fixBtn");
  const debugLog = document.getElementById("debugLog");
  const copyLogBtn = document.getElementById("copyLogBtn");
  const debugToggle = document.getElementById("debugToggle");
  const npNumber = document.getElementById("npNumber");
  const npName = document.getElementById("npName");
  const npGroup = document.getElementById("npGroup");
  const grid = document.getElementById("channelGrid");
  const guideStatus = document.getElementById("guideStatus");
  const tabs = document.getElementById("tabs");
  const worldPicker = document.getElementById("worldPicker");
  const searchInput = document.getElementById("searchInput");

  let currentCountry = "tz";
  let currentChannels = [];
  let hls = null;
  let searchDebounce = null;
  let currentChannel = null;

  function dlog(msg) {
    const ts = new Date().toLocaleTimeString();
    debugLog.textContent += `[${ts}] ${msg}\n`;
    debugLog.scrollTop = debugLog.scrollHeight;
  }
  function clearLog() {
    debugLog.textContent = "";
  }
  copyLogBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(debugLog.textContent || "(hakuna logs bado)");
      copyLogBtn.textContent = "✅ Copied!";
      setTimeout(() => { copyLogBtn.textContent = "📋 Copy Log"; }, 1500);
    } catch (e) {
      copyLogBtn.textContent = "❌ Imeshindwa";
      setTimeout(() => { copyLogBtn.textContent = "📋 Copy Log"; }, 1500);
    }
  });
  debugToggle.addEventListener("click", () => {
    const showing = !debugLog.hidden;
    debugLog.hidden = showing;
    copyLogBtn.hidden = showing;
  });

  function playChannel(channel, index, useTranscoder) {
    if (!channel.url) return;
    currentChannel = channel;
    clearLog();
    dlog(`Kucheza: ${channel.name}`);

    document.querySelectorAll(".channel-card").forEach((el) => el.classList.remove("playing"));
    const card = grid.querySelector(`[data-index="${index}"]`);
    if (card) card.classList.add("playing");

    npNumber.textContent = String(index + 1).padStart(3, "0");
    npName.textContent = channel.name || "Bila jina";
    npGroup.textContent = channel.group || channel.country || "";
    fixBtn.hidden = true;
    onAirBadge.hidden = true;
    playerStatic.hidden = false;
    playerStatic.querySelector(".static-msg").textContent = "Inapakia…";

    if (hls) {
      hls.destroy();
      hls = null;
    }
    video.oncanplay = null;
    video.onplaying = null;

    if (useTranscoder) {
      playViaTranscoder(channel, index);
      return;
    }

    video.onplaying = () => {
      if (video.videoWidth > 0) {
        playerStatic.hidden = true;
        onAirBadge.hidden = false;
        dlog(`Video inaonekana: ${video.videoWidth}x${video.videoHeight}`);
      }
    };

    if (window.Hls && window.Hls.isSupported()) {
      dlog("HLS.js inatumika (MSE)");
      hls = new window.Hls({
        enableWorker: true,
        maxBufferLength: 20,
        maxMaxBufferLength: 30,
        backBufferLength: 10,
        maxBufferHole: 0.5,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 500,
        manifestLoadingMaxRetry: 4,
        levelLoadingMaxRetry: 4,
      });
      hls.loadSource(channel.url);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        dlog(`HLS ${data.fatal ? "FATAL" : "warn"}: ${data.type}/${data.details}`);
        if (!data.fatal) return;
        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          dlog("Inajaribu kupona (recoverMediaError)…");
          hls.recoverMediaError();
          return;
        }
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          showError("Imeshindikana kufikia stream (mtandao au chanzo kimefungwa) — jaribu chaneli nyingine", index);
        } else {
          showError("Stream hii haipatikani kwa sasa — jaribu chaneli nyingine", index);
        }
      });
      video.play().catch((e) => dlog(`video.play() KATAA: ${e.message}`));
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      dlog("Native HLS (Safari) inatumika");
      video.src = channel.url;
      video.play().catch(() => {});
    } else {
      showError("Browser yako haiwezi kucheza stream hii", index);
    }
  }

  async function playViaTranscoder(channel, index) {
    if (!TRANSCODER_URL) {
      showError("Transcoder haijasanidiwa bado (TRANSCODER_URL tupu kwenye app.js)", index);
      return;
    }
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
      const playlistUrl = `${TRANSCODER_URL}${data.playlist}`;
      video.onplaying = () => {
        if (video.videoWidth > 0) {
          playerStatic.hidden = true;
          onAirBadge.hidden = false;
          dlog(`Video (transcoded) inaonekana: ${video.videoWidth}x${video.videoHeight}`);
        }
      };
      hls = new window.Hls({
        enableWorker: true,
        maxBufferLength: 20,
        maxMaxBufferLength: 30,
        backBufferLength: 10,
      });
      hls.loadSource(playlistUrl);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.ERROR, (_evt, d) => {
        dlog(`Transcoder HLS ${d.fatal ? "FATAL" : "warn"}: ${d.type}/${d.details}`);
        if (d.fatal) showError("Transcoded stream imesimama — jaribu tena", index);
      });
      video.play().catch(() => {});
    } catch (err) {
      console.error(err);
      showError("Imeshindikana kufikia transcoder — angalia kama Fly.io service inaendesha", index);
    }
  }

  function showError(message, index, offerFix) {
    playerStatic.hidden = false;
    onAirBadge.hidden = true;
    playerStatic.querySelector(".static-msg").textContent =
      message || "Stream hii haipatikani kwa sasa — jaribu chaneli nyingine";
    fixBtn.hidden = !offerFix;
    if (offerFix && currentChannel) {
      fixBtn.onclick = () => playChannel(currentChannel, index, true);
    }
  }

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
      card.addEventListener("click", () => {
        const scrollY = window.scrollY;
        const restore = () => window.scrollTo(0, scrollY);
        playChannel(ch, i);
        requestAnimationFrame(restore);
        setTimeout(restore, 60);
        setTimeout(restore, 300);
      });
      frag.appendChild(card);
    });
    grid.appendChild(frag);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  let mode = "country";
  let activeCategory = null;

  async function loadContent() {
    grid.innerHTML = "";
    guideStatus.hidden = false;
    guideStatus.textContent = "Inapakia chaneli…";
    searchInput.value = "";

    const url = mode === "category"
      ? `/api/category/${activeCategory}`
      : `/api/country/${currentCountry}`;

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

  tabs.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    tabs.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    worldPicker.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));

    mode = "category";
    activeCategory = btn.dataset.tab;
    loadContent();
  });

  worldPicker.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    worldPicker.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    tabs.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));

    mode = "country";
    currentCountry = chip.dataset.country;
    loadContent();
  });

  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    const q = searchInput.value.trim();
    searchDebounce = setTimeout(async () => {
      if (!q) {
        loadContent();
        return;
      }
      const scope = mode === "category" ? activeCategory : currentCountry;
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

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      video.pause();
      dlog("App imekwenda background — video imesimamishwa kuokoa data");
    } else if (currentChannel && video.paused && video.src) {
      video.play().catch(() => {});
    }
  });

  loadContent();
})();
