(() => {
  const TRANSCODER_URL = "https://rundatranscoder.fly.dev";

  const video = document.getElementById("video");
  const ytFrame = document.getElementById("ytFrame");
  const ytBadge = document.getElementById("ytBadge");
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
  let currentIndex = null;
  let ytCheckTimer = null;
  let ytCurrentVideoId = null;

  // Kila mara playChannel inaitwa, playToken inaongezeka. Retries za zamani
  // zinaangalia token yao dhidi ya ya sasa kabla ya kujaribu tena — hii
  // inazuia retry ya channel ya zamani "kuingilia" channel mpya aliyochagua
  // mtumiaji.
  let playToken = 0;
  let retryTimer = null;
  let retryCountdown = null;
  let listRefreshTimer = null;


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

  // -------------------------------------------------------------------
  // Scroll-guard: baadhi ya simu (hasa iOS/Chrome) hujisogeza kuelekea
  // <video> pindi playback inapoanza — hii ndiyo tunayotaka kuizuia.
  // LAKINI: kama MTUMIAJI mwenyewe ndiye anayescroll kwa kidole wakati
  // huohuo, HATUINGILII kabisa — vinginevyo tunapigana na kidole chake
  // na screen "inaruka" kurudi nyuma (hili ndilo tatizo lililoripotiwa).
  // Tunatambua kugusa kwa touchstart/touchend na kurekebisha tu pale
  // ambapo scroll imesogea BILA mtumiaji kugusa (yaani ni browser
  // yenyewe iliyosogeza), na kwa tofauti kubwa tu (>40px) ili kuepuka
  // kuingilia marekebisho madogo ya asili ya browser.
  // -------------------------------------------------------------------
  let isTouching = false;
  window.addEventListener("touchstart", () => { isTouching = true; }, { passive: true });
  window.addEventListener("touchend", () => { isTouching = false; }, { passive: true });
  window.addEventListener("touchcancel", () => { isTouching = false; }, { passive: true });
  window.addEventListener("mousedown", () => { isTouching = true; });
  window.addEventListener("mouseup", () => { isTouching = false; });

  function guardScroll(duration = 1500) {
    const y = window.scrollY;
    function onScroll() {
      if (isTouching) return; // mtumiaji anaskroll mwenyewe — usiingiliane
      if (Math.abs(window.scrollY - y) > 40) {
        window.scrollTo(0, y);
      }
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    setTimeout(() => window.removeEventListener("scroll", onScroll), duration);
  }

  function playChannel(channel, index, useTranscoder) {
    if (!channel.url && channel.type !== "youtube") return;
    currentChannel = channel;
    currentIndex = index;
    const myToken = ++playToken;
    clearTimeout(retryTimer);
    clearInterval(ytCheckTimer);
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
    ytBadge.hidden = true;
    playerStatic.hidden = false;
    playerStatic.querySelector(".static-msg").textContent = "Inapakia…";

    if (hls) {
      hls.destroy();
      hls = null;
    }
    video.oncanplay = null;
    video.onplaying = null;

    if (channel.type === "youtube") {
      video.pause();
      video.removeAttribute("src");
      video.hidden = true;
      playYouTubeChannel(channel, index, myToken);
      return;
    }

    // channel ya kawaida (HLS) — hakikisha ytFrame imefichwa
    ytFrame.hidden = true;
    ytFrame.src = "";
    video.hidden = false;

    if (useTranscoder) {
      playViaTranscoder(channel, index, myToken);
      return;
    }

    video.onplaying = () => {
      if (video.videoWidth > 0) {
        playerStatic.hidden = true;
        onAirBadge.hidden = false;
        clearTimeout(retryTimer);
        guardScroll(600);
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
          showError("Chaneli haipatikani kwa sasa", index, false, true, myToken);
        } else {
          showError("Stream hii haipatikani kwa sasa", index, false, true, myToken);
        }
      });
      video.play().catch((e) => {
        if (e.name === "AbortError") {
          dlog("play() ilikatishwa na load nyingine (kawaida, si tatizo — inaendelea)");
        } else {
          dlog(`video.play() KATAA: ${e.message}`);
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      dlog("Native HLS (Safari) inatumika");
      video.src = channel.url;
      video.play().catch(() => {});
    } else {
      showError("Browser yako haiwezi kucheza stream hii", index, false, false, myToken);
    }
  }

  async function playViaTranscoder(channel, index, myToken) {
    if (!TRANSCODER_URL) {
      showError("Transcoder haijasanidiwa bado (TRANSCODER_URL tupu kwenye app.js)", index, false, false, myToken);
      return;
    }
    playerStatic.hidden = false;
    playerStatic.querySelector(".static-msg").textContent = "Inarekebisha video (transcoding)… subiri sekunde chache";
    fixBtn.hidden = true;

    try {
      const res = await fetch(`${TRANSCODER_URL}/start?url=${encodeURIComponent(channel.url)}`);
      const data = await res.json();
      if (playToken !== myToken) return; // mtumiaji ameshabadili channel
      if (!res.ok) {
        showError(data.error || "Transcoder imeshindwa kuanzisha stream hii", index, false, true, myToken);
        return;
      }
      const playlistUrl = `${TRANSCODER_URL}${data.playlist}`;
      video.onplaying = () => {
        if (video.videoWidth > 0) {
          playerStatic.hidden = true;
          onAirBadge.hidden = false;
          clearTimeout(retryTimer);
          guardScroll(600);
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
        if (d.fatal) showError("Transcoded stream imesimama", index, false, true, myToken);
      });
      video.play().catch(() => {});
    } catch (err) {
      console.error(err);
      showError("Imeshindikana kufikia transcoder — angalia kama Fly.io service inaendesha", index, false, true, myToken);
    }
  }

  // -------------------------------------------------------------------
  // showError: ikiwa retryable=true, tunajaribu tena channel hiyohiyo
  // baada ya sekunde 20 — mpaka itakapokuwa live tena au mtumiaji
  // achague channel nyingine (playToken inabadilika hivyo retry ya zamani
  // inajizuia yenyewe).
  // -------------------------------------------------------------------
  // -------------------------------------------------------------------
  // YouTube channels (Wasafi, TBC, n.k): huchezwa kwenye iframe, si
  // <video>/HLS. Tunaangalia kwanza kama ipo LIVE; kama hapana, tunacheza
  // video la mwisho lililopakiwa. Kila sekunde 60 tunaangalia tena — ikiwa
  // imeanza live, tunahamia live moja kwa moja bila mtumiaji kufanya lolote.
  // -------------------------------------------------------------------
  async function playYouTubeChannel(channel, index, myToken) {
    try {
      const res = await fetch(`/api/youtube/${channel.youtube_key}`);
      if (myToken !== playToken) return; // mtumiaji ameshabadili channel
      if (!res.ok) {
        showError("Channel hii haipatikani YouTube kwa sasa", index, false, true, myToken);
        return;
      }
      const data = await res.json();
      showYouTubeVideo(data, index, myToken);
      clearInterval(ytCheckTimer);
      ytCheckTimer = setInterval(() => checkYouTubeUpdate(channel, index, myToken), 60000);
    } catch (err) {
      console.error(err);
      if (myToken === playToken) {
        showError("Imeshindikana kufikia YouTube — angalia mtandao wako", index, false, true, myToken);
      }
    }
  }

  function showYouTubeVideo(data, index, myToken) {
    if (myToken !== playToken) return;
    ytCurrentVideoId = data.video_id;
    ytFrame.src = `https://www.youtube-nocookie.com/embed/${data.video_id}?autoplay=1&playsinline=1&rel=0`;
    ytFrame.hidden = false;
    playerStatic.hidden = true;
    onAirBadge.hidden = !data.is_live;
    ytBadge.hidden = data.is_live;
    guardScroll(600);
    dlog(data.is_live ? "YouTube: ipo LIVE sasa" : "YouTube: haipo live — inacheza video la mwisho");
  }

  async function checkYouTubeUpdate(channel, index, myToken) {
    if (myToken !== playToken) { clearInterval(ytCheckTimer); return; }
    if (document.hidden) return;
    try {
      const res = await fetch(`/api/youtube/${channel.youtube_key}`);
      if (!res.ok || myToken !== playToken) return;
      const data = await res.json();
      if (data.video_id && data.video_id !== ytCurrentVideoId) {
        dlog("YouTube: video/hali imebadilika — inasasisha player…");
        showYouTubeVideo(data, index, myToken);
      } else {
        onAirBadge.hidden = !data.is_live;
        ytBadge.hidden = data.is_live;
      }
    } catch (err) {
      console.error("YouTube check imeshindwa:", err);
    }
  }


  function showError(message, index, offerFix, retryable, token) {
    if (token !== undefined && token !== playToken) return; // si channel ya sasa
    playerStatic.hidden = false;
    onAirBadge.hidden = true;

    let text = message || "Stream hii haipatikani kwa sasa";
    if (retryable) text += " — tunajaribu tena kila baada ya sekunde 20…";
    playerStatic.querySelector(".static-msg").textContent = text;

    fixBtn.hidden = !offerFix;
    if (offerFix && currentChannel) {
      fixBtn.onclick = () => playChannel(currentChannel, index, true);
    }

    clearTimeout(retryTimer);
    if (retryable && currentChannel) {
      retryTimer = setTimeout(() => {
        if (token !== playToken) return;
        if (document.hidden) return; // usijaribu app ikiwa background
        dlog("Retry otomatiki: inajaribu channel hii tena…");
        playChannel(currentChannel, index);
      }, 20000);
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
          ${ch.logo ? `<img class="card-logo" src="${ch.logo}" alt="" loading="lazy" width="28" height="28" onerror="this.style.visibility='hidden'">` : ""}
        </div>
        <span class="card-name">${escapeHtml(ch.name || "Bila jina")}</span>
        <span class="card-group">${escapeHtml(ch.group || ch.country || "")}</span>
      `;
      card.addEventListener("click", () => {
        // zuia kubofya channel hiyo hiyo mara mbili haraka (chanzo cha
        // kawaida cha ujumbe "play() interrupted by a new load request")
        if (currentChannel && currentChannel.url === ch.url &&
            currentChannel.youtube_key === ch.youtube_key &&
            Date.now() - (card.dataset.lastPlay || 0) < 800) {
          return;
        }
        card.dataset.lastPlay = Date.now();
        guardScroll(1000);
        playChannel(ch, i);
      });
      frag.appendChild(card);
    });
    grid.appendChild(frag);

    // kama channel iliyokuwa ikichezwa bado ipo kwenye orodha mpya, ionyeshe
    // tena kama "playing" (inatumika na silent refresh)
    if (currentChannel) {
      const idx = channels.findIndex((c) => c.url === currentChannel.url);
      if (idx >= 0) {
        const card = grid.querySelector(`[data-index="${idx}"]`);
        if (card) card.classList.add("playing");
      }
    }
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  let mode = "country";
  let activeCategory = null;

  function currentListUrl() {
    return mode === "category"
      ? `/api/category/${activeCategory}`
      : `/api/country/${currentCountry}`;
  }

  async function loadContent() {
    grid.innerHTML = "";
    guideStatus.hidden = false;
    guideStatus.textContent = "Inapakia chaneli…";
    searchInput.value = "";

    try {
      const res = await fetch(currentListUrl());
      const data = await res.json();
      guideStatus.textContent = `${data.count} chaneli zimepatikana`;
      renderChannels(data.channels || []);
      scheduleListRefresh();
    } catch (err) {
      guideStatus.textContent = "Imeshindikana kupakia chaneli. Angalia mtandao wako.";
      console.error(err);
    }
  }

  // -------------------------------------------------------------------
  // Silent refresh: kila dakika 3 tunaangalia kama orodha imebadilika
  // (channel zilizokuwa haziko live sasa zime-disappear, na zile
  // zilizorudi live zimeongezwa). Haivunji video inayochezwa wala
  // haisogeza screen.
  // -------------------------------------------------------------------
  function scheduleListRefresh() {
    clearInterval(listRefreshTimer);
    listRefreshTimer = setInterval(silentRefresh, 3 * 60 * 1000);
  }

  async function silentRefresh() {
    if (document.hidden) return;
    if (searchInput.value.trim()) return; // usiingiliane na search inayoendelea

    try {
      const res = await fetch(currentListUrl());
      const data = await res.json();
      const newChannels = data.channels || [];

      const sameLength = newChannels.length === currentChannels.length;
      const unchanged = sameLength && newChannels.every((c, i) => c.url === currentChannels[i]?.url);
      if (unchanged) return;

      guardScroll(500);
      guideStatus.hidden = true;
      renderChannels(newChannels);
      dlog(`Orodha ya chaneli imesasishwa kimya kimya (${newChannels.length} sasa)`);
    } catch (err) {
      console.error("Silent refresh imeshindwa:", err);
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
      clearInterval(listRefreshTimer);
      clearTimeout(retryTimer);
      clearInterval(ytCheckTimer);
      dlog("App imekwenda background — video imesimamishwa kuokoa data");
    } else {
      if (currentChannel && currentChannel.type !== "youtube" && video.paused && video.src) {
        video.play().catch(() => {});
      }
      if (currentChannel && currentChannel.type === "youtube") {
        clearInterval(ytCheckTimer);
        ytCheckTimer = setInterval(() => checkYouTubeUpdate(currentChannel, currentIndex, playToken), 60000);
      }
      scheduleListRefresh();
    }
  });

  loadContent();
})();
