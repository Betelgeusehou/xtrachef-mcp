// Canonical store names. Vendors spell locations many ways; map them all here.
export const STORES = ['Montrose', 'Washington'];

const PATTERNS = [
  [/montrose/i, 'Montrose'],
  [/washington|wash\b/i, 'Washington'],
  [/endless\s*bummer/i, 'Montrose'], // the Bummer room is inside Montrose
];

// Returns 'Montrose' | 'Washington' | null. Pass any vendor label, address or store name.
export function canonicalStore(label) {
  if (!label) return null;
  if (STORES.includes(label)) return label;
  for (const [re, name] of PATTERNS) if (re.test(String(label))) return name;
  return null;
}
