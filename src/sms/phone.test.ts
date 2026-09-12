import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCountryCode, normalizePhone } from './phone.js';

test('normalizePhone handles Australian national and international formats', () => {
  assert.equal(normalizePhone('0414 511 285'), '+61414511285');
  assert.equal(normalizePhone('0414-511-285', '+61'), '+61414511285');
  assert.equal(normalizePhone('(04) 1451 1285'), '+61414511285');
  assert.equal(normalizePhone('+61 414 511 285'), '+61414511285');
  assert.equal(normalizePhone('0061414511285'), '+61414511285');
  assert.equal(normalizePhone('61414511285'), '+61414511285');
});

test('normalizePhone respects the default country code', () => {
  assert.equal(normalizePhone('07911 123456', '+44'), '+447911123456');
  assert.equal(normalizePhone('07911 123456', '44'), '+447911123456');
  assert.equal(normalizePhone('0912345678', '+251'), '+251912345678');
});

test('normalizePhone rejects garbage', () => {
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone('   '), null);
  assert.equal(normalizePhone('abc'), null);
  assert.equal(normalizePhone('+61 4x4'), null);
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('+1234567890123456'), null);
  assert.equal(normalizePhone('0414511285', 'bogus'), null);
});

test('normalizeCountryCode', () => {
  assert.equal(normalizeCountryCode('61'), '+61');
  assert.equal(normalizeCountryCode(' +61 '), '+61');
  assert.equal(normalizeCountryCode('1'), '+1');
  assert.equal(normalizeCountryCode('+0'), null);
  assert.equal(normalizeCountryCode('1234'), null);
  assert.equal(normalizeCountryCode(''), null);
});
