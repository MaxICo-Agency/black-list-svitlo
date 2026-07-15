"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildFoundCard,
  buildModerationCard,
  buildNotFoundCard,
  buildPublicCard,
  escapeTelegramHtml,
  intakePrompt,
  telegramButton
} = require("../telegram-ui");
const {
  isMessageNotModified,
  isRateLimited
} = require("../scripts/refresh-telegram-messages");

const RICH_ONLY_OR_UNSUPPORTED_REGULAR_TAG = /<\/?(?:h[1-6]|p|hr|ul|ol|li|details|summary|footer|cite|table|thead|tbody|tr|th|td|br)\b/i;

test("escapes user-provided Telegram HTML", () => {
  assert.equal(
    escapeTelegramHtml('<script data-x="1">A & B</script>'),
    "&lt;script data-x=&quot;1&quot;&gt;A &amp; B&lt;/script&gt;"
  );
});

test("builds a rich not-found result with a clickable phone fallback", () => {
  const card = buildNotFoundCard({
    phone: "+380 67 123 45 67",
    rawPhone: "+380671234567"
  });

  assert.match(card.richHtml, /<h2>Майстра не знайдено<\/h2>/);
  assert.match(card.richHtml, /href="tel:\+380671234567"/);
  assert.match(card.fallbackHtml, /<b>Майстра не знайдено<\/b>/);
});

test("renders search data without allowing injected rich blocks", () => {
  const card = buildFoundCard({
    name: "Ігор <details open>",
    services: "Сантехніка & ремонт",
    phones: [{ value: "+380 67 123 45 67", href: "tel:+380671234567" }],
    telegramUsername: "@valid_user",
    positive: 4,
    negative: 0,
    lastReviewAt: "2026-07-15",
    status: "✅ Є позитивні відгуки",
    profileUrl: "https://example.com/profile"
  });

  assert.match(card.richHtml, /Ігор &lt;details open&gt;/);
  assert.doesNotMatch(card.richHtml, /<details open>/);
  assert.match(card.richHtml, /telegram\.me\/valid_user/);
});

test("uses native details for moderation and expandable fallback", () => {
  const card = buildModerationCard({
    type: "complaint",
    name: "Майстер",
    services: "Ремонт",
    phones: [{ value: "+380 67 123 45 67", href: "tel:+380671234567" }],
    review: "Проблема <b>не вирішена</b>",
    author: "Анна",
    submittedBy: "Анна · @anna",
    photoCount: 2,
    source: "чат будинку",
    id: "abc12345",
    status: "",
    profileUrl: "https://example.com/profile"
  });

  assert.match(card.richHtml, /<details><summary>Службова інформація<\/summary>/);
  assert.match(card.fallbackHtml, /<blockquote expandable>/);
  assert.doesNotMatch(card.fallbackHtml, RICH_ONLY_OR_UNSUPPORTED_REGULAR_TAG);
  assert.match(card.richHtml, /Проблема &lt;b&gt;не вирішена&lt;\/b&gt;/);
});

test("renders a moderated public complaint with disclaimer", () => {
  const card = buildPublicCard({
    type: "complaint",
    name: "Бригада",
    services: "Оздоблення",
    phones: [],
    review: "Не завершили роботу",
    author: "Анонімно",
    disclaimer: "Це користувацький досвід.",
    source: "Дані з чату будинку."
  });

  assert.match(card.richHtml, /⚠️ Є скарга/);
  assert.match(card.richHtml, /<footer>Це користувацький досвід\.<\/footer>/);
  assert.match(card.richHtml, /<cite>Анонімно<\/cite>/);
  assert.doesNotMatch(card.fallbackHtml, RICH_ONLY_OR_UNSUPPORTED_REGULAR_TAG);
});

test("applies only supported Telegram button styles", () => {
  assert.deepEqual(
    telegramButton("Схвалити", { callback_data: "approve:1" }, "success"),
    { text: "Схвалити", callback_data: "approve:1", style: "success" }
  );
  assert.deepEqual(
    telegramButton("Звичайна", { callback_data: "noop" }, "purple"),
    { text: "Звичайна", callback_data: "noop" }
  );
});

test("regular bot prompts use Telegram-supported HTML only", () => {
  const prompt = intakePrompt(1, "Телефон", "Рядок один\nРядок два", "Підказка");

  assert.match(prompt, /Рядок один\nРядок два/);
  assert.doesNotMatch(prompt, /<br\s*\/?\s*>/i);
});

test("refresh keeps rich messages on Telegram no-op and rate-limit responses", () => {
  assert.equal(isMessageNotModified({ description: "Bad Request: message is not modified" }), true);
  assert.equal(isRateLimited({ description: "Too Many Requests: retry after 40" }), true);
  assert.equal(isRateLimited({ description: "Bad Request: can't parse entities" }), false);
});
