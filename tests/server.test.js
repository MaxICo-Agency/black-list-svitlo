"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  customRejectionKeyboard,
  isSubmissionOwner,
  mainMenuKeyboard,
  normalizeSubmission,
  rejectionReasonKeyboard,
  submissionDecisionKeyboard
} = require("../server");

const submission = {
  id: "11111111-2222-4333-8444-555555555555",
  type: "recommend",
  phone: "+380671234567",
  masterName: "Максим"
};

test("main bot menu keeps only the primary user journeys", () => {
  const labels = mainMenuKeyboard().inline_keyboard.flat().map((button) => button.text);

  assert.deepEqual(labels, [
    "Відкрити пошук",
    "Порекомендувати",
    "Залишити скаргу",
    "Мої заявки",
    "Звʼязатися з адміністрацією"
  ]);
  assert.doesNotMatch(labels.join(" "), /Стати майстром|послуг|Black List|Публічний канал/i);
});

test("moderation offers a typed reason and an explicit skip", () => {
  const reasonButtons = rejectionReasonKeyboard(submission).inline_keyboard.flat();
  const customButtons = customRejectionKeyboard(submission).inline_keyboard.flat();

  assert.ok(reasonButtons.some((button) => button.text === "Вказати власну причину"));
  assert.ok(customButtons.some((button) => button.text === "Відхилити без пояснення"));
  [...reasonButtons, ...customButtons].forEach((button) => {
    assert.ok(!button.callback_data || Buffer.byteLength(button.callback_data) <= 64);
  });
});

test("submission normalization preserves owner and revision metadata", () => {
  const normalized = normalizeSubmission({
    ...submission,
    phone: "067 123 45 67",
    phoneNumbers: ["067 123 45 67"],
    text: "Дуже добре виконав роботу",
    submitterChatId: "123",
    submitterUserId: "456",
    submitterUsername: "https://telegram.me/example_user",
    replacesSubmissionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    revisionNumber: 2
  });

  assert.equal(normalized.phone, "+380671234567");
  assert.equal(normalized.submitterUserId, "456");
  assert.equal(normalized.submitterUsername, "@example_user");
  assert.equal(normalized.revisionNumber, 2);
});

test("only private bot submissions can be edited by their owner", () => {
  assert.equal(isSubmissionOwner({
    userAgent: "telegram-bot/2.1",
    submitterUserId: "456",
    submitterChatId: "123"
  }, "456", "123"), true);
  assert.equal(isSubmissionOwner({
    userAgent: "svitlopark-approved-import/1.0",
    submitterUserId: "456",
    submitterChatId: "123"
  }, "456", "123"), false);
});

test("spam rejection is the only decision that offers becoming a master", () => {
  const spam = submissionDecisionKeyboard(submission, { status: "rejected", rejectionCode: "spam" });
  const evidence = submissionDecisionKeyboard(submission, { status: "rejected", rejectionCode: "evidence" });
  const spamLabels = spam.inline_keyboard.flat().map((button) => button.text);
  const evidenceLabels = evidence.inline_keyboard.flat().map((button) => button.text);

  assert.ok(spamLabels.includes("Стати майстром"));
  assert.ok(!evidenceLabels.includes("Стати майстром"));
});
