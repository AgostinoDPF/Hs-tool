/**
 * Tariefbron: het invoerrecht dat hoort bij een TARIC-code + land van oorsprong
 * op een bepaalde datum.
 *
 * Belangrijk: het model bepaalt de CODE, deze module bepaalt het TARIEF. Een
 * percentage dat uit een taalmodel komt gaat nooit naar de gebruiker toe --
 * daar hangt een douaneaangifte aan.
 *
 * Zolang niet is aangetoond dat DDS2 betrouwbaar machinaal uit te lezen is
 * (zie tools/dds2_probe.py) staat TARIEF_BRON op "geen" en geeft deze module
 * eerlijk terug dat het tarief nog handmatig gecontroleerd moet worden, met een
 * directe link naar de juiste DDS2-pagina.
 */

import { EU_LIDSTATEN } from "./landen";

export type TariefStatus = "gevonden" | "handmatig" | "eu_intern" | "fout";

export interface TariefResultaat {
  status: TariefStatus;
  /** Bijv. "4,7%". Alleen gevuld bij status "gevonden" of "eu_intern". */
  percentage: string | null;
  /** Alle op de pagina gevonden maatregelen, ruw, voor menselijke controle. */
  maatregelen: string[];
  /** Waar het vandaan komt: "DDS2", "regelgeving EU-intern", of null. */
  bron: string | null;
  /** Wanneer opgehaald (ISO), zodat de gebruiker de versheid ziet. */
  opgehaald_op: string | null;
  /** Referentiedatum waarvoor het tarief geldt (YYYY-MM-DD). */
  geldig_op: string;
  /** Deeplink naar DDS2 voor deze code + oorsprong: altijd gevuld. */
  dds2_url: string;
  /** Toelichting voor de gebruiker, in het Nederlands. */
  toelichting: string;
}

const DDS2_MEASURES = "https://ec.europa.eu/taxation_customs/dds2/taric/measures.jsp";

/** Percentages zoals DDS2 ze toont: "4,7 %", "0.0 %", "70,90%". */
const PERCENTAGE_RE = /\b\d{1,3}(?:[.,]\d{1,3})?\s*%/g;

export function dds2Url(taric: string, oorsprong: string, datum: Date): string {
  const p = new URLSearchParams({
    Lang: "nl",
    LangDescr: "nl",
    Taric: taric,
    Area: oorsprong,
    SimDate: simDate(datum),
    Expand: "true",
  });
  return `${DDS2_MEASURES}?${p}`;
}

function simDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/**
 * Haalt het tarief op. `bron` komt uit env.TARIEF_BRON.
 *
 * @param cache Optionele Cloudflare KV-namespace. Zonder cache werkt alles nog,
 *              alleen wordt DDS2 dan bij elke vraag opnieuw belast.
 */
export async function haalTarief(
  taric: string,
  oorsprong: string,
  bron: string,
  cache?: KVNamespace,
): Promise<TariefResultaat> {
  const nu = new Date();
  const geldig_op = nu.toISOString().slice(0, 10);
  const url = dds2Url(taric, oorsprong, nu);

  const basis: TariefResultaat = {
    status: "handmatig",
    percentage: null,
    maatregelen: [],
    bron: null,
    opgehaald_op: null,
    geldig_op,
    dds2_url: url,
    toelichting: "",
  };

  // Invoer binnen de EU is geen invoer: geen rechten, geen bron nodig.
  if (EU_LIDSTATEN.has(oorsprong)) {
    return {
      ...basis,
      status: "eu_intern",
      percentage: "0%",
      bron: "regelgeving EU-intern",
      opgehaald_op: nu.toISOString(),
      toelichting:
        "Oorsprong is een EU-lidstaat: vrij verkeer, geen invoerrechten. " +
        "Let op dat oorsprong iets anders is dan land van verzending.",
    };
  }

  if (bron !== "dds2") {
    return {
      ...basis,
      toelichting:
        "Er is nog geen geautomatiseerde tariefbron aangesloten. Controleer het " +
        "tarief in DDS2 via de link hiernaast en neem het percentage handmatig over.",
    };
  }

  const cacheKey = `tarief:${taric}:${oorsprong}:${geldig_op}`;
  if (cache) {
    const bewaard = await cache.get(cacheKey, "json");
    if (bewaard) return bewaard as TariefResultaat;
  }

  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "hs-tool/1.0 (interne tariefcheck)",
        "Accept-Language": "nl",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`DDS2 gaf status ${r.status}`);

    const tekst = stripHtml(await r.text());
    const maatregelen = [...new Set(tekst.match(PERCENTAGE_RE) ?? [])]
      .map((m) => m.replace(/\s+/g, ""));

    if (maatregelen.length === 0) {
      // Geparsed maar niets gevonden: dan is het parsen kapot of de code bestaat
      // niet. In beide gevallen mag er geen getal in beeld komen.
      return {
        ...basis,
        status: "fout",
        toelichting:
          "DDS2 gaf een pagina terug waar geen tarief uit te halen was. Controleer " +
          "de code handmatig via de link -- mogelijk is de opmaak van DDS2 gewijzigd.",
      };
    }

    const resultaat: TariefResultaat = {
      ...basis,
      status: "gevonden",
      percentage: maatregelen[0],
      maatregelen,
      bron: "DDS2",
      opgehaald_op: nu.toISOString(),
      toelichting:
        maatregelen.length > 1
          ? `DDS2 toont meerdere maatregelen (${maatregelen.join(", ")}). Het eerste ` +
            "percentage is overgenomen; controleer of er een antidumpingrecht of " +
            "preferentieel tarief tussen zit dat op deze zending van toepassing is."
          : "Overgenomen uit DDS2.",
    };

    if (cache) {
      // Een dag houdbaar: TARIC wijzigt dagelijks, vaker ophalen heeft geen zin.
      await cache.put(cacheKey, JSON.stringify(resultaat), { expirationTtl: 86400 });
    }
    return resultaat;
  } catch (e) {
    return {
      ...basis,
      status: "fout",
      toelichting:
        `Tarief kon niet worden opgehaald (${e instanceof Error ? e.message : e}). ` +
        "Controleer handmatig via de link.",
    };
  }
}
