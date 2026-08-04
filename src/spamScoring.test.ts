import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreSubmission, submissionFingerprint } from './spamScoring.js';

test('ordinary contact messages remain below the default threshold', () => {
  const result = scoreSubmission({
    fields: {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      message: 'Could we arrange a call about the accessibility review next Tuesday?',
    },
    replyTo: 'ada@example.com',
    userAgent: 'Mozilla/5.0',
  });

  assert.equal(result.score, 0);
  assert.deepEqual(result.reasons, []);
});

test('combined promotional language and links produce an explainable spam score', () => {
  const result = scoreSubmission({
    fields: {
      email: 'pitch@example.com',
      message:
        'I came across your website. Our SEO services deliver backlinks and rank your website. ' +
        'See https://bit.ly/offer and https://spam.example/pricing and https://spam.example/results',
    },
    replyTo: 'pitch@example.com',
    userAgent: 'Mozilla/5.0',
  });

  assert.ok(result.score >= 5);
  assert.ok(result.reasons.some((reason) => reason.code === 'spam_phrases'));
  assert.ok(result.reasons.some((reason) => reason.code === 'several_urls'));
  assert.ok(result.reasons.some((reason) => reason.code === 'shortened_url'));
});

test('recent duplicate content from the same IP is a high-confidence signal', () => {
  const result = scoreSubmission({
    fields: { message: 'A superficially normal repeated message.' },
    replyTo: 'person@example.com',
    userAgent: 'Mozilla/5.0',
    history: { duplicateFromIp: true },
  });

  assert.equal(result.score, 5);
  assert.equal(result.reasons[0]?.code, 'duplicate_from_ip');
});

test('fingerprints ignore field order, case, and repeated whitespace', () => {
  const first = submissionFingerprint({ Name: '  ADA   Lovelace ', message: 'Hello THERE' });
  const second = submissionFingerprint({ message: 'hello there', name: 'ada lovelace' });
  assert.equal(first, second);
});
