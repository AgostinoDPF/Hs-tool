# HS-tool proxy

Kleine Cloudflare Worker tussen de HS-tool (GitHub Pages) en de buitenwereld.

## Waarom

De tool draaide de AI-aanroep rechtstreeks vanuit de browser. Dat kan niet:
`api.anthropic.com` staat geen CORS toe, en een sleutel in een openbare pagina is
een sleutel die iedereen heeft. Deze Worker houdt de sleutels server-side.

Daarnaast dwingt hij de belangrijkste regel af:

> **Het model bepaalt de code. Een officiële bron bepaalt het tarief.**

`/api/classify` geeft daarom géén percentage terug — dat veld bestaat niet in het
antwoordschema. Het tarief komt uit `/api/tarief`, met vermelding van bron en datum.

## Endpoints

| Endpoint | Wat het doet |
|---|---|
| `GET /api/health` | Draait hij, welk model, welke tariefbron, is de sleutel gezet |
| `GET /api/landen` | Landenlijst voor het oorsprong-keuzemenu |
| `POST /api/classify` | `{omschrijving, oorsprong, materiaal?, gebruik?}` → TARIC-code, hoofdstuk/post/GN, categorie, confidence, redenering, antidumpingrisico |
| `GET /api/tarief?taric=&oorsprong=` | Invoerrecht voor die code + oorsprong, met bron en geldigheidsdatum |

`oorsprong` is verplicht en is een ISO 3166-1 alpha-2 code (`CN`, `PL`, `VN`).
Zonder oorsprong is een tarief niet te bepalen, dus weigert de proxy de aanvraag.

## Tariefbron

De `TARIEF_BRON`-variabele in `wrangler.toml` bepaalt waar het tarief vandaan komt:

- `geen` (standaard) — geeft eerlijk terug dat er nog geen bron is, plus een
  deeplink naar de juiste DDS2-pagina om handmatig te controleren.
- `dds2` — leest de DDS2-pagina van de Europese Commissie uit.

**Zet `dds2` pas aan nadat `tools/dds2_probe.py` heeft aangetoond dat het werkt.**
DDS2 is een webpagina, geen API met een contract: het parsen breekt een keer.
Daarom geeft de code bij een mislukte parse status `fout` en géén getal — liever
geen tarief dan een verkeerd tarief.

Invoer uit een EU-lidstaat wordt zonder bron afgehandeld: vrij verkeer, 0%.

## Opzetten

```bash
cd worker
npm install
npx wrangler secret put ANTHROPIC_API_KEY   # verplicht
npx wrangler secret put APP_TOKEN           # optioneel, zie hieronder
npx wrangler deploy
```

Zet in `wrangler.toml` bij `ALLOWED_ORIGINS` de sites die de proxy mogen
aanroepen. Wil je de KV-cache voor tarieven (aanrader zodra `dds2` aanstaat):

```bash
npx wrangler kv namespace create TARIEF_CACHE
# plak de gegeven binding in wrangler.toml
```

Daarna in de tool: **⚙ Instellingen → Proxy-URL** invullen met het
`https://hs-tool-proxy.<subdomein>.workers.dev`-adres.

### APP_TOKEN

De proxy staat op internet en betaalt per aanroep. `ALLOWED_ORIGINS` houdt andere
websites tegen, maar niet iemand met curl. Zet daarom een `APP_TOKEN` en vul
dezelfde waarde in bij Instellingen. Het is een drempel, geen echte authenticatie —
wie de tool mag gebruiken kan het token uit zijn eigen browser lezen. Voor echte
rollen is een inlog nodig; dat is een aparte stap.

## Testen zonder API-sleutel

`test/mock_anthropic.py` doet zich voor als de Anthropic API, zodat de hele keten
te draaien is zonder te betalen of een sleutel te lekken:

```bash
python3 test/mock_anthropic.py &                      # mock op :8799
npx wrangler dev --port 8788 --local \
  --var ANTHROPIC_API_KEY:test --var ANTHROPIC_BASE_URL:http://127.0.0.1:8799 &
python3 -m http.server 8080 &                         # de tool zelf
npm install --no-save playwright && node test/e2e.mjs
```

`test/e2e.mjs` loopt het echte pad af: oorsprong verplicht, classify, tarief
ophalen, overnemen in het formulier, opslaan, en de detailweergave.
