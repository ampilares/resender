import assert from 'node:assert/strict';
import test from 'node:test';
import { clampMaxLength, renderSmsTemplate } from './template.js';

const fields = { name: 'Jane Doe', email: 'jane@example.com', Phone: '0414 511 285', message: 'Hi there\nCall me.' };

test('renders form, field and fields placeholders', () => {
  const out = renderSmsTemplate('New {{form}} from {{name}} ({{ email }}) {{phone}}: {{message}}', {
    formName: 'Contact',
    fields,
  });
  assert.equal(out, 'New Contact from Jane Doe (jane@example.com) 0414 511 285: Hi there\nCall me.');

  const all = renderSmsTemplate('{{fields}}', { formName: 'Contact', fields });
  assert.equal(all, 'Name: Jane Doe\nEmail: jane@example.com\nPhone: 0414 511 285\nMessage: Hi there\nCall me.');
});

test('field placeholders are case/underscore insensitive and unknown ones are blank', () => {
  const out = renderSmsTemplate('{{First Name}} {{first_name}} {{FIRSTNAME}} [{{missing}}]', {
    formName: 'f',
    fields: { first_name: 'Ada' },
  });
  assert.equal(out, 'Ada Ada Ada []');
});

test('cleans up whitespace left by empty placeholders and strips control chars', () => {
  const out = renderSmsTemplate('New {{form}} submission from {{name}} {{email}} {{phone}}: {{message}}', {
    formName: 'Quote',
    fields: { name: 'Bob', message: 'Hello world' },
  });
  assert.equal(out, 'New Quote submission from Bob: Hello world');
});

test('truncates to maxLength with an ellipsis', () => {
  const out = renderSmsTemplate('{{message}}', { formName: 'f', fields: { message: 'x'.repeat(100) }, maxLength: 50 });
  assert.equal(out.length, 50);
  assert.ok(out.endsWith('…'));
});

test('clampMaxLength keeps values in range', () => {
  assert.equal(clampMaxLength(10), 40);
  assert.equal(clampMaxLength(5000), 1000);
  assert.equal(clampMaxLength(Number.NaN), 320);
  assert.equal(clampMaxLength(160.9), 160);
});
