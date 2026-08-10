(() => {
  const video = document.getElementById("video");
  const playerStatic = document.getElementById("playerStatic");
  const onAirBadge = document.getElementById("onAirBadge");
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

  // ---------------- Player ----------------
  function playChannel(channel, index) {
    if (!channel.url) return;

    document.querySelectorAll(".channel-card").forEach((el) => el.classList.remove("playing"));
    const card = grid.querySelector(`[data-index="${index}"]`);
    if (card) card.classList.add("playing");

    npNumber.textContent = String(index + 1).padStart(3, "0");
    npName.textContent = channel.name || "Bila jina";
    npGroup.textContent = channel.group || channel.country || "";
    playerStatic.hidden = true;
    onAirBadge.hidden = false;

    if (hls) {
      hls.destroy();
      hls = null;
    }

    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({ maxBufferLength: 30 });
      hls.loadSource(channel.url);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        if (data.fatal) {
          console.warn("Stream haifanyi kazi:", channel.name, data);
          showError();
        }
      });
      video.play().catch(() => {});
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = channel.url;
      video.play().catch(() => {});
    } else {
      showError();
    }
  }

  function showError() {
    playerStatic.hidden = false;
    onAirBadge.hidden = true;
    playerStatic.querySelector(".static-msg").textContent =
      "Stream hii haipatikani kwa sasa — jaribu chaneli nyingine";
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
