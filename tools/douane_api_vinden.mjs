/**
 * Zoekt uit welke gegevens-aanroep achter tarief.douane.nl zit.
 *
 * De tariefsite is een app die in de browser draait; de tarieven komen uit een
 * aparte aanroep die JSON teruggeeft. Dit script opent de pagina, luistert mee
 * welke aanroepen langskomen, en schrijft ze op. Daarmee kunnen we de tariefkant
 * van de HS-module rechtstreeks op de Douane aansluiten in plaats van een
 * webpagina uit te pluizen.
 *
 * Draaien (op een machine met normale internettoegang):
 *
 *   npm install playwright && npx playwright install chromium
 *   node tools/douane_api_vinden.mjs
 *
 * Een andere goederencode meegeven kan:
 *
 *   node tools/douane_api_vinden.mjs 3406000000
 *
 * Resultaat: een mapje tools/douane_api_uit/ met per aanroep het adres, de
 * koppen en het antwoord. Stuur het bestand OVERZICHT.md door, dan bouw ik de
 * koppeling.
 */

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CODE = process.argv[2] || "6214300090";
const DATUM = new Date().toISOString().slice(0, 10);
const UIT = "tools/douane_api_uit";

const PAGINA =
  `https://tarief.douane.nl/ite-tariff-public/#/taric/measure/mcc/search` +
  `?sd=${DATUM}&d=I&cc=${CODE}&cu=EUR&l=nl`;

/** Zo'n naam is veilig als bestandsnaam en nog te herkennen. */
function bestandsnaam(url, i) {
  const pad = new URL(url).pathname.split("/").filter(Boolean).slice(-3).join("-");
  return `${String(i).padStart(2, "0")}-${pad || "root"}`.replace(/[^a-zA-Z0-9.-]/g, "_");
}

const aanroepen = [];

// Normaal vindt Playwright zijn eigen browser (na `npx playwright install chromium`).
// CHROMIUM_PAD is er voor omgevingen waar hij ergens anders staat.
const browser = await chromium.launch(
  process.env.CHROMIUM_PAD ? { executablePath: process.env.CHROMIUM_PAD } : {},
);
const page = await browser.newPage({ locale: "nl-NL" });

// Alleen gegevens-aanroepen zijn interessant, geen plaatjes of stylesheets.
page.on("response", async (res) => {
  const req = res.request();
  const url = res.url();
  const type = req.resourceType();
  if (type !== "xhr" && type !== "fetch") return;

  const soort = (res.headers()["content-type"] || "").split(";")[0];
  let body = "";
  try {
    body = await res.text();
  } catch {
    body = "(kon antwoord niet lezen)";
  }
  aanroepen.push({
    methode: req.method(),
    url,
    status: res.status(),
    soort,
    koppen: req.headers(),
    postData: req.postData() || null,
    body,
  });
});

console.log("Openen:", PAGINA, "\n");
try {
  await page.goto(PAGINA, { waitUntil: "networkidle", timeout: 90000 });
} catch (e) {
  await browser.close();
  console.error(`\nKon de pagina niet openen: ${e.message}`);
  console.error("Draai dit op een machine met normale internettoegang naar tarief.douane.nl.");
  process.exit(2);
}
// De app haalt soms pas na het renderen de maatregelen op.
await page.waitForTimeout(6000);

// Staat het tarief ook echt op het scherm? Zo ja, dan weten we dat de aanroepen
// die we opvingen de juiste zijn.
const zichtbaar = (await page.locator("body").innerText()).replace(/\s+/g, " ");
const percentages = [...new Set(zichtbaar.match(/\d{1,3}(?:[.,]\d{1,3})?\s*%/g) || [])];

await mkdir(UIT, { recursive: true });

const regels = [];
regels.push(`# Aanroepen achter tarief.douane.nl`);
regels.push(``);
regels.push(`Goederencode: **${CODE}** — datum: ${DATUM}`);
regels.push(`Pagina: ${PAGINA}`);
regels.push(``);
regels.push(`Percentages die op het scherm stonden: ${percentages.join(", ") || "GEEN — de pagina liet niets zien"}`);
regels.push(``);
regels.push(`## Gegevens-aanroepen (${aanroepen.length})`);
regels.push(``);

for (const [i, a] of aanroepen.entries()) {
  const naam = bestandsnaam(a.url, i + 1);
  const isJson = a.soort.includes("json");
  await writeFile(join(UIT, naam + (isJson ? ".json" : ".txt")), a.body);

  // Bevat dit antwoord de cijfers die op het scherm stonden? Dan is dit de bron.
  const raakt = percentages.filter((p) => a.body.includes(p.replace(/\s/g, "")) || a.body.includes(p));
  regels.push(`### ${i + 1}. ${a.methode} ${a.status} ${a.soort}`);
  regels.push("```");
  regels.push(a.url);
  regels.push("```");
  if (a.postData) {
    regels.push(`Verzonden gegevens:`);
    regels.push("```");
    regels.push(a.postData.slice(0, 2000));
    regels.push("```");
  }
  regels.push(`Antwoord: ${a.body.length} tekens, bewaard als \`${naam}${isJson ? ".json" : ".txt"}\``);
  if (raakt.length) regels.push(`**Bevat de tarieven van het scherm: ${raakt.join(", ")} — dit is vermoedelijk de bron.**`);
  const kop = Object.entries(a.koppen)
    .filter(([k]) => !["cookie", "user-agent", "referer"].includes(k.toLowerCase()))
    .map(([k, v]) => `${k}: ${v}`);
  regels.push(`Koppen: ${kop.join(" | ") || "geen bijzondere"}`);
  regels.push(``);
}

if (aanroepen.length === 0) {
  regels.push(`Geen enkele gegevens-aanroep opgevangen. Dan haalt de site zijn data`);
  regels.push(`anders op dan verwacht, of de pagina laadde niet. Kijk in het`);
  regels.push(`scherm-tekstbestand hieronder wat er wel stond.`);
  await writeFile(join(UIT, "schermtekst.txt"), zichtbaar);
}

await writeFile(join(UIT, "OVERZICHT.md"), regels.join("\n"));
await browser.close();

console.log(`${aanroepen.length} gegevens-aanroep(en) gevonden.`);
console.log(`Percentages op het scherm: ${percentages.join(", ") || "geen"}`);
console.log(`\nStuur dit bestand door: ${UIT}/OVERZICHT.md`);
