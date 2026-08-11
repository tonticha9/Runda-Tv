# Runda TV

App ya kutazama live TV channels — Tanzania, na dunia nzima — kwenye simu au
kompyuta. Chanzo cha channels ni playlist za umma za
[iptv-org/iptv](https://github.com/iptv-org/iptv), zinazopatikana kihalali.

## Makundi
- 🇹🇿 Tanzania (channels zote za nchi)
- 📰 Habari
- 🎵 Muziki
- 🎭 Burudani
- 🙏 Dini
- 🎬 Movies
- 🧸 Cartoon (kids)
- 🌍 Dunia nzima (chagua nchi)

## Jinsi inavyofanya kazi
`app.py` (Flask) ina-fetch faili za `.m3u` moja kwa moja kutoka iptv-org
wakati wa request, inazi-parse, na kuzihifadhi kwenye cache ya dakika 60 ili
kuepuka kupiga request nyingi. Frontend (`static/js/app.js`) inatumia
**HLS.js** kucheza streams (m3u8) moja kwa moja browser-ni, bila mtu
kupakua chochote.

## Kuendesha kwa local (kwa majaribio)
```bash
pip install -r requirements.txt
python app.py
```
Fungua http://localhost:5000

## Ku-deploy (Render / Fly.io — mtindo unaotumia kawaida)
1. Sukuma (push) folder hii kwenye GitHub repo mpya.
2. Render: Unda "Web Service" mpya, chagua repo, build command
   `pip install -r requirements.txt`, start command `gunicorn app:app`.
3. Fly.io: `fly launch` kisha `fly deploy` (Procfile tayari ipo).

## Vidokezo
- Baadhi ya streams za iptv-org huwa hazifanyi kazi wakati fulani (zime-
  expire au zime-geoblock) — hii ni ya kawaida kwa IPTV za umma.
- Hatuhifadhi video yoyote kwenye server — ni links tu za streams za umma.
- Hatua inayofuata (kama tulivyopanga): kuongeza "live channels" za YouTube
  zinazorusha 24/7 kama chanzo cha ziada.
