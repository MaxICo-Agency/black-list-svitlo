"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const {
  buildChannelIntroCard,
  buildModerationCard,
  buildModerationIntroCard,
  buildPublicCard,
  telegramButton
} = require("../telegram-ui");

const APPLY = process.argv.includes("--apply");
const RUNTIME_DIR = process.env.RUNTIME_DIR || path.join(__dirname, "..", "runtime");
const SITE_URL = process.env.PUBLIC_SITE_URL || "https://bl-svitlopark.maxicolabs.com";
const BOT_USERNAME = String(process.env.TELEGRAM_BOT_USERNAME || "bl_svitlopark_bot").replace(/^@/, "");
const MODERATION_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "");
const PUBLIC_CHAT_ID = String(process.env.TELEGRAM_PUBLIC_CHAT_ID || "");
const PENDING_MESSAGES = parsePendingMessages(process.env.TELEGRAM_PENDING_MESSAGES);

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function main() {
  requireConfig();
  const submissions = await readJsonLines(path.join(RUNTIME_DIR, "submissions.jsonl"));
  const events = await readJsonLines(path.join(RUNTIME_DIR, "moderation-events.jsonl"));
  const submissionsById = new Map(submissions.map((item) => [item.id, item]));
  const latestEvents = new Map();
  const operations = [];

  for (const event of events) {
    latestEvents.set(event.submissionId, event);
  }

  for (const event of latestEvents.values()) {
    const submission = submissionsById.get(event.submissionId);
    if (!submission) {
      continue;
    }

    if (event.telegramMessageId) {
      operations.push({
        name: `moderation:${event.telegramMessageId}`,
        run: () => editRichMessage(
          MODERATION_CHAT_ID,
          event.telegramMessageId,
          buildModerationCard(moderationView(submission, {
            status: event.status,
            rejectionReason: event.rejectionReason,
            publicSent: Boolean(event.publicMessageId)
          })),
          moderationKeyboard(submission, true)
        )
      });
    }

    if (event.status === "approved" && event.publicMessageId) {
      operations.push({
        name: `public:${event.publicMessageId}`,
        run: () => editRichMessage(
          PUBLIC_CHAT_ID,
          event.publicMessageId,
          buildPublicCard(publicView(submission)),
          publicPostKeyboard()
        )
      });
    }
  }

  for (const submission of submissions) {
    if (latestEvents.has(submission.id) || !PENDING_MESSAGES[submission.id]) {
      continue;
    }
    const messageId = PENDING_MESSAGES[submission.id];
    operations.push({
      name: `pending:${messageId}`,
      run: () => editRichMessage(
        MODERATION_CHAT_ID,
        messageId,
        buildModerationCard(moderationView(submission)),
        moderationKeyboard(submission, false)
      )
    });
  }

  const [publicChat, moderationChat] = await Promise.all([
    telegramRequest("getChat", { chat_id: PUBLIC_CHAT_ID }),
    telegramRequest("getChat", { chat_id: MODERATION_CHAT_ID })
  ]);
  const publicPinnedId = publicChat.result?.pinned_message?.message_id;
  const moderationPinnedId = moderationChat.result?.pinned_message?.message_id;

  if (publicPinnedId) {
    operations.push({
      name: `public-pinned:${publicPinnedId}`,
      run: () => editRichMessage(
        PUBLIC_CHAT_ID,
        publicPinnedId,
        buildChannelIntroCard({
          botUrl: botUrl(),
          recommendationsUrl: siteUrl("/recommendations"),
          complaintsUrl: siteUrl("/complaints")
        }),
        channelIntroKeyboard()
      )
    });
  }

  if (moderationPinnedId) {
    operations.push({
      name: `moderation-pinned:${moderationPinnedId}`,
      run: () => editRichMessage(
        MODERATION_CHAT_ID,
        moderationPinnedId,
        buildModerationIntroCard({ siteUrl: siteUrl("/") }),
        { inline_keyboard: [[telegramButton("Відкрити сайт", { url: siteUrl("/") }, "primary")]] }
      )
    });
  }

  if (!APPLY) {
    console.log(JSON.stringify({ mode: "dry-run", operations: operations.map((item) => item.name) }, null, 2));
    return;
  }

  const results = [];
  for (const operation of operations) {
    const result = await operation.run();
    results.push({ name: operation.name, ...result });
  }
  console.log(JSON.stringify({ mode: "apply", results }, null, 2));
}

function requireConfig() {
  if (!process.env.TELEGRAM_BOT_TOKEN || !MODERATION_CHAT_ID || !PUBLIC_CHAT_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and TELEGRAM_PUBLIC_CHAT_ID are required");
  }
}

function parsePendingMessages(value) {
  try {
    return JSON.parse(value || "{}");
  } catch (error) {
    throw new Error("TELEGRAM_PENDING_MESSAGES must be a JSON object");
  }
}

async function readJsonLines(filePath) {
  const content = await fs.readFile(filePath, "utf8").catch(() => "");
  return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("0")) {
    return `+38${digits}`;
  }
  if (digits.length === 12 && digits.startsWith("380")) {
    return `+${digits}`;
  }
  return digits ? `+${digits}` : "";
}

function formatPhone(value) {
  const phone = normalizePhone(value);
  const match = phone.match(/^\+380(\d{2})(\d{3})(\d{2})(\d{2})$/);
  return match ? `+380 ${match[1]} ${match[2]} ${match[3]} ${match[4]}` : phone;
}

function submissionPhones(submission) {
  const values = [submission.phone, submission.rawPhone, ...(submission.phoneNumbers || [])]
    .map(normalizePhone)
    .filter((phone) => /^\+380\d{9}$/.test(phone));
  return Array.from(new Set(values));
}

function phoneView(submission) {
  return submissionPhones(submission).map((phone) => ({ value: formatPhone(phone), href: `tel:${phone}` }));
}

function moderationView(submission, state = {}) {
  const phone = submissionPhones(submission)[0] || "";
  return {
    type: submission.type,
    name: submission.masterName,
    services: submission.category,
    phones: phoneView(submission),
    telegramUsername: submission.telegramUsername,
    author: submission.authorName,
    submittedBy: submission.authorContact,
    photoCount: (submission.photoFileIds || []).length || (submission.photoUrl ? 1 : 0),
    source: String(submission.sourceNote || "").replace(/^\*\s*/, ""),
    review: submission.text,
    id: submission.id.slice(0, 8),
    profileUrl: phone ? siteUrl("/profile", { phone }) : "",
    ...state
  };
}

function publicView(submission) {
  const phone = submissionPhones(submission)[0] || "";
  const complaint = submission.type === "complaint";
  const source = submission.sourceNote || (submission.userAgent === "svitlopark-approved-import/1.0"
    ? "Дані витягнуто автоматизовано з чату будинку."
    : "");
  return {
    type: submission.type,
    name: submission.masterName,
    services: submission.category,
    phones: phoneView(submission),
    telegramUsername: submission.telegramUsername,
    review: submission.text,
    author: submission.authorName,
    profileUrl: phone ? siteUrl("/profile", { phone }) : "",
    disclaimer: complaint
      ? "Це опис користувацького досвіду, а не встановлений платформою факт порушення."
      : "Запис перевірено модератором перед публікацією.",
    source: String(source).replace(/^\*\s*/, "")
  };
}

function moderationKeyboard(submission, moderated) {
  const rows = [];
  if (!moderated) {
    rows.push([
      telegramButton("Додати до бази", { callback_data: `approve:${submission.id}` }, "success"),
      telegramButton("Відхилити", { callback_data: `reject:${submission.id}` }, "danger")
    ]);
  }
  const phone = submissionPhones(submission)[0];
  if (phone) {
    rows.push([telegramButton("Відкрити профіль", { url: siteUrl("/profile", { phone }) }, "primary")]);
  }
  return { inline_keyboard: rows };
}

function publicPostKeyboard() {
  return {
    inline_keyboard: [[telegramButton("Перевірити інший номер", { url: botUrl() }, "primary")]]
  };
}

function channelIntroKeyboard() {
  return {
    inline_keyboard: [
      [telegramButton("Перевірити номер", { url: botUrl() }, "primary")],
      [
        telegramButton("Рекомендації", { url: siteUrl("/recommendations") }, "success"),
        telegramButton("Black List", { url: siteUrl("/complaints") }, "danger")
      ]
    ]
  };
}

function siteUrl(pathname, params = {}) {
  const url = new URL(pathname, SITE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function botUrl() {
  return `https://telegram.me/${BOT_USERNAME}`;
}

async function editRichMessage(chatId, messageId, card, replyMarkup) {
  const rich = await telegramRequest("editMessageText", {
    chat_id: chatId,
    message_id: Number(messageId),
    rich_message: { html: card.richHtml },
    reply_markup: replyMarkup
  });
  if (rich.ok || isMessageNotModified(rich)) {
    return { ok: true, mode: "rich", unchanged: !rich.ok };
  }
  if (isRateLimited(rich)) {
    return { ok: false, mode: "rich", error: rich.description };
  }

  const fallback = await telegramRequest("editMessageText", {
    chat_id: chatId,
    message_id: Number(messageId),
    text: card.fallbackHtml,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: replyMarkup
  });
  const fallbackOk = fallback.ok || isMessageNotModified(fallback);
  return {
    ok: fallbackOk,
    mode: "regular",
    unchanged: !fallback.ok && fallbackOk,
    error: fallbackOk ? "" : fallback.description || rich.description || ""
  };
}

function isMessageNotModified(result) {
  return /message is not modified/i.test(result?.description || "");
}

function isRateLimited(result) {
  return /too many requests|retry after/i.test(result?.description || "");
}

async function telegramRequest(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok && data.ok, result: data.result, description: data.description || "" };
}

module.exports = { isMessageNotModified, isRateLimited };
