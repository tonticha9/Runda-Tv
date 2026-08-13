"""
Runda TV — Live channels streaming app
Flask backend inayochukua playlists (M3U) kutoka iptv-org (chanzo huru cha
IPTV playlists za umma) na kuzipanga kwa makundi: Habari, Dini, Sports,
Movies, Music, Entertainment, Kids/Cartoon — pamoja na Dunia nzima (kwa nchi).

Hakuna video inayohifadhiwa kwenye server hii — tunapitisha tu links za
streams zilizopo hadharani.
"""
import os
import re
import time
import logging
import concurrent.futures
from functools import wraps

import requests
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("runda-tv")

IPTV_BASE = "https://iptv-org.github.io/iptv"
REQUEST_TIMEOUT = 8
CACHE_TTL = 60 * 60

CATEGORIES = {
    "news":          {"label": "Habari",      "slug": "news",          "emoji": "📰"},
    "religious":     {"label": "Dini",        "slug": "religious",     "emoji": "🙏"},
    "sports":        {"label": "Sports",      "slug": "sports",        "emoji": "⚽"},
    "movies":        {"label": "Movies",      "slug": "movies",        "emoji": "🎬"},
    "music":         {"label": "Music",       "slug": "music",         "emoji": "🎵"},
    "entertainment": {"label": "Burudani",    "slug": "entertainment", "emoji": "🎭"},
    "kids":          {"label": "Cartoon",     "slug": "kids",          "emoji": "🧸"},
}

# Blocklist imeachwa wazi kwa maombi ya msanii — categories zote (sports,
# movies, cartoon, n.k) sasa zinaingia bila kuchujwa. Ukitaka kurudisha
# uchujaji baadaye (mfano premium brands pekee), ongeza maneno humu.
BLOCKLIST_KEYWORDS: list[str] = []


def is_blocked(channel: dict) -> bool:
    if not BLOCKLIST_KEYWORDS:
        return False
    haystack = f"{channel.get('name', '')} {channel.get('group', '')}".lower()
    return any(kw in haystack for kw in BLOCKLIST_KEYWORDS)


# ---------------------------------------------------------------------------
# Channels za Tanzania zisizopatikana kwenye iptv-org lakini zinazorusha
# kwenye YouTube (Wasafi TV, TBC, ITV, n.k). Hizi zinaongezwa moja kwa moja
# kwenye orodha ya "Tanzania" — si tab/tier tofauti.
#
# "channel_id" ni ile UCxxxxxxxxxxxxxxxxxxxxxxxx (si @jina wala video link).
# Ongeza entries hapa chini utakapopata Channel ID za kila kituo.
# ---------------------------------------------------------------------------
CUSTOM_YOUTUBE_CHANNELS: dict[str, dict] = {
    # --- Habari ---
    "itv":         {"label": "ITV Tanzania",  "group": "Habari",   "channel_id": "UCRmReUqNqc-GSZeD48QKjhQ"},
    "eatv":        {"label": "EATV",          "group": "Habari",   "channel_id": "UCyYzMKBalg6jMVNuC-JRMog"},
    "tbc":         {"label": "TBC",           "group": "Habari",   "channel_id": "UCj0bMshbN_6uVubF5Zq74iw"},
    "channelten":  {"label": "Channel Ten",   "group": "Habari",   "channel_id": "UCbL9oen2mK3mRcoS-bWqIig"},
    "cloudstv":    {"label": "Clouds TV",     "group": "Habari",   "channel_id": "UC57gZpSndZioE7b93XfD78Q"},
    # --- Burudani ---
    "wasafi":      {"label": "Wasafi TV",     "group": "Burudani", "channel_id": "UC-B3b6C0Z_tUeAsa5OiswXg"},
    "safaritv":    {"label": "Safari TV",     "group": "Burudani", "channel_id": "UC1bXWpZ3p5hE39w7Ie9L2vQ"},
    # --- Muziki ---
    "tracemziki":  {"label": "Trace Mziki",   "group": "Muziki",   "channel_id": "UCEEEl-UyDconQ-MIGvqgHUQ"},
    # --- Movies ---
    "sinemazetu":  {"label": "Sinema Zetu",   "group": "Movies",   "channel_id": "UCvfGTyirCsFQRnLhX_N_oww"},
    "starswahili": {"label": "Star Swahili",  "group": "Movies",   "channel_id": "UChO8wVAs_NfR74LgE4m6P9w"},
    # --- Sports ---
    "azamsports":  {"label": "Azam Sports",   "group": "Sports",   "channel_id": "UCpHiA0taMn231yDiUeqoANw"},
}

def fetch_html_snippet(url: str, stop_markers: tuple, timeout: float = 6, max_bytes: int = 350_000) -> str:
    """Pakua ukurasa taratibu (streaming) na SIMAMA mara tunapopata alama
    tunazohitaji (mfano 'lengthSeconds') — badala ya kupakua ukurasa mzima
    wa YouTube (unaoweza kuwa 1MB+). Hii ndiyo chanzo kikuu cha ucheleweshaji
    uliokuwepo — sasa tunapunguza data tunayopakua kwa kiasi kikubwa."""
    chunks = []
    total = 0
    resp = requests.get(
        url, timeout=timeout, stream=True,
        headers={"User-Agent": "Mozilla/5.0 (Linux; Android 12) RundaTV/1.0"},
    )
    try:
        resp.raise_for_status()
        for chunk in resp.iter_content(chunk_size=16384):
            if not chunk:
                continue
            chunks.append(chunk.decode("utf-8", errors="ignore"))
            total += len(chunk)
            combined_tail = "".join(chunks[-3:])  # dirisha dogo la kutosha kupata pattern
            if any(marker in combined_tail or marker in chunks[-1] for marker in stop_markers):
                break
            if total >= max_bytes:
                break
    finally:
        resp.close()
    return "".join(chunks)


YT_LIVE_URL = "https://www.youtube.com/channel/{}/live"
YT_RSS_URL = "https://www.youtube.com/feeds/videos.xml?channel_id={}"
YT_WATCH_URL = "https://www.youtube.com/watch?v={}"
YT_CANONICAL_RE = re.compile(r'"canonicalUrl":"https://www\.youtube\.com/watch\?v=([a-zA-Z0-9_-]{11})"')
YT_VIDEOID_RSS_RE = re.compile(r'<yt:videoId>([a-zA-Z0-9_-]{11})</yt:videoId>')
YT_DURATION_RE = re.compile(r'"lengthSeconds":"(\d+)"')
YT_CACHE_TTL = 90  # sekunde — status ya live inabadilika haraka, cache fupi
YT_SCHEDULE_TTL = 30 * 60  # dakika 30 — orodha ya video mpya haibadiliki mara kwa mara
YT_DEFAULT_DURATION = 600  # dakika 10 — kama tumeshindwa kupata muda halisi

_youtube_cache: dict[str, tuple[float, dict]] = {}
_duration_cache: dict[str, int] = {}
_schedule_cache: dict[str, tuple[float, list]] = {}


def get_video_duration(video_id: str) -> int:
    """Muda (sekunde) wa video — unahifadhiwa kabisa (haubadiliki kamwe
    baada ya video kupakiwa), kwa hiyo cache yake haiisha muda."""
    if video_id in _duration_cache:
        return _duration_cache[video_id]
    duration = YT_DEFAULT_DURATION
    try:
        html = fetch_html_snippet(YT_WATCH_URL.format(video_id), stop_markers=('"lengthSeconds"',))
        m = YT_DURATION_RE.search(html)
        if m:
            duration = max(int(m.group(1)), 30)
    except requests.RequestException as exc:
        log.warning("Imeshindikana kupata muda wa video %s: %s", video_id, exc)
    _duration_cache[video_id] = duration
    return duration


def get_recent_video_ids(channel_id: str, limit: int = 8) -> list[str]:
    try:
        resp = requests.get(YT_RSS_URL.format(channel_id), timeout=6)
        ids = YT_VIDEOID_RSS_RE.findall(resp.text)
        return ids[:limit]
    except requests.RequestException as exc:
        log.warning("Imeshindikana kupata RSS ya ratiba %s: %s", channel_id, exc)
        return []


def get_channel_schedule(channel_id: str) -> list[tuple[str, int]]:
    """Orodha ya (video_id, muda) ya video za hivi karibuni za channel,
    zenye cache ya dakika 30. Durations zote zinavutwa KWA PAMOJA
    (parallel) badala ya moja baada ya nyingine — hii ndiyo iliyokuwa
    sababu kuu ya ucheleweshaji wa zaidi ya sekunde 10."""
    now = time.time()
    hit = _schedule_cache.get(channel_id)
    if hit and now - hit[0] < YT_SCHEDULE_TTL:
        return hit[1]

    ids = get_recent_video_ids(channel_id)
    schedule = []
    if ids:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(ids), 8)) as pool:
            future_to_id = {pool.submit(get_video_duration, vid): vid for vid in ids}
            for fut in concurrent.futures.as_completed(future_to_id, timeout=10):
                vid = future_to_id[fut]
                try:
                    dur = fut.result()
                except Exception:
                    dur = YT_DEFAULT_DURATION
                if dur > 0:
                    schedule.append((vid, dur))
        # rudisha kwenye mpangilio wa awali (wa tarehe) badala ya mpangilio
        # usio na mfumo unaosababishwa na as_completed
        order = {vid: i for i, vid in enumerate(ids)}
        schedule.sort(key=lambda item: order.get(item[0], 999))

    _schedule_cache[channel_id] = (now, schedule)
    return schedule


def compute_virtual_playback(channel_id: str) -> dict:
    """Inatengeneza 'channel ya moja kwa moja' kutoka video za nyuma —
    kila mtu anayetazama wakati mmoja anaona sehemu ile ile ya video hiyo
    (kama TV halisi), kwa kutumia muda wa sasa wa duniani (epoch) kama
    saa ya kudumu ya kituo — si kwa mtumiaji mmoja mmoja."""
    schedule = get_channel_schedule(channel_id)
    if not schedule:
        return {"video_id": None, "start": 0}

    total = sum(d for _, d in schedule)
    if total <= 0:
        return {"video_id": schedule[0][0], "start": 0}

    elapsed = int(time.time()) % total
    cursor = 0
    for vid, dur in schedule:
        if elapsed < cursor + dur:
            return {"video_id": vid, "start": elapsed - cursor}
        cursor += dur

    return {"video_id": schedule[0][0], "start": 0}


def next_in_schedule(channel_id: str, after_video_id: str) -> dict:
    """Video INAYOFUATA baada ya hii iliyoisha (si kwa kuhesabu muda tena,
    ili kuepuka 'kudrift' — inatumika pindi frontend inapotuambia video
    fulani imeisha kwa hakika, kupitia YouTube Player API's ENDED event)."""
    schedule = get_channel_schedule(channel_id)
    if not schedule:
        return {"video_id": None, "start": 0}
    ids = [v for v, _ in schedule]
    if after_video_id in ids:
        nxt = ids[(ids.index(after_video_id) + 1) % len(ids)]
    else:
        nxt = ids[0]
    return {"video_id": nxt, "start": 0}


def resolve_youtube_channel(channel_id: str) -> dict:
    """Angalia kama channel ipo LIVE sasa; kama hapana, rudisha nafasi
    sahihi ya 'ratiba ya kudumu' iliyotengenezwa kutoka video za nyuma —
    kama TV halisi, si video ile ile ikianza upya kila mara."""
    now = time.time()
    hit = _youtube_cache.get(channel_id)
    if hit and now - hit[0] < YT_CACHE_TTL:
        return hit[1]

    result = {"video_id": None, "is_live": False, "start": 0}
    try:
        html = fetch_html_snippet(
            YT_LIVE_URL.format(channel_id),
            stop_markers=('"isLive":true', '"isLiveNow":true', '"canonicalUrl"'),
        )
        is_live_flag = '"isLive":true' in html or '"isLiveNow":true' in html
        m = YT_CANONICAL_RE.search(html)
        if is_live_flag and m:
            result = {"video_id": m.group(1), "is_live": True, "start": 0}
    except requests.RequestException as exc:
        log.warning("Imeshindikana kuangalia live YouTube %s: %s", channel_id, exc)

    if not result["video_id"]:
        pos = compute_virtual_playback(channel_id)
        if pos.get("video_id"):
            result = {"video_id": pos["video_id"], "is_live": False, "start": pos.get("start", 0)}

    _youtube_cache[channel_id] = (now, result)
    return result


def tz_youtube_cards() -> list[dict]:
    """Geuza CUSTOM_YOUTUBE_CHANNELS kuwa 'channel cards' zenye muundo
    unaofanana na zile za iptv-org, ili ziingie kwenye grid ile ile."""
    cards = []
    for key, meta in CUSTOM_YOUTUBE_CHANNELS.items():
        cards.append({
            "name": meta["label"],
            "logo": meta.get("logo", ""),
            "group": meta.get("group", "Tanzania"),
            "country": "TZ",
            "type": "youtube",
            "youtube_key": key,
        })
    return cards

WORLD_COUNTRIES = [
    {"code": "tz", "label": "Tanzania", "flag": "🇹🇿"},
    {"code": "ke", "label": "Kenya", "flag": "🇰🇪"},
    {"code": "ug", "label": "Uganda", "flag": "🇺🇬"},
    {"code": "rw", "label": "Rwanda", "flag": "🇷🇼"},
    {"code": "za", "label": "Afrika Kusini", "flag": "🇿🇦"},
    {"code": "ng", "label": "Nigeria", "flag": "🇳🇬"},
    {"code": "eg", "label": "Misri", "flag": "🇪🇬"},
    {"code": "us", "label": "Marekani", "flag": "🇺🇸"},
    {"code": "gb", "label": "Uingereza", "flag": "🇬🇧"},
    {"code": "fr", "label": "Ufaransa", "flag": "🇫🇷"},
    {"code": "de", "label": "Ujerumani", "flag": "🇩🇪"},
    {"code": "in", "label": "India", "flag": "🇮🇳"},
    {"code": "cn", "label": "China", "flag": "🇨🇳"},
    {"code": "ae", "label": "UAE", "flag": "🇦🇪"},
    {"code": "sa", "label": "Saudi Arabia", "flag": "🇸🇦"},
    {"code": "br", "label": "Brazil", "flag": "🇧🇷"},
    {"code": "tr", "label": "Uturuki", "flag": "🇹🇷"},
    {"code": "es", "label": "Hispania", "flag": "🇪🇸"},
]

_cache: dict[str, tuple[float, list]] = {}


def cached(key_fn):
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            key = key_fn(*args, **kwargs)
            now = time.time()
            if key in _cache:
                ts, data = _cache[key]
                if now - ts < CACHE_TTL:
                    return data
            data = fn(*args, **kwargs)
            _cache[key] = (now, data)
            return data
        return wrapper
    return decorator


EXTINF_RE = re.compile(
    r'#EXTINF:-?\d+(?P<attrs>(?:\s+[\w-]+="[^"]*")*)\s*,\s*(?P<name>.+)'
)
ATTR_RE = re.compile(r'([\w-]+)="([^"]*)"')


def parse_m3u(text: str) -> list[dict]:
    channels = []
    lines = text.splitlines()
    pending = None

    for line in lines:
        line = line.strip()
        if not line:
            continue
        if line.startswith("#EXTINF"):
            m = EXTINF_RE.match(line)
            if not m:
                pending = None
                continue
            attrs = dict(ATTR_RE.findall(m.group("attrs") or ""))
            pending = {
                "name": m.group("name").strip(),
                "logo": attrs.get("tvg-logo", ""),
                "group": attrs.get("group-title", ""),
                "country": attrs.get("tvg-country", ""),
                "language": attrs.get("tvg-language", ""),
                "id": attrs.get("tvg-id", ""),
            }
        elif line.startswith("#"):
            continue
        else:
            if pending is not None:
                pending["url"] = line
                channels.append(pending)
                pending = None

    return channels


def fetch_playlist(url: str) -> list[dict]:
    try:
        resp = requests.get(url, timeout=REQUEST_TIMEOUT, headers={
            "User-Agent": "RundaTV/1.0"
        })
        resp.raise_for_status()
        return parse_m3u(resp.text)
    except requests.RequestException as exc:
        log.warning("Imeshindikana kupata playlist %s: %s", url, exc)
        return []


@cached(lambda slug: f"category:{slug}")
def get_category_channels(slug: str) -> list[dict]:
    return fetch_playlist(f"{IPTV_BASE}/categories/{slug}.m3u")


@cached(lambda code: f"country:{code}")
def get_country_channels(code: str) -> list[dict]:
    return fetch_playlist(f"{IPTV_BASE}/countries/{code}.m3u")


@cached(lambda code: f"country_full:{code}")
def get_country_channels_full(code: str) -> list[dict]:
    """Country playlist ya moja kwa moja + channels za makundi yote (news,
    dini, movies, sports, n.k) ambazo zimeainishwa kwa nchi hii, ili
    kuchagua nchi kuonyeshe kila kitu kinachopatikana, si orodha finyu tu.
    Zote (direct + makundi 7) zinavutwa KWA PAMOJA kwenye pool moja — si
    direct kwanza kisha makundi baadaye — kwa kasi zaidi."""
    code_lower = code.lower()
    code_upper = code.upper()

    direct: list[dict] = []
    category_channels: list[dict] = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(CATEGORIES) + 1) as pool:
        direct_future = pool.submit(get_country_channels, code_lower)
        cat_futures = [pool.submit(get_category_channels, meta["slug"]) for meta in CATEGORIES.values()]

        try:
            direct = direct_future.result(timeout=15)
        except Exception as exc:
            log.warning("Imeshindikana kupata orodha ya moja kwa moja ya nchi %s: %s", code, exc)

        for fut in concurrent.futures.as_completed(cat_futures, timeout=15):
            try:
                category_channels.extend(fut.result())
            except Exception as exc:
                log.warning("Imeshindikana kupata kundi kwa ajili ya nchi %s: %s", code, exc)

    country_tagged = [c for c in category_channels if (c.get("country") or "").upper() == code_upper]
    return direct + country_tagged


RES_RE = re.compile(r"\((\d{3,4})p\)")


def extract_resolution(name: str) -> int | None:
    m = RES_RE.search(name or "")
    return int(m.group(1)) if m else None


def base_name(name: str) -> str:
    return RES_RE.sub("", name or "").strip().lower()


def prefer_best_quality(channels: list[dict]) -> list[dict]:
    """Ukiwa na variants kadhaa za channel hiyohiyo (mfano 360p/576p/1080p),
    chagua ubora wa JUU zaidi unaopatikana — si wa kati tena, kwa maombi ya
    msanii ya 'quality ya hali ya juu kama TV nyingine'."""
    groups: dict[str, list[dict]] = {}
    no_res: list[dict] = []

    for ch in channels:
        res = extract_resolution(ch.get("name", ""))
        if res is None:
            no_res.append(ch)
            continue
        key = base_name(ch.get("name", ""))
        groups.setdefault(key, []).append(ch)

    out = list(no_res)
    for variants in groups.values():
        if len(variants) == 1:
            out.append(variants[0])
            continue

        best = max(variants, key=lambda ch: extract_resolution(ch.get("name", "")) or 0)
        out.append(best)
    return out


def dedupe(channels: list[dict]) -> list[dict]:
    seen = set()
    out = []
    for ch in channels:
        key = (ch.get("name", "").strip().lower(), ch.get("url", ""))
        if key in seen or not ch.get("url"):
            continue
        if is_blocked(ch):
            continue
        seen.add(key)
        out.append(ch)
    return prefer_best_quality(out)


LIVE_CHECK_TIMEOUT = 1.8
LIVE_CHECK_MAX_WORKERS = 80
LIVE_CHECK_BUDGET = 2.5
LIVE_CACHE_TTL = 5 * 60

_live_cache: dict[str, tuple[float, bool]] = {}


def check_alive(url: str) -> bool:
    try:
        resp = requests.get(
            url, timeout=LIVE_CHECK_TIMEOUT, stream=True,
            headers={"User-Agent": "RundaTV/1.0"},
        )
        ok = resp.status_code < 400
        resp.close()
        return ok
    except requests.RequestException:
        return False


def filter_live(channels: list[dict]) -> list[dict]:
    now = time.time()
    result = []
    to_check = []

    for ch in channels:
        url = ch.get("url", "")
        cached = _live_cache.get(url)
        if cached and now - cached[0] < LIVE_CACHE_TTL:
            if cached[1]:
                result.append(ch)
            continue
        to_check.append(ch)

    if to_check:
        with concurrent.futures.ThreadPoolExecutor(max_workers=LIVE_CHECK_MAX_WORKERS) as pool:
            future_map = {pool.submit(check_alive, ch["url"]): ch for ch in to_check}
            done, not_done = concurrent.futures.wait(future_map.keys(), timeout=LIVE_CHECK_BUDGET)
            for fut in done:
                ch = future_map[fut]
                try:
                    alive = fut.result()
                except Exception:
                    alive = False
                _live_cache[ch["url"]] = (time.time(), alive)
                if alive:
                    result.append(ch)
            for fut in not_done:
                result.append(future_map[fut])

    return result


@app.route("/")
def index():
    return render_template(
        "index.html",
        categories=CATEGORIES,
        countries=WORLD_COUNTRIES,
    )


@app.route("/api/tanzania")
def api_tanzania():
    channels = filter_live(dedupe(get_country_channels_full("tz")))
    channels = channels + tz_youtube_cards()
    return jsonify({"count": len(channels), "channels": channels})


@app.route("/api/category/<slug>")
def api_category(slug):
    if slug not in CATEGORIES:
        return jsonify({"error": "kundi halijulikani"}), 404
    channels = filter_live(dedupe(get_category_channels(CATEGORIES[slug]["slug"])))
    return jsonify({"count": len(channels), "channels": channels})


@app.route("/api/country/<code>")
def api_country(code):
    code = code.lower()
    channels = filter_live(dedupe(get_country_channels_full(code)))
    if code == "tz":
        channels = channels + tz_youtube_cards()
    return jsonify({"count": len(channels), "channels": channels})


@app.route("/api/youtube/<key>")
def api_youtube_resolve(key):
    meta = CUSTOM_YOUTUBE_CHANNELS.get(key)
    if not meta:
        return jsonify({"error": "channel haijulikani"}), 404

    after = request.args.get("after")
    if after:
        # Frontend inatuambia video FULANI imeisha kwa hakika (kupitia
        # YouTube Player API) — tupe INAYOFUATA moja kwa moja, si kuhesabu
        # muda tena (inazuia 'kudrift' na kurudi video ile ile).
        nxt = next_in_schedule(meta["channel_id"], after)
        if nxt.get("video_id"):
            return jsonify({"video_id": nxt["video_id"], "is_live": False, "start": 0})

    result = resolve_youtube_channel(meta["channel_id"])
    if not result["video_id"]:
        return jsonify({"error": "haipatikani kwa sasa"}), 502
    return jsonify(result)


@app.route("/api/countries")
def api_countries():
    return jsonify(WORLD_COUNTRIES)


@app.route("/api/search")
def api_search():
    q = request.args.get("q", "").strip().lower()
    scope = request.args.get("scope", "tanzania")
    if not q:
        return jsonify({"count": 0, "channels": []})

    if scope == "tanzania":
        pool = get_country_channels_full("tz")
    elif scope in CATEGORIES:
        pool = get_category_channels(CATEGORIES[scope]["slug"])
    else:
        pool = get_country_channels_full(scope.lower())

    results = [c for c in dedupe(pool) if q in c.get("name", "").lower()]
    results = filter_live(results)
    if scope == "tanzania":
        results = results + [c for c in tz_youtube_cards() if q in c["name"].lower()]
    return jsonify({"count": len(results), "channels": results})


@app.route("/healthz")
def healthz():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
