/**
 * HS-tool proxy.
 *
 * Waarom deze Worker bestaat:
 *  - De Anthropic-sleutel en het GitHub-token horen niet in een browser op een
 *    openbare GitHub Pages-site. Ze staan hier, server-side, als secret.
 *  - api.anthropic.com staat geen CORS toe, dus een directe fetch uit de pagina
 *    kan sowieso niet.
 *  - Het model bepaalt de CODE, een officiele bron bepaalt het TARIEF. Die
 *    scheiding wordt hier afgedwongen: /api/classify geeft geen percentage terug.
 *
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/landen
 *   POST /api/classify   { omschrijving, oorsprong, materiaal?, gebruik? }
 *   GET  /api/tarief?taric=..&oorsprong=..
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { LANDEN, landnaam, normaliseerLand } from "./landen";
import { dds2Url, haalTarief } from "./tarief";

export interface Env {
  ANTHROPIC_API_KEY: string;
  /** Alleen voor lokaal testen tegen een mock; leeg laten in productie. */
  ANTHROPIC_BASE_URL?: string;
  APP_TOKEN?: string;
  ALLOWED_ORIGINS: string;
  TARIEF_BRON: string;
  TARIEF_CACHE?: KVNamespace;
}

const MODEL = "claude-opus-5";

/**
 * Wat het model teruggeeft. Let op wat er NIET in staat: geen percentage, geen
 * "invoerrechten"-tekst. Dat is met opzet -- zie de moduletoelichting.
 */
const Indeling = z.object({
  taric: z.string().describe("10 cijfers, zonder spaties"),
  hfdst_nr: z.string().describe("2 cijfers"),
  hfdst_label: z.string().describe("Nederlandse omschrijving van het hoofdstuk"),
  post: z.string().describe("Bijv. 'Post 4419: houten keuken- en tafelgerei'"),
  gn_code: z.string().describe("Bijv. 'GN-code 4419 19: overige'"),
  categorie: z.string().describe("Interne productcategorie"),
  confidence: z.number().describe("0-100, hoe zeker de indeling is"),
  redenering: z.string().describe(
    "Waarom deze code: materiaal, functie, en de toegepaste indelingsregel. 2-4 zinnen.",
  ),
  antidump_risico: z.boolean().describe(
    "True als op deze code/oorsprong plausibel een antidumpingrecht rust en dat expliciet nagekeken moet worden",
  ),
  alternatief: z.string().nullable().describe(
    "Serieus te overwegen alternatieve code met reden, of null",
  ),
});

const SYSTEEM = `Je bent een Nederlandse douane-expert die producten indeelt in de
EU-nomenclatuur (GN/TARIC).

Je taak is UITSLUITEND de indeling: bepaal de tiencijferige TARIC-code op basis van
materiaal, functie en gebruik, volgens de algemene indelingsregels.

Geef NOOIT een invoerrechtenpercentage. Dat wordt na jouw antwoord uit de officiele
TARIC-database opgehaald. Een verzonnen percentage belandt op een douaneaangifte, dus
noem geen enkel tarief -- ook niet in je redenering.

Het land van oorsprong krijg je mee omdat het je kan helpen bij de indeling en bij het
inschatten van antidumpingrisico (denk aan kaarsen en keramisch tafelgerei uit China).
Zet antidump_risico op true als dat nagekeken moet worden; bepaal het bedrag niet.

Wees eerlijk over onzekerheid. Een confidence onder de 80 is een normaal antwoord bij
een productomschrijving die te weinig zegt over materiaal of functie -- geef dan in de
redenering aan welke informatie ontbreekt.`;

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const toegestaan = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  const ok = origin && toegestaan.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : toegestaan[0] ?? "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Token",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Origin-allowlist plus een gedeeld token, zodat de sleutel niet gratis te gebruiken is. */
function magDoor(req: Request, env: Env): string | null {
  const origin = req.headers.get("Origin");
  const toegestaan = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  if (origin && !toegestaan.includes(origin)) return "Deze site mag de proxy niet gebruiken.";
  if (env.APP_TOKEN && req.headers.get("X-App-Token") !== env.APP_TOKEN) {
    return "Ongeldig of ontbrekend app-token. Vul het in bij Instellingen.";
  }
  return null;
}

async function classify(req: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ fout: "Ongeldige JSON in de aanvraag." }, 400, cors);
  }

  const omschrijving = String(body.omschrijving ?? "").trim();
  if (omschrijving.length < 3) {
    return json({ fout: "Geef een productomschrijving van minstens 3 tekens." }, 400, cors);
  }
  if (omschrijving.length > 2000) {
    return json({ fout: "Productomschrijving is te lang (max 2000 tekens)." }, 400, cors);
  }

  const oorsprong = normaliseerLand(body.oorsprong);
  if (!oorsprong) {
    return json(
      { fout: "Geef een land van oorsprong op als tweeletterige ISO-code, bijv. CN." },
      400,
      cors,
    );
  }

  const materiaal = String(body.materiaal ?? "").trim().slice(0, 500);
  const gebruik = String(body.gebruik ?? "").trim().slice(0, 500);

  const vraag = [
    `Product: ${omschrijving}`,
    materiaal ? `Materiaal: ${materiaal}` : null,
    gebruik ? `Gebruik: ${gebruik}` : null,
    `Land van oorsprong: ${landnaam(oorsprong)} (${oorsprong})`,
  ]
    .filter(Boolean)
    .join("\n");

  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
  });

  try {
    const respons = await client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEEM,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: vraag }],
      output_config: { format: zodOutputFormat(Indeling) },
    });

    if (respons.stop_reason === "refusal") {
      return json(
        { fout: "Het model heeft deze aanvraag geweigerd. Herformuleer de omschrijving." },
        502,
        cors,
      );
    }

    const indeling = respons.parsed_output;
    if (!indeling) {
      return json({ fout: "Het model gaf geen bruikbare indeling terug." }, 502, cors);
    }

    const taric = indeling.taric.replace(/\D/g, "");
    return json(
      {
        indeling: { ...indeling, taric },
        oorsprong,
        oorsprong_naam: landnaam(oorsprong),
        // De frontend haalt het tarief los op, zodat een trage of kapotte
        // tariefbron de indeling niet tegenhoudt.
        tarief_endpoint: `/api/tarief?taric=${taric}&oorsprong=${oorsprong}`,
        dds2_url: dds2Url(taric, oorsprong, new Date()),
      },
      200,
      cors,
    );
  } catch (e) {
    const bericht = e instanceof Error ? e.message : String(e);
    return json({ fout: `Aanroep naar het model mislukt: ${bericht}` }, 502, cors);
  }
}

async function tarief(url: URL, env: Env, cors: Record<string, string>): Promise<Response> {
  const taric = (url.searchParams.get("taric") ?? "").replace(/\D/g, "");
  if (taric.length < 8 || taric.length > 10) {
    return json({ fout: "Geef een TARIC-code van 8 tot 10 cijfers." }, 400, cors);
  }
  const oorsprong = normaliseerLand(url.searchParams.get("oorsprong"));
  if (!oorsprong) {
    return json({ fout: "Geef een land van oorsprong op, bijv. oorsprong=CN." }, 400, cors);
  }

  const resultaat = await haalTarief(taric, oorsprong, env.TARIEF_BRON, env.TARIEF_CACHE);
  return json({ taric, oorsprong, oorsprong_naam: landnaam(oorsprong), ...resultaat }, 200, cors);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const cors = corsHeaders(req.headers.get("Origin"), env);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname === "/api/health") {
      return json(
        {
          ok: true,
          model: MODEL,
          tarief_bron: env.TARIEF_BRON,
          sleutel_ingesteld: Boolean(env.ANTHROPIC_API_KEY),
          token_vereist: Boolean(env.APP_TOKEN),
        },
        200,
        cors,
      );
    }

    const geweigerd = magDoor(req, env);
    if (geweigerd) return json({ fout: geweigerd }, 403, cors);

    if (url.pathname === "/api/landen") return json({ landen: LANDEN }, 200, cors);
    if (url.pathname === "/api/classify" && req.method === "POST") {
      if (!env.ANTHROPIC_API_KEY) {
        return json(
          { fout: "Geen ANTHROPIC_API_KEY ingesteld. Zet hem met: wrangler secret put ANTHROPIC_API_KEY" },
          503,
          cors,
        );
      }
      return classify(req, env, cors);
    }
    if (url.pathname === "/api/tarief") return tarief(url, env, cors);

    return json({ fout: "Onbekend endpoint." }, 404, cors);
  },
} satisfies ExportedHandler<Env>;
