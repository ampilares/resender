import { createHash } from 'node:crypto';

export interface SpamReason {
  code: string;
  points: number;
  detail: string;
}

export interface SpamHistory {
  duplicateFromIp?: boolean;
  duplicateAcrossIps?: boolean;
  recentFromIp?: number;
  recentFromSender?: number;
}

export interface SpamScoreInput {
  fields: Record<string, unknown>;
  replyTo?: string;
  userAgent?: string;
  formStartedAt?: string;
  history?: SpamHistory;
}

export interface SpamScoreResult {
  score: number;
  reasons: SpamReason[];
  fingerprint: string;
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const INVISIBLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u;
const SPAM_PHRASES: Array<[RegExp, string]> = [
  [/\b(?:search engine optimization|seo services?|rank (?:your )?website|first page (?:of )?google)\b/i, 'SEO solicitation'],
  [/\b(?:backlinks?|link building|guest posts?|domain authority)\b/i, 'link-building solicitation'],
  [/\b(?:crypto(?:currency)?|bitcoin|forex|investment opportunity)\b/i, 'financial promotion'],
  [/\b(?:casino|sports betting|online gambling|viagra|cialis)\b/i, 'high-spam commercial phrase'],
  [/\b(?:buy followers?|social media marketing|lead generation services?)\b/i, 'bulk marketing solicitation'],
  [/\b(?:I (?:came across|was checking|visited) your (?:site|website)|increase (?:your )?(?:traffic|sales))\b/i, 'templated outreach'],
];
const SHORTENER_RE = /\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|cutt\.ly|rb\.gy)\//i;
const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com',
  'dispostable.com',
  'guerrillamail.com',
  'maildrop.cc',
  'mailinator.com',
  'sharklasers.com',
  'temp-mail.org',
  'tempmail.com',
  'yopmail.com',
]);

function flattenValues(fields: Record<string, unknown>): string[] {
  return Object.values(fields)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof value))
    .map(String);
}

function addReason(reasons: SpamReason[], code: string, points: number, detail: string): void {
  reasons.push({ code, points, detail });
}

export function submissionFingerprint(fields: Record<string, unknown>): string {
  const normalized = Object.entries(fields)
    .map(([key, value]) => [key.toLowerCase(), value] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${String(value).toLowerCase().replace(/\s+/g, ' ').trim()}`)
    .join('\n');
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Weighted, explainable scoring. Individual weak signals stay below the
 * default threshold; combinations and high-confidence repetition cross it.
 */
export function scoreSubmission(input: SpamScoreInput): SpamScoreResult {
  const reasons: SpamReason[] = [];
  const text = flattenValues(input.fields).join('\n');
  const urls = text.match(URL_RE) ?? [];
  const words = text.match(/\p{L}[\p{L}\p{N}'’-]*/gu) ?? [];

  if (urls.length >= 5) {
    addReason(reasons, 'many_urls', 5, `${urls.length} URLs`);
  } else if (urls.length >= 3) {
    addReason(reasons, 'several_urls', 3, `${urls.length} URLs`);
  } else if (urls.length >= 2) {
    addReason(reasons, 'multiple_urls', 2, `${urls.length} URLs`);
  }

  const urlCharacters = urls.reduce((total, url) => total + url.length, 0);
  if (text.length >= 40 && urlCharacters / text.length > 0.35) {
    addReason(reasons, 'url_heavy', 2, 'More than 35% of the content is URLs');
  }
  if (SHORTENER_RE.test(text)) {
    addReason(reasons, 'shortened_url', 2, 'Contains a URL shortener');
  }
  if (/<\s*(?:a|script|iframe)\b|javascript:/i.test(text)) {
    addReason(reasons, 'active_html', 3, 'Contains link, script, or iframe markup');
  }
  if (INVISIBLE_RE.test(text)) {
    addReason(reasons, 'invisible_characters', 3, 'Contains control or invisible Unicode characters');
  }

  const phraseMatches = SPAM_PHRASES.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  if (phraseMatches.length >= 2) {
    addReason(reasons, 'spam_phrases', 5, phraseMatches.join(', '));
  } else if (phraseMatches.length === 1) {
    addReason(reasons, 'spam_phrase', 3, phraseMatches[0]!);
  }

  const letters = text.match(/\p{L}/gu) ?? [];
  const capitals = text.match(/\p{Lu}/gu) ?? [];
  if (letters.length >= 40 && capitals.length / letters.length > 0.7) {
    addReason(reasons, 'mostly_uppercase', 1, 'More than 70% of letters are uppercase');
  }
  if (/(.)\1{7,}/u.test(text)) {
    addReason(reasons, 'repeated_characters', 1, 'Contains unusually long repeated characters');
  }
  if (words.length >= 20 && new Set(words.map((word) => word.toLowerCase())).size / words.length < 0.3) {
    addReason(reasons, 'low_word_variety', 2, 'Content is highly repetitive');
  }

  if (!input.replyTo) {
    addReason(reasons, 'missing_reply_to', 1, 'No valid reply-to email');
  } else {
    const domain = input.replyTo.split('@')[1]?.toLowerCase();
    if (domain && DISPOSABLE_DOMAINS.has(domain)) {
      addReason(reasons, 'disposable_email', 3, `Disposable email domain: ${domain}`);
    }
  }

  if (!input.userAgent?.trim()) {
    addReason(reasons, 'missing_user_agent', 1, 'No User-Agent header');
  }

  if (input.formStartedAt) {
    const startedAt = Number(input.formStartedAt);
    const elapsed = Date.now() - startedAt;
    if (Number.isFinite(startedAt) && elapsed >= 0 && elapsed < 1_500) {
      addReason(reasons, 'instant_submit', 2, 'Form submitted in under 1.5 seconds');
    } else if (Number.isFinite(startedAt) && elapsed >= 1_500 && elapsed < 3_000) {
      addReason(reasons, 'very_fast_submit', 1, 'Form submitted in under 3 seconds');
    }
  }

  const history = input.history;
  if (history?.duplicateFromIp) {
    addReason(reasons, 'duplicate_from_ip', 5, 'Identical content was recently submitted from this IP');
  } else if (history?.duplicateAcrossIps) {
    addReason(reasons, 'duplicate_across_ips', 3, 'Identical content was recently submitted from another IP');
  }
  if ((history?.recentFromSender ?? 0) >= 3) {
    addReason(reasons, 'sender_burst', 3, `${history!.recentFromSender} recent submissions from this sender`);
  }
  if ((history?.recentFromIp ?? 0) >= 10) {
    addReason(reasons, 'ip_volume', 2, `${history!.recentFromIp} recent submissions from this IP`);
  }

  return {
    score: reasons.reduce((total, reason) => total + reason.points, 0),
    reasons,
    fingerprint: submissionFingerprint(input.fields),
  };
}
