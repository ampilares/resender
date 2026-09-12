/**
 * Phone number normalization to E.164 (+<country><subscriber>). Deliberately
 * small: it handles the formats people type into an admin form (spaces, dashes,
 * parentheses, a leading 0 for national numbers, "00" international prefix)
 * without pulling in a full libphonenumber dependency.
 */

const MIN_E164_DIGITS = 7;
const MAX_E164_DIGITS = 15;

/** Normalize a country calling code like "61", "+61", " +61 " -> "+61". Returns null if invalid. */
export function normalizeCountryCode(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length < 1 || digits.length > 3) return null;
  if (digits.startsWith('0')) return null;
  return `+${digits}`;
}

/**
 * Normalize a user-supplied phone number to E.164, or return null when it
 * cannot be interpreted safely.
 *
 *   "0414 511 285"      -> "+61414511285"   (national format, defaultCountryCode "+61")
 *   "+61 414 511 285"   -> "+61414511285"
 *   "0061414511285"     -> "+61414511285"
 *   "61414511285"       -> "+61414511285"   (bare international digits)
 */
export function normalizePhone(raw: string, defaultCountryCode = '+61'): string | null {
  if (typeof raw !== 'string') return null;
  const compact = raw.trim().replace(/[\s\-().]/g, '');
  if (compact.length === 0) return null;

  let international: string | null = null;

  if (compact.startsWith('+')) {
    international = compact.slice(1);
  } else if (compact.startsWith('00')) {
    international = compact.slice(2);
  } else if (compact.startsWith('0')) {
    const cc = normalizeCountryCode(defaultCountryCode);
    if (!cc) return null;
    const national = compact.replace(/^0+/, '');
    if (!/^\d+$/.test(national) || national.length < 6) return null;
    international = `${cc.slice(1)}${national}`;
  } else if (/^\d+$/.test(compact) && compact.length >= 10) {
    international = compact;
  } else {
    return null;
  }

  if (!/^\d+$/.test(international)) return null;
  if (international.length < MIN_E164_DIGITS || international.length > MAX_E164_DIGITS) return null;
  return `+${international}`;
}
