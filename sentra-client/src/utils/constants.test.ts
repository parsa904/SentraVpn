import test from 'node:test';
import assert from 'node:assert/strict';
import {
  API_BASE_URL,
  DEFAULT_API_BASE_URL,
  DEFAULT_CUSTOM_DNS,
  DEFAULT_TELEGRAM_BOT_USERNAME,
  normalizeBaseUrl,
  normalizeTelegramBotUsername,
} from '../constants';

test('exports canonical Telegram bot handle and API base URL defaults', () => {
  assert.equal(DEFAULT_TELEGRAM_BOT_USERNAME, '@sentraconnect_bot');
  assert.equal(DEFAULT_API_BASE_URL, 'https://sentra-core.kziepr.workers.dev');
  assert.equal(API_BASE_URL, DEFAULT_API_BASE_URL);
  assert.equal(DEFAULT_CUSTOM_DNS, '1.1.1.1');
});

test('normalizeBaseUrl trims whitespace and trailing slashes', () => {
  assert.equal(normalizeBaseUrl(' https://sentra-core.kziepr.workers.dev/// '), 'https://sentra-core.kziepr.workers.dev');
  assert.equal(normalizeBaseUrl(undefined), '');
  assert.equal(normalizeBaseUrl('   '), '');
});

test('normalizeTelegramBotUsername strips leading @ and falls back to official bot handle', () => {
  assert.equal(normalizeTelegramBotUsername(undefined), 'sentraconnect_bot');
  assert.equal(normalizeTelegramBotUsername(''), 'sentraconnect_bot');
  assert.equal(normalizeTelegramBotUsername('@@@'), 'sentraconnect_bot');
  assert.equal(normalizeTelegramBotUsername('@sentraconnect_bot'), 'sentraconnect_bot');
  assert.equal(normalizeTelegramBotUsername('sentraconnect_bot'), 'sentraconnect_bot');
  assert.equal(normalizeTelegramBotUsername(' @custom_bot '), 'custom_bot');
});
