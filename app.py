"""
Runda TV — Live channels streaming app
Flask backend inayochukua playlists (M3U) kutoka iptv-org (chanzo huru cha
IPTV playlists za umma) na kuzipanga kwa makundi: Habari na Dini pekee, pamoja
na Dunia nzima (kwa nchi), zote zikiwa zimechujwa kuondoa channels za
sports/movies/cartoon ambazo kwa kawaida si za leseni halali.

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
REQUEST_TIMEOUT = 12
CACHE_TTL = 60 * 60

CATEGORIES = {
    "news":      {"label": "Habari", "slug": "news",      "emoji": "📰"},
    "religious": {"label": "Dini",   "slug": "religious", "emoji": "🙏"},
}

BLOCKLIST_KEYWORDS = [
    "sport", "espn", "bein", "supersport", "sky sport", "dazn", "eurosport",
    "willow", "star sports", "fox sports", "gol tv", "premier sports",
    "sportklub", "setanta", "match tv", "elevensports", "canal+ sport",
    "hbo", "disney", "cartoon network", "nickelodeon", "nick jr", "cinemax",
    "showtime", "starz", "paramount", "universal", "warner", "sony movies",
    "fox movies", "amc", "cnbc movies", "zee cinema", "star movies",
    "cine", "cinema", "movistar", "boomerang", "cartoonito", "netflix",
    "prime video", "apple tv", "peacock",
]


def is_blocked(channel: dict) -> bool:
    haystack = f"{channel.get('name', '')} {channel.get('group', '')}".lower()
    return any(kw in haystack for kw in BLOCKLIST_KEYWORDS)

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


RES_RE = re.compile(r"\((\d{3,4})p\)")


def extract_resolution(name: str) -> int | None:
    m = RES_RE.search(name or "")
    return int(m.group(1)) if m else None


def base_name(name: str) -> str:
    return RES_RE.sub("", name or "").strip().lower()


def prefer_medium_quality(channels: list[dict]) -> list[dict]:
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

        def score(ch):
            res = extract_resolution(ch.get("name", "")) or 0
            target = 600
            return abs(res - target)

        best = min(variants, key=score)
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
    return prefer_medium_quality(out)


LIVE_CHECK_TIMEOUT = 2.5
LIVE_CHECK_MAX_WORKERS = 40
LIVE_CHECK_BUDGET = 4
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
    channels = filter_live(dedupe(get_country_channels("tz")))
    return jsonify({"count": len(channels), "channels": channels})


@app.route("/api/category/<slug>")
def api_category(slug):
    if slug not in CATEGORIES:
        return jsonify({"error": "kundi halijulikani"}), 404
    channels = filter_live(dedupe(get_category_channels(CATEGORIES[slug]["slug"])))
    return jsonify({"count": len(channels), "channels": channels})


@app.route("/api/country/<code>")
def api_country(code):
    channels = filter_live(dedupe(get_country_channels(code.lower())))
    return jsonify({"count": len(channels), "channels": channels})


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
        pool = get_country_channels("tz")
    elif scope in CATEGORIES:
        pool = get_category_channels(CATEGORIES[scope]["slug"])
    else:
        pool = get_country_channels(scope.lower())

    results = [c for c in dedupe(pool) if q in c.get("name", "").lower()]
    results = filter_live(results)
    return jsonify({"count": len(results), "channels": results})


@app.route("/healthz")
def healthz():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
