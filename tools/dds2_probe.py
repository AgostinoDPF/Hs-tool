#!/usr/bin/env python3
"""
DDS2-probe: is de TARIC-consultatiepagina van de Europese Commissie bruikbaar
als geautomatiseerde tariefbron voor de HS-tool?

Draaien:  python3 tools/dds2_probe.py
Vereist:  python3 (alleen standaardbibliotheek), normale internettoegang.

Het script beantwoordt vijf vragen en print aan het eind een oordeel:

  1. Bereikbaar?      Geeft measures.jsp uberhaupt een 200 terug zonder browser?
  2. Sessie nodig?    Werkt een kale request, of eist DDS2 eerst een cookie?
  3. Parseerbaar?     Staat er een herkenbaar recht ("4,7 %") in de HTML?
  4. Oorsprong telt?  Geeft dezelfde code een ander recht voor CN dan voor US?
  5. Snelheid/limiet? Hoe traag is het en gaat het rammelen bij herhaald opvragen?

Alle opgehaalde HTML wordt weggeschreven naar tools/dds2_probe_out/ zodat je zelf
kunt kijken wat er terugkwam.
"""

import http.cookiejar
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

BASE = "https://ec.europa.eu/taxation_customs/dds2"
MEASURES = BASE + "/taric/measures.jsp"
CONSULT = BASE + "/taric/taric_consultation.jsp"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
OUT = Path(__file__).parent / "dds2_probe_out"
TIMEOUT = 40

# Codes uit ons eigen assortiment, met de oorsprong die er in de praktijk toe doet.
# Verwachting is wat er nu in hs_codes.json staat -- puur om afwijkingen te zien,
# niet als waarheid.
CASES = [
    ("9503004100", "CN", "Knuffel uit China", "4.7%"),
    ("9503004100", "US", "Knuffel uit de VS", "4.7%"),
    ("3406000000", "CN", "Kaarsen uit China (antidumping verwacht)", "70,90%"),
    ("3406000000", "VN", "Kaarsen uit Vietnam", "?"),
    ("6115950000", "BD", "Sokken uit Bangladesh (mogelijk preferentieel)", "12%"),
    ("4419190000", "CN", "Houten dienblad uit China", "0%"),
    ("6912002100", "CN", "Keramiek uit China (antidumping verwacht)", "?"),
]

# Een bedrag-met-procent zoals DDS2 rechten toont: "4,7 %", "0.0 %", "70,90%"
DUTY_RE = re.compile(r"\b\d{1,3}(?:[.,]\d{1,3})?\s*%")
TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"[ \t\r\f\v]*\n\s*")


def build_opener():
    """Een opener met cookiejar, zodat we het verschil kaal-vs-sessie kunnen meten."""
    jar = http.cookiejar.CookieJar()
    ctx = ssl.create_default_context()
    return urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(jar),
        urllib.request.HTTPSHandler(context=ctx),
    ), jar


def fetch(opener, url, params=None):
    """Haal een URL op. Geeft (status, seconden, html, foutmelding-of-None)."""
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "nl,en;q=0.8",
    })
    t0 = time.monotonic()
    try:
        with opener.open(req, timeout=TIMEOUT) as r:
            body = r.read().decode("utf-8", errors="replace")
            return r.status, time.monotonic() - t0, body, None
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return e.code, time.monotonic() - t0, body, f"HTTP {e.code}"
    except Exception as e:  # timeout, DNS, TLS, proxy
        return 0, time.monotonic() - t0, "", f"{type(e).__name__}: {e}"


def to_text(html):
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", html)
    text = TAG_RE.sub(" ", text)
    text = (text.replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&lt;", "<").replace("&gt;", ">").replace("&#39;", "'"))
    return WS_RE.sub("\n", text)


def find_duties(html):
    """Alle percentages die als douanerecht kunnen doorgaan, in volgorde."""
    text = to_text(html)
    seen, out = set(), []
    for m in DUTY_RE.finditer(text):
        v = re.sub(r"\s+", "", m.group(0))
        if v not in seen:
            seen.add(v)
            out.append(v)
    return out


def looks_like_error(html):
    t = to_text(html).lower()
    for needle in ("no data", "geen gegevens", "not found", "error", "invalid",
                   "session expired", "sessie", "javascript is required",
                   "enable javascript", "access denied", "forbidden"):
        if needle in t:
            return needle
    return None


def main():
    OUT.mkdir(exist_ok=True)
    simdate = date.today().strftime("%Y%m%d")
    print(f"DDS2-probe  --  referentiedatum {simdate}")
    print(f"HTML wordt bewaard in {OUT}\n")

    verdict = {}

    # ---- 1 & 2: bereikbaarheid, kaal versus met sessie -------------------
    print("[1] Bereikbaarheid en sessie")
    kaal_opener, _ = build_opener()
    taric, area, _, _ = CASES[0]
    params = {"Lang": "nl", "LangDescr": "nl", "Taric": taric,
              "Area": area, "SimDate": simdate}
    st, dt, html, err = fetch(kaal_opener, MEASURES, params)
    print(f"    kaal   measures.jsp -> status {st} in {dt:.1f}s, {len(html)} bytes"
          + (f"  ({err})" if err else ""))
    (OUT / "01_kaal.html").write_text(html)
    verdict["bereikbaar"] = st == 200 and len(html) > 2000

    if err and st == 0:
        print(f"\n    Netwerkfout: {err}")
        print("    Draai dit script op een machine met normale internettoegang.")
        sys.exit(2)

    sess_opener, jar = build_opener()
    fetch(sess_opener, CONSULT, {"Lang": "nl"})          # eerst de consultatiepagina
    st2, dt2, html2, _ = fetch(sess_opener, MEASURES, params)
    print(f"    sessie measures.jsp -> status {st2} in {dt2:.1f}s, {len(html2)} bytes,"
          f" {len(jar)} cookie(s)")
    (OUT / "02_sessie.html").write_text(html2)
    verdict["sessie_nodig"] = len(html2) > len(html) * 1.2

    marker = looks_like_error(html2 if verdict["sessie_nodig"] else html)
    if marker:
        print(f"    let op: pagina bevat '{marker}'")

    best_opener = sess_opener if verdict["sessie_nodig"] else kaal_opener

    # ---- 3, 4, 5: de echte matrix ---------------------------------------
    print("\n[2] Tarieven per code en oorsprong")
    print(f"    {'code':<12}{'land':<6}{'st':<5}{'sec':<7}{'bytes':<9}gevonden percentages")
    results = []
    for taric, area, omschrijving, verwacht in CASES:
        st, dt, html, err = fetch(best_opener, MEASURES, {
            "Lang": "nl", "LangDescr": "nl", "Taric": taric,
            "Area": area, "SimDate": simdate, "Expand": "true",
        })
        duties = find_duties(html)
        (OUT / f"meas_{taric}_{area}.html").write_text(html)
        results.append((taric, area, st, duties, omschrijving, verwacht))
        print(f"    {taric:<12}{area:<6}{st:<5}{dt:<7.1f}{len(html):<9}"
              + (", ".join(duties[:6]) if duties else "-- geen --"))
        time.sleep(1.5)   # beleefd blijven

    ok = [r for r in results if r[2] == 200 and r[3]]
    verdict["parseerbaar"] = len(ok) >= len(CASES) * 0.7

    # verschilt CN van US voor dezelfde code?
    by_code = {}
    for taric, area, st, duties, _, _ in results:
        by_code.setdefault(taric, {})[area] = duties
    verdict["oorsprong_telt"] = any(
        len({tuple(d) for d in areas.values()}) > 1
        for areas in by_code.values() if len(areas) > 1
    )

    # ---- 6: herhaalbaarheid ---------------------------------------------
    print("\n[3] Tien keer dezelfde vraag (limiet / stabiliteit)")
    tijden, statussen = [], []
    for i in range(10):
        st, dt, html, _ = fetch(best_opener, MEASURES, {
            "Lang": "nl", "LangDescr": "nl", "Taric": CASES[0][0],
            "Area": CASES[0][1], "SimDate": simdate,
        })
        tijden.append(dt)
        statussen.append(st)
        time.sleep(0.4)
    print(f"    statussen: {statussen}")
    print(f"    tijd: min {min(tijden):.1f}s  gem {sum(tijden)/len(tijden):.1f}s  max {max(tijden):.1f}s")
    verdict["stabiel"] = all(s == 200 for s in statussen)

    # ---- oordeel ---------------------------------------------------------
    print("\n" + "=" * 64)
    print("OORDEEL")
    print("=" * 64)
    labels = {
        "bereikbaar":    "measures.jsp geeft bruikbare HTML zonder browser",
        "sessie_nodig":  "er is eerst een sessiecookie nodig",
        "parseerbaar":   "percentages zijn machinaal uit de pagina te halen",
        "oorsprong_telt": "oorsprong geeft aantoonbaar een ander resultaat",
        "stabiel":       "10 opeenvolgende requests blijven 200",
    }
    for k, label in labels.items():
        print(f"  {'JA ' if verdict.get(k) else 'NEE'}  {label}")

    bruikbaar = verdict["bereikbaar"] and verdict["parseerbaar"] and verdict["stabiel"]
    print()
    if bruikbaar:
        print("  => DDS2 is technisch bruikbaar als gratis tariefbron.")
        print("     Bouw er wel een cache omheen (1x per dag per code+oorsprong) en")
        print("     een alarm dat afgaat zodra het parsen niets meer oplevert:")
        print("     dit is HTML zonder contract, dus het breekt een keer.")
    else:
        print("  => DDS2 is zo niet betrouwbaar te automatiseren.")
        print("     Kijk naar de bewaarde HTML in dds2_probe_out/ om te zien waarom,")
        print("     en overweeg de betaalde route of de TARIC-brondata.")

    if verdict["parseerbaar"] and not verdict["oorsprong_telt"]:
        print("\n  Let op: geen verschil tussen oorsprongen gemeten. Of de Area-parameter")
        print("  wordt genegeerd, of de gekozen codes hebben toevallig hetzelfde recht.")
        print("  Controleer meas_3406000000_CN.html handmatig op antidumping.")

    print(f"\n  Ruwe HTML: {OUT}")
    return 0 if bruikbaar else 1


if __name__ == "__main__":
    sys.exit(main())
