"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const runtimeDir = path.join(os.tmpdir(), `bl-svitlopark-test-${process.pid}`);
process.env.RUNTIME_DIR = runtimeDir;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "-100900";
process.env.TELEGRAM_PUBLIC_CHAT_ID = "-100901";
process.env.TELEGRAM_ADMIN_USER_ID = "456";
process.env.TELEGRAM_ADMIN_USERNAME = "admin_user";
process.env.PUBLIC_SITE_URL = "https://example.com";

const calls = [];
let nextMessageId = 100;
global.fetch = async (url, options = {}) => {
  const method = String(url).split("/").pop();
  const payload = options.body ? JSON.parse(options.body) : {};
  const resultMessageId = ["sendMessage", "sendRichMessage", "copyMessage"].includes(method)
    ? nextMessageId++
    : Number(payload.message_id || 0);
  calls.push({ method, payload, resultMessageId });
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      result: resultMessageId ? { message_id: resultMessageId } : true
    })
  };
};

const { processTelegramUpdate } = require("../server");

test("intake, custom rejection notification, and one-step review edit work end to end", async () => {
  await fs.mkdir(runtimeDir, { recursive: true });
  const user = { id: 123, first_name: "Тест", username: "test_user" };
  const privateChat = { id: 123, type: "private" };

  await messageUpdate(privateChat, user, "/start complaint_380671234567", 1);
  const formMessageId = calls.find((call) => call.method === "sendMessage" && String(call.payload.chat_id) === "123").resultMessageId;
  await messageUpdate(privateChat, user, "Майстер Максим", 2);
  await callbackUpdate(privateChat, user, formMessageId, "intake:skip_username", "skip");
  await messageUpdate(privateChat, user, "Сантехніка", 3);
  await messageUpdate(privateChat, user, "Не завершив роботу в узгоджений строк", 4);
  await callbackUpdate(privateChat, user, formMessageId, "intake:anonymous", "anonymous");
  await callbackUpdate(privateChat, user, formMessageId, "intake:finish", "finish");

  let submissions = await readJsonLines("submissions.jsonl");
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].type, "complaint");
  assert.equal(submissions[0].submitterUserId, "123");
  assert.ok(calls.some((call) => call.method === "editMessageText" && call.payload.message_id === formMessageId));

  const moderationSend = calls.find((call) => call.method === "sendRichMessage" && String(call.payload.chat_id) === "-100900");
  assert.ok(moderationSend);
  const admin = { id: 456, first_name: "Admin", username: "admin_user" };
  const moderationChat = { id: -100900, type: "supergroup" };
  await callbackUpdate(moderationChat, admin, moderationSend.resultMessageId, `reject:${submissions[0].id}`, "reject");
  await callbackUpdate(moderationChat, admin, moderationSend.resultMessageId, `reject_reason:other:${submissions[0].id}`, "other");

  const moderationSessions = await readJsonLines("moderation-sessions.jsonl");
  const customSession = moderationSessions.at(-1).session;
  assert.ok(customSession.promptMessageId);
  await processTelegramUpdate({
    message: {
      message_id: 500,
      chat: moderationChat,
      from: admin,
      text: "Потрібен документ або детальніший опис ситуації.",
      reply_to_message: { message_id: customSession.promptMessageId }
    }
  });

  const events = await readJsonLines("moderation-events.jsonl");
  assert.equal(events.at(-1).status, "rejected");
  assert.equal(events.at(-1).rejectionCode, "custom");
  assert.match(events.at(-1).rejectionReason, /детальніший опис/);
  const notification = calls.findLast((call) => call.method === "sendRichMessage" && String(call.payload.chat_id) === "123");
  assert.ok(notification);
  assert.match(notification.payload.rich_message.html, /Заявку не схвалено/);

  await callbackUpdate(privateChat, user, notification.resultMessageId, `edit_review:${submissions[0].id}`, "edit");
  await messageUpdate(privateChat, user, "Оновлений опис із точними датами та деталями.", 6);
  submissions = await readJsonLines("submissions.jsonl");
  assert.equal(submissions.length, 2);
  assert.equal(submissions[1].replacesSubmissionId, submissions[0].id);
  assert.equal(submissions[1].revisionNumber, 1);

  const revisionModeration = calls.findLast((call) => call.method === "sendRichMessage" && String(call.payload.chat_id) === "-100900");
  await callbackUpdate(moderationChat, admin, revisionModeration.resultMessageId, `approve:${submissions[1].id}`, "approve-revision");
  const finalEvents = await readJsonLines("moderation-events.jsonl");
  assert.equal(finalEvents.at(-2).submissionId, submissions[1].id);
  assert.equal(finalEvents.at(-2).status, "approved");
  assert.equal(finalEvents.at(-1).submissionId, submissions[0].id);
  assert.equal(finalEvents.at(-1).status, "superseded");
  assert.ok(calls.some((call) => call.method === "sendRichMessage" && String(call.payload.chat_id) === "-100901"));

  await fs.rm(runtimeDir, { recursive: true, force: true });
});

async function messageUpdate(chat, from, text, messageId) {
  await processTelegramUpdate({ message: { message_id: messageId, chat, from, text } });
}

async function callbackUpdate(chat, from, messageId, data, id) {
  await processTelegramUpdate({
    callback_query: {
      id,
      from,
      data,
      message: { message_id: messageId, chat }
    }
  });
}

async function readJsonLines(filename) {
  const text = await fs.readFile(path.join(runtimeDir, filename), "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
