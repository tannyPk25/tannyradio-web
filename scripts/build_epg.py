"""Construiește epg/ro.json: programul TV (acum + următoarele ~36h) pentru canalele RO.

Rulează în GitHub Actions la fiecare 6 ore (vezi .github/workflows/epg.yml).
Sursa: ghiduri XMLTV publice; potrivirea cu canalele iptv-org se face după nume normalizat.
"""
import gzip, json, re, sys, time, urllib.request, xml.etree.ElementTree as ET
from datetime import datetime

SOURCES = [
    "https://epgshare01.online/epgshare01/epg_ripper_RO1.xml.gz",
    "https://iptv-epg.org/files/epg-ro.xml.gz",
]
M3U = "https://iptv-org.github.io/iptv/countries/ro.m3u"
HOURS_AHEAD = 36
UA = {"User-Agent": "TMedia-EPG/1.0 (+https://tannyradio-web.vercel.app)"}


def get(url, timeout=90):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    return gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data


def fold(s):
    """Nume comparabil: fără rezoluție/[Not 24/7]/@feed/prefix „RO -”, fără spații și semne."""
    s = s.lower()
    s = re.sub(r"^ro\s*-\s*", "", s)
    s = re.sub(r"\(.*?\)|\[.*?\]|@.*", "", s)
    s = re.sub(r"\b(hd|fhd|uhd|sd|4k|romania|ro)\b", "", s)
    return re.sub(r"[^a-z0-9]", "", s)


def ts(x):
    return int(datetime.strptime(x.strip(), "%Y%m%d%H%M%S %z").timestamp())


def main(out_path):
    m3u = get(M3U).decode("utf-8", "replace")
    channels = {}  # tvg-id -> cheie normalizată
    for tid, name in re.findall(r'tvg-id="([^"]*)"[^\n]*?,([^\r\n]*)', m3u):
        if tid:
            channels.setdefault(tid, set()).update({fold(name), fold(tid.split(".")[0])})

    now = int(time.time())
    horizon = now + HOURS_AHEAD * 3600
    result = {}
    for src in SOURCES:
        try:
            root = ET.fromstring(get(src))
        except Exception as e:  # sursă căzută → încercăm următoarea
            print("skip", src, e, file=sys.stderr)
            continue
        by_key = {}
        for c in root.findall("channel"):
            cid = c.get("id") or ""
            for k in {fold(c.findtext("display-name") or ""), fold(cid.split(".")[0])}:
                if k:
                    by_key.setdefault(k, cid)
        progs = {}
        for p in root.findall("programme"):
            try:
                s, e = ts(p.get("start")), ts(p.get("stop"))
            except Exception:
                continue
            if e < now or s > horizon:
                continue
            progs.setdefault(p.get("channel"), []).append([s, e, (p.findtext("title") or "").strip()[:80]])
        for tid, keys in channels.items():
            if tid in result:
                continue  # deja acoperit de o sursă mai bună
            cid = next((by_key[k] for k in keys if k in by_key), None)
            if cid and progs.get(cid):
                result[tid] = sorted(progs[cid])

    out = {"generated": now, "channels": result}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"EPG: {len(result)} canale, {sum(len(v) for v in result.values())} emisiuni → {out_path}")
    if len(result) < 10:
        sys.exit("Prea puține canale potrivite — nu suprascriem ghidul")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "epg/ro.json")
