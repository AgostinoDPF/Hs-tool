/**
 * Landen van oorsprong die in ons inkoopproces voorkomen, plus de EU-lidstaten
 * die we regelmatig zien. ISO 3166-1 alpha-2, want dat is wat TARIC verwacht
 * als `Area`-parameter.
 */
export const LANDEN: Record<string, string> = {
  CN: "China",
  HK: "Hongkong",
  TW: "Taiwan",
  VN: "Vietnam",
  IN: "India",
  BD: "Bangladesh",
  PK: "Pakistan",
  ID: "Indonesië",
  TH: "Thailand",
  MY: "Maleisië",
  TR: "Turkije",
  US: "Verenigde Staten",
  GB: "Verenigd Koninkrijk",
  DE: "Duitsland",
  PL: "Polen",
  CZ: "Tsjechië",
  IT: "Italië",
  ES: "Spanje",
  PT: "Portugal",
  NL: "Nederland",
  BE: "België",
  FR: "Frankrijk",
  UA: "Oekraïne",
  MA: "Marokko",
  TN: "Tunesië",
  EG: "Egypte",
};

/** EU-lidstaten: invoer hiervandaan is geen invoer, dus geen invoerrechten. */
export const EU_LIDSTATEN = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR",
  "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO",
  "SE", "SI", "SK",
]);

/** Geeft de landcode genormaliseerd terug, of null als het geen geldige code is. */
export function normaliseerLand(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

export function landnaam(code: string): string {
  return LANDEN[code] ?? code;
}
