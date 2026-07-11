const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const STATIC_DIR = __dirname;
const RUNTIME_DIR = process.env.RUNTIME_DIR || path.join(__dirname, "runtime");
const SUBMISSIONS_FILE = path.join(RUNTIME_DIR, "submissions.jsonl");
const MODERATION_EVENTS_FILE = path.join(RUNTIME_DIR, "moderation-events.jsonl");
const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || "https://bl-svitlopark.maxicolabs.com";
const PHONES_CSV_URL = process.env.PHONES_CSV_URL || "https://docs.google.com/spreadsheets/d/1nUh-orSW5NA7F0_sCdcNm3folUEhQeZWS72RoD8nvDE/export?format=csv&gid=0";
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const TELEGRAM_ADMIN_USER_ID = String(process.env.TELEGRAM_ADMIN_USER_ID || "");
const TELEGRAM_PUBLIC_CHAT_ID = String(process.env.TELEGRAM_PUBLIC_CHAT_ID || "");
const TELEGRAM_PUBLIC_URL = process.env.TELEGRAM_PUBLIC_URL || "";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

const allowedTypes = new Set(["recommend", "complaint", "add", "bot", "channel"]);
let phoneRecordsCache = { loadedAt: 0, records: [] };
let basePhoneRowsCache = { loadedAt: 0, rows: [] };
const pendingPhotoSubmissionIds = new Map();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, PUBLIC_SITE_URL);

    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, { ok: true, service: "bl-svitlopark" });
    }

    if (url.pathname === "/api/phones") {
      return handlePhonesData(request, response);
    }

    if (url.pathname === "/api/submissions") {
      return handleSubmission(request, response);
    }

    if (url.pathname === "/api/telegram/webhook") {
      return handleTelegramWebhook(request, response);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return sendJson(response, 405, { error: "method_not_allowed" });
    }

    return serveStatic(url.pathname, request, response);
  } catch (error) {
    console.error(error);
    return sendJson(response, 500, { error: "server_error" });
  }
});

server.listen(PORT, () => {
  console.log(`bl-svitlopark listening on :${PORT}`);
});

async function handleSubmission(request, response) {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "method_not_allowed" });
  }

  const payload = await readJsonBody(request);
  const submission = normalizeSubmission(payload);
  const validationError = validateSubmission(submission);

  if (validationError) {
    return sendJson(response, 400, { error: validationError });
  }

  const saved = {
    ...submission,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    status: "new"
  };

  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  await fs.appendFile(SUBMISSIONS_FILE, `${JSON.stringify(saved)}\n`, "utf8");

  const telegramResult = await sendTelegram(saved);

  return sendJson(response, 201, {
    ok: true,
    id: saved.id,
    telegramSent: telegramResult.sent
  });
}

async function handlePhonesData(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return sendJson(response, 405, { error: "method_not_allowed" });
  }

  const rows = await loadPublishedPhoneRows();
  const csv = stringifyCsv(rows);

  response.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Cache-Control": "no-cache"
  });

  if (request.method !== "HEAD") {
    response.end(csv);
  } else {
    response.end();
  }
}

async function handleTelegramWebhook(request, response) {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "method_not_allowed" });
  }

  if (TELEGRAM_WEBHOOK_SECRET) {
    const secret = request.headers["x-telegram-bot-api-secret-token"];
    if (secret !== TELEGRAM_WEBHOOK_SECRET) {
      return sendJson(response, 403, { error: "forbidden" });
    }
  }

  const update = await readJsonBody(request);
  await processTelegramUpdate(update);
  return sendJson(response, 200, { ok: true });
}

async function processTelegramUpdate(update) {
  if (update.callback_query) {
    await processTelegramCallback(update.callback_query);
    return;
  }

  const message = update.message || update.edited_message;
  const chatId = message?.chat?.id;

  if (!chatId) {
    return;
  }

  if (hasTelegramAttachment(message)) {
    const submissionId = pendingPhotoSubmissionIds.get(String(chatId)) || "";
    const relayed = await relayTelegramAttachmentToAdmin(message, submissionId);
    await sendBotMessage(
      chatId,
      relayed
        ? `Фото отримано і передано на модерацію${submissionId ? ` до заявки ${submissionId.slice(0, 8)}` : ""}. Можна надіслати ще фото.`
        : "Фото отримано, але модераційний чат ще не підключений. Надішли, будь ласка, номер або опис текстом.",
      mainMenuKeyboard()
    );
    return;
  }

  const text = clean(message?.text, 1000);

  if (!text) {
    return;
  }

  const [rawCommand, startPayload = ""] = text.split(/\s+/, 2);
  const command = rawCommand.replace(/@\w+$/, "").toLowerCase();

  if (command === "/start" || command === "/help") {
    const photoMatch = startPayload.match(/^photo_([a-f0-9-]{36})$/i);
    if (photoMatch) {
      pendingPhotoSubmissionIds.set(String(chatId), photoMatch[1]);
      await sendBotMessage(chatId, [
        "Фото до заявки",
        "",
        `Заявка: ${photoMatch[1].slice(0, 8)}`,
        "Надішли фото наступним повідомленням. Я привʼяжу його до заявки і передам у групу модерації."
      ].join("\n"), mainMenuKeyboard());
      return;
    }

    await sendBotMessage(chatId, [
      "Black List Світло парк",
      "",
      "Надішли номер телефону майстра, бригади або підрядника.",
      "Я перевірю, чи є по ньому рекомендації або скарги від мешканців ЖК SVITLO PARK.",
      "Фото робіт або скарги можна надіслати сюди окремим повідомленням — я передам їх на модерацію.",
      "",
      "Приклад: +380 67 111 22 33"
    ].join("\n"), mainMenuKeyboard());
    return;
  }

  if (command === "/categories") {
    await sendBotMessage(chatId, "Усі послуги та майстри відкриваються на сайті.", categoriesKeyboard());
    return;
  }

  if (command === "/search") {
    await sendBotMessage(
      chatId,
      "Надішли номер майстра у форматі +380 XX XXX XX XX або 067 XXX XX XX.",
      mainMenuKeyboard()
    );
    return;
  }

  if (command === "/blacklist") {
    await sendBotMessage(chatId, "Останні записи зі скаргами є у розділі Black List.", blacklistKeyboard());
    return;
  }

  if (command === "/channel") {
    await sendBotMessage(chatId, "У публічному каналі виходять перевірені рекомендації та скарги.", publicChannelKeyboard());
    return;
  }

  if (command === "/recommend" || command === "/complaint") {
    const type = command === "/recommend" ? "recommend" : "complaint";
    await sendBotMessage(
      chatId,
      type === "recommend" ? "Відкрий форму рекомендації." : "Відкрий форму скарги.",
      submissionTypeKeyboard(type)
    );
    return;
  }

  const phone = normalizePhone(text);

  if (!/^\+380\d{9}$/.test(phone)) {
    if (shouldRelayFreeformTelegramText(text)) {
      const relayed = await relayTelegramTextToAdmin(message, text);
      await sendBotMessage(
        chatId,
        relayed
          ? "Повідомлення отримано і передано на модерацію. Для швидкої перевірки майстра надішли номер телефону."
          : "Надішли номер у форматі +380 XX XXX XX XX або 067 XXX XX XX.",
        mainMenuKeyboard()
      );
      return;
    }

    await sendBotMessage(
      chatId,
      "Надішли номер у форматі +380 XX XXX XX XX або 067 XXX XX XX.",
      mainMenuKeyboard()
    );
    return;
  }

  const records = await loadPhoneRecords();
  const record = records.find((item) => item.phones.includes(phone));

  if (!record) {
    await sendBotMessage(chatId, [
      "Майстра з таким номером поки немає в базі.",
      "",
      `Перевірений номер: ${formatPhone(phone)}`
    ].join("\n"), notFoundKeyboard(phone));
    return;
  }

  const status = getMasterStatus(record);
  const profileUrl = siteUrl("/profile.html", { phone });

  await sendBotMessage(chatId, [
    "Знайдено майстра",
    "",
    `Імʼя: ${record.displayName}`,
    `Категорія: ${record.categoryName}`,
    `Телефон: ${formatPhone(phone)}`,
    record.telegramUsername ? `Telegram: ${record.telegramUsername}` : "",
    `Рекомендацій: ${record.positive}`,
    `Скарг: ${record.negative}`,
    record.lastReviewAt ? `Останній відгук: ${record.lastReviewAt}` : "",
    `Статус: ${status}`
  ].filter(Boolean).join("\n"), foundKeyboard(phone, profileUrl));
}

async function processTelegramCallback(callback) {
  const callbackId = callback.id;
  const data = clean(callback.data, 100);
  const match = data.match(/^(approve|reject):([a-f0-9-]{36})$/i);
  const userId = String(callback.from?.id || "");
  const chatId = String(callback.message?.chat?.id || "");

  if (!match) {
    await answerTelegramCallback(callbackId, "Невідома дія.");
    return;
  }

  if (!TELEGRAM_ADMIN_USER_ID || userId !== TELEGRAM_ADMIN_USER_ID || chatId !== String(process.env.TELEGRAM_CHAT_ID || "")) {
    await answerTelegramCallback(callbackId, "Ця дія доступна тільки адміністратору.", true);
    return;
  }

  const action = match[1].toLowerCase();
  const submissionId = match[2];
  const submission = await findSubmissionById(submissionId);

  if (!submission) {
    await answerTelegramCallback(callbackId, "Заявку не знайдено.", true);
    return;
  }

  if (action === "approve" && !/^\+380\d{9}$/.test(normalizePhone(submission.phone || submission.rawPhone))) {
    await answerTelegramCallback(callbackId, "Перед додаванням у базу вкажи коректний номер телефону.", true);
    return;
  }

  const currentStatus = await getModerationStatus(submissionId);
  if (currentStatus === "approved" || currentStatus === "rejected") {
    await answerTelegramCallback(
      callbackId,
      currentStatus === "approved" ? "Заявку вже додано до бази." : "Заявку вже відхилено."
    );
    return;
  }

  const status = action === "approve" ? "approved" : "rejected";
  const publicResult = status === "approved"
    ? await publishApprovedSubmission(submission)
    : { sent: false, skipped: true };
  const event = {
    submissionId,
    status,
    reviewedBy: userId,
    reviewedAt: new Date().toISOString(),
    telegramMessageId: callback.message?.message_id || "",
    publicMessageId: publicResult.messageId || ""
  };

  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  await fs.appendFile(MODERATION_EVENTS_FILE, `${JSON.stringify(event)}\n`, "utf8");
  invalidatePhoneCaches();

  const statusLine = status === "approved"
    ? `Статус: додано до бази і вже доступно в пошуку${publicResult.sent ? " та публічному каналі" : ""}.`
    : "Статус: відхилено модератором.";
  const sourceText = clean(callback.message?.text, 3600).replace(/\n\nСтатус:.*$/s, "");

  await telegramRequest("editMessageText", {
    chat_id: callback.message.chat.id,
    message_id: callback.message.message_id,
    text: `${sourceText}\n\n${statusLine}`,
    disable_web_page_preview: true,
    reply_markup: submissionKeyboard(submission, { moderated: true })
  });
  await answerTelegramCallback(
    callbackId,
    status === "approved" ? "Додано до бази." : "Заявку відхилено."
  );
}

async function answerTelegramCallback(callbackId, text, showAlert = false) {
  if (!callbackId) {
    return;
  }

  await telegramRequest("answerCallbackQuery", {
    callback_query_id: callbackId,
    text,
    show_alert: showAlert
  });
}

function normalizeSubmission(payload) {
  return {
    type: clean(payload.type, 40),
    phone: clean(payload.phone, 32),
    rawPhone: clean(payload.rawPhone, 64),
    masterName: clean(payload.masterName, 160),
    category: clean(payload.category, 120),
    telegramUsername: normalizeTelegramUsername(payload.telegramUsername),
    text: clean(payload.text, 2000),
    authorName: clean(payload.authorName, 120) || "Анонімно",
    authorContact: clean(payload.authorContact, 160),
    photoUrl: clean(payload.photoUrl, 500),
    sourceUrl: clean(payload.sourceUrl, 500),
    userAgent: clean(payload.userAgent, 500)
  };
}

function validateSubmission(submission) {
  if (!allowedTypes.has(submission.type)) {
    return "invalid_type";
  }

  if (!submission.phone && !submission.masterName) {
    return "missing_master_identity";
  }

  if (submission.phone && !/^\+380\d{9}$/.test(submission.phone)) {
    return "invalid_phone";
  }

  if (submission.text.length < 8) {
    return "text_too_short";
  }

  return "";
}

async function sendTelegram(submission) {
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!process.env.TELEGRAM_BOT_TOKEN || !chatId) {
    return { sent: false, skipped: true };
  }

  const message = [
    "Black List Світло парк",
    `Тип: ${labelType(submission.type)}`,
    `Телефон: ${submission.phone || submission.rawPhone || "не вказано"}`,
    `Майстер: ${submission.masterName || "не вказано"}`,
    `Категорія: ${submission.category || "не вказано"}`,
    submission.telegramUsername ? `Telegram: ${submission.telegramUsername}` : "",
    `Автор: ${submission.authorName}`,
    `Контакт: ${submission.authorContact || "не вказано"}`,
    submission.photoUrl ? `Фото: ${submission.photoUrl}` : "",
    "",
    submission.text,
    "",
    `ID: ${submission.id}`
  ].filter(Boolean).join("\n");

  const result = await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: message,
    disable_web_page_preview: true,
    reply_markup: submissionKeyboard(submission)
  });

  return { sent: result.ok };
}

async function publishApprovedSubmission(submission) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !TELEGRAM_PUBLIC_CHAT_ID) {
    return { sent: false, skipped: true };
  }

  const phone = normalizePhone(submission.phone || submission.rawPhone);
  const isComplaint = submission.type === "complaint";
  const isRecommendation = submission.type === "recommend";
  const heading = isComplaint
    ? "Користувацька скарга"
    : isRecommendation
      ? "Рекомендація мешканця"
      : "Новий контакт майстра";
  const marker = isComplaint ? "#скарга" : isRecommendation ? "#рекомендація" : "#майстер";
  const message = [
    heading,
    "",
    `Майстер: ${submission.masterName || "імʼя не вказано"}`,
    `Послуги: ${submission.category || "не вказано"}`,
    `Телефон: ${formatPhone(phone)}`,
    submission.telegramUsername ? `Telegram: ${submission.telegramUsername}` : "",
    "",
    submission.text,
    "",
    isComplaint
      ? "Це опис користувацького досвіду, а не встановлений платформою факт порушення."
      : "Запис перевірено модератором перед публікацією.",
    marker
  ].join("\n");
  const profileUrl = siteUrl("/profile.html", { phone });
  const result = await telegramRequest("sendMessage", {
    chat_id: TELEGRAM_PUBLIC_CHAT_ID,
    text: message,
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: "Відкрити профіль", url: profileUrl }],
        [
          { text: "Перевірити інший номер", url: telegramBotUrl() },
          { text: "Відкрити сайт", url: siteUrl("/") }
        ]
      ]
    }
  });

  return {
    sent: result.ok,
    messageId: result.data?.result?.message_id || ""
  };
}

async function sendBotMessage(chatId, text, replyMarkup = null) {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return { sent: false, skipped: true };
  }

  const result = await telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });

  return { sent: result.ok };
}

async function relayTelegramAttachmentToAdmin(message, submissionId = "") {
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!process.env.TELEGRAM_BOT_TOKEN || !chatId) {
    return false;
  }

  const caption = clean(message.caption, 1000);
  const intro = [
    "Фото/файл у Telegram-боті",
    `Від: ${describeTelegramSender(message)}`,
    submissionId ? `Заявка: ${submissionId}` : "Заявка: не привʼязана",
    caption ? `Підпис: ${caption}` : "",
    "",
    "Оригінал нижче скопійовано в цей чат."
  ].filter(Boolean).join("\n");

  await sendBotMessage(chatId, intro);
  const result = await telegramRequest("copyMessage", {
    chat_id: chatId,
    from_chat_id: message.chat.id,
    message_id: message.message_id
  });

  return result.ok;
}

async function relayTelegramTextToAdmin(message, text) {
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!process.env.TELEGRAM_BOT_TOKEN || !chatId) {
    return false;
  }

  const result = await sendBotMessage(chatId, [
    "Повідомлення у Telegram-боті",
    `Від: ${describeTelegramSender(message)}`,
    "",
    text
  ].join("\n"));

  return result.sent;
}

async function telegramRequest(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    return { ok: false, skipped: true };
  }

  try {
    const telegramResponse = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!telegramResponse.ok) {
      const text = await telegramResponse.text();
      console.warn(`Telegram ${method} failed: ${telegramResponse.status} ${text.slice(0, 160)}`);
      return { ok: false };
    }

    const data = await telegramResponse.json().catch(() => ({}));
    return { ok: true, data };
  } catch (error) {
    console.warn(`Telegram ${method} failed: ${error.message}`);
    return { ok: false };
  }
}

function hasTelegramAttachment(message) {
  return Boolean(
    (Array.isArray(message?.photo) && message.photo.length) ||
    (message?.document?.mime_type && message.document.mime_type.startsWith("image/"))
  );
}

function shouldRelayFreeformTelegramText(text) {
  const digits = String(text || "").replace(/\D/g, "");
  return text.length >= 8 && digits.length < 6;
}

function describeTelegramSender(message) {
  const from = message.from || {};
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  const username = from.username ? `@${from.username}` : "";
  const chat = message.chat?.username ? `@${message.chat.username}` : `chat ${message.chat?.id || "невідомий"}`;

  return [name, username, chat].filter(Boolean).join(" · ");
}

function submissionKeyboard(submission, options = {}) {
  const rows = [];

  if (!options.moderated) {
    rows.push([
      { text: "Додати до бази", callback_data: `approve:${submission.id}` },
      { text: "Відхилити", callback_data: `reject:${submission.id}` }
    ]);
  }

  if (submission.phone) {
    rows.push([{ text: "Відкрити профіль", url: siteUrl("/profile.html", { phone: submission.phone }) }]);
  }

  rows.push([
    { text: "Рекомендація", url: siteUrl("/submit.html", { type: "recommend", phone: submission.phone }) },
    { text: "Скарга", url: siteUrl("/submit.html", { type: "complaint", phone: submission.phone }) }
  ]);

  rows.push([{ text: "Відкрити сайт", url: siteUrl("/") }]);

  const botUrl = telegramBotUrl(`photo_${submission.id}`);
  if (botUrl) {
    rows.push([{ text: "Додати фото до заявки", url: botUrl }]);
  }

  return { inline_keyboard: rows };
}

function mainMenuKeyboard() {
  const botUrl = telegramBotUrl("photo");
  const rows = [
    [{ text: "Відкрити сайт", url: siteUrl("/") }],
    [
      { text: "Усі послуги", url: siteUrl("/#service-categories") },
      { text: "Black List", url: siteUrl("/#blacklist") }
    ],
    [
      { text: "Порекомендувати", url: siteUrl("/submit.html", { type: "recommend" }) },
      { text: "Залишити скаргу", url: siteUrl("/submit.html", { type: "complaint" }) }
    ],
    [{ text: "Стати майстром", url: siteUrl("/submit.html", { type: "add" }) }]
  ];

  if (botUrl) {
    rows.push([{ text: "Надіслати фото", url: botUrl }]);
  }

  if (TELEGRAM_PUBLIC_URL) {
    rows.push([{ text: "Публічний канал", url: TELEGRAM_PUBLIC_URL }]);
  }

  return {
    inline_keyboard: rows
  };
}

function categoriesKeyboard() {
  return {
    inline_keyboard: [[{ text: "Відкрити всі послуги", url: siteUrl("/#service-categories") }]]
  };
}

function blacklistKeyboard() {
  return {
    inline_keyboard: [[{ text: "Відкрити Black List", url: siteUrl("/#blacklist") }]]
  };
}

function publicChannelKeyboard() {
  return {
    inline_keyboard: [[{
      text: "Відкрити канал",
      url: TELEGRAM_PUBLIC_URL || siteUrl("/")
    }]]
  };
}

function submissionTypeKeyboard(type) {
  return {
    inline_keyboard: [[{
      text: type === "recommend" ? "Порекомендувати майстра" : "Залишити скаргу",
      url: siteUrl("/submit.html", { type })
    }]]
  };
}

function notFoundKeyboard(phone) {
  return {
    inline_keyboard: [
      [
        { text: "Залишити рекомендацію", url: siteUrl("/submit.html", { type: "recommend", phone }) },
        { text: "Залишити скаргу", url: siteUrl("/submit.html", { type: "complaint", phone }) }
      ],
      [{ text: "Стати майстром", url: siteUrl("/submit.html", { type: "add", phone }) }]
    ]
  };
}

function foundKeyboard(phone, profileUrl) {
  return {
    inline_keyboard: [
      [{ text: "Відкрити профіль", url: profileUrl }],
      [
        { text: "Додати рекомендацію", url: siteUrl("/submit.html", { type: "recommend", phone }) },
        { text: "Залишити скаргу", url: siteUrl("/submit.html", { type: "complaint", phone }) }
      ]
    ]
  };
}

function siteUrl(pathname, params = {}) {
  const url = new URL(pathname, PUBLIC_SITE_URL);

  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      url.searchParams.set(key, value);
    }
  });

  return url.toString();
}

function telegramBotUrl(startPayload = "") {
  const username = clean(process.env.TELEGRAM_BOT_USERNAME, 80).replace(/^@/, "");

  if (!username) {
    return "";
  }

  const url = new URL(`https://t.me/${username}`);
  if (startPayload) {
    url.searchParams.set("start", startPayload);
  }
  return url.toString();
}

async function loadPhoneRecords() {
  const now = Date.now();

  if (phoneRecordsCache.records.length && now - phoneRecordsCache.loadedAt < 60_000) {
    return phoneRecordsCache.records;
  }

  const rows = await loadPublishedPhoneRows();
  const records = rows.map(normalizePhoneRecord).filter((record) => record.phones.length);

  phoneRecordsCache = { loadedAt: now, records };
  return records;
}

async function loadBasePhoneRows() {
  const now = Date.now();

  if (basePhoneRowsCache.rows.length && now - basePhoneRowsCache.loadedAt < 60_000) {
    return basePhoneRowsCache.rows.map((row) => ({ ...row }));
  }

  let csv = "";
  try {
    const response = await fetch(PHONES_CSV_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`sheet_fetch_failed_${response.status}`);
    }
    csv = await response.text();
  } catch (error) {
    console.warn(`Phones sheet fallback: ${error.message}`);
    csv = await fs.readFile(path.join(STATIC_DIR, "data", "phones.csv"), "utf8");
  }

  const rows = parseCsv(csv);
  basePhoneRowsCache = { loadedAt: now, rows };
  return rows.map((row) => ({ ...row }));
}

async function loadPublishedPhoneRows() {
  const rows = await loadBasePhoneRows();
  const [submissions, events] = await Promise.all([
    readJsonLines(SUBMISSIONS_FILE),
    readJsonLines(MODERATION_EVENTS_FILE)
  ]);
  const latestStatus = new Map();

  events.forEach((event) => {
    if (event.submissionId && event.status) {
      latestStatus.set(event.submissionId, event.status);
    }
  });

  submissions
    .filter((submission) => latestStatus.get(submission.id) === "approved")
    .forEach((submission) => applyApprovedSubmission(rows, submission));

  return rows;
}

function applyApprovedSubmission(rows, submission) {
  const phone = normalizePhone(submission.phone || submission.rawPhone);
  if (!/^\+380\d{9}$/.test(phone)) {
    return;
  }

  let row = rows.find((item) => rowPhones(item).includes(phone));
  if (!row) {
    row = createPhoneRow(submission, phone);
    rows.push(row);
  }

  if (!row.display_name && submission.masterName) {
    row.display_name = submission.masterName;
  }

  if (submission.category) {
    const categories = Array.from(new Set([
      ...splitMulti(row.category_names || row.category_name),
      ...splitMulti(submission.category)
    ]));
    row.category_name = row.category_name || categories[0] || "Послуга не вказана";
    row.category_names = categories.join("; ");
  }

  if (!row.telegram_username && submission.telegramUsername) {
    row.telegram_username = submission.telegramUsername;
  }

  if (submission.type !== "recommend" && submission.type !== "complaint") {
    return;
  }

  const reviewType = submission.type === "complaint" ? "complaint" : "recommendation";
  const countField = reviewType === "complaint" ? "negative_reviews_count" : "positive_reviews_count";
  row[countField] = String((Number(row[countField]) || 0) + 1);
  row.last_review_at = String(submission.createdAt || "").slice(0, 10);
  row.last_review_text = submission.text;

  for (let index = 5; index >= 2; index -= 1) {
    ["author", "type", "date", "text", "photo_url"].forEach((field) => {
      row[`review_${index}_${field}`] = row[`review_${index - 1}_${field}`] || "";
    });
  }

  row.review_1_author = "Анонімно";
  row.review_1_type = reviewType;
  row.review_1_date = row.last_review_at;
  row.review_1_text = submission.text;
  row.review_1_photo_url = submission.photoUrl || "";
}

function createPhoneRow(submission, phone) {
  const category = submission.category || "Послуга не вказана";
  return {
    master_id: `submission-${String(submission.id || randomUUID()).slice(0, 8)}`,
    display_name: submission.masterName || `Майстер ${formatPhone(phone)}`,
    category_name: category,
    category_names: category,
    primary_phone: phone,
    phone_numbers: phone,
    telegram_username: submission.telegramUsername || "",
    master_photo_url: "",
    positive_reviews_count: "0",
    negative_reviews_count: "0",
    last_review_at: "",
    last_review_text: "",
    work_photo_url: "",
    work_photo_urls: "",
    profile_url: ""
  };
}

function rowPhones(row) {
  return splitMulti(row.primary_phone || row.phone || row.phone_numbers || row.phones)
    .concat(splitMulti(row.phone_numbers || row.phones))
    .map(normalizePhone)
    .filter((phone, index, list) => /^\+380\d{9}$/.test(phone) && list.indexOf(phone) === index);
}

async function findSubmissionById(submissionId) {
  const submissions = await readJsonLines(SUBMISSIONS_FILE);
  return submissions.find((submission) => submission.id === submissionId) || null;
}

async function getModerationStatus(submissionId) {
  const events = await readJsonLines(MODERATION_EVENTS_FILE);
  return events.reduce((status, event) => (
    event.submissionId === submissionId && event.status ? event.status : status
  ), "");
}

async function readJsonLines(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function invalidatePhoneCaches() {
  phoneRecordsCache = { loadedAt: 0, records: [] };
}

function stringifyCsv(rows) {
  if (!rows.length) {
    return "";
  }

  const headers = [];
  rows.forEach((row) => {
    Object.keys(row).forEach((key) => {
      if (!headers.includes(key)) {
        headers.push(key);
      }
    });
  });

  return [
    headers.map(escapeCsvCell).join(","),
    ...rows.map((row) => headers.map((header) => escapeCsvCell(row[header] || "")).join(","))
  ].join("\n") + "\n";
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function normalizePhoneRecord(row) {
  const phones = splitMulti(row.primary_phone || row.phone || row.phone_numbers || row.phones)
    .concat(splitMulti(row.phone_numbers || row.phones))
    .map(normalizePhone)
    .filter((phone, index, list) => /^\+380\d{9}$/.test(phone) && list.indexOf(phone) === index);

  return {
    phones,
    displayName: row.display_name || row.name || "Не вказано",
    categoryName: row.category_name || row.category_names || row.category || "Не вказано",
    telegramUsername: row.telegram_username || row.telegram || "",
    positive: Number(row.positive_reviews_count || row.recommendations_count || 0) || 0,
    negative: Number(row.negative_reviews_count || row.complaints_count || 0) || 0,
    lastReviewAt: row.last_review_at || "",
    lastReviewText: row.last_review_text || ""
  };
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let value = "";
  let insideQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (char === '"' && insideQuotes && next === '"') {
      value += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      insideQuotes = !insideQuotes;
      continue;
    }

    if (char === "," && !insideQuotes) {
      row.push(value);
      value = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !insideQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(value);
      if (row.some((cell) => cell.trim())) {
        rows.push(row);
      }
      row = [];
      value = "";
      continue;
    }

    value += char;
  }

  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }

  const headers = (rows.shift() || []).map((header) => header.trim());
  return rows.map((cells) => Object.fromEntries(headers.map((header, index) => [header, (cells[index] || "").trim()])));
}

function splitMulti(value) {
  return String(value || "")
    .split(/[;,|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (digits.length === 9) {
    return `+380${digits}`;
  }

  if (digits.length === 10 && digits.startsWith("0")) {
    return `+38${digits}`;
  }

  if (digits.length === 12 && digits.startsWith("380")) {
    return `+${digits}`;
  }

  return `+${digits}`;
}

function normalizeTelegramUsername(value) {
  const match = clean(value, 80).match(/^(?:https?:\/\/t\.me\/)?@?([A-Za-z0-9_]{5,32})$/i);
  return match ? `@${match[1]}` : "";
}

function formatPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");

  if (digits.length !== 12) {
    return phone || "";
  }

  return `+${digits.slice(0, 3)} ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8, 10)} ${digits.slice(10, 12)}`;
}

function getMasterStatus(record) {
  if (record.negative > 0) {
    return "Є скарги";
  }

  if (record.positive > 0) {
    return "Є позитивні відгуки";
  }

  return "Мало інформації";
}

async function serveStatic(pathname, request, response) {
  const filePath = await resolveStaticPath(pathname);

  if (!filePath) {
    return sendText(response, 404, "Not found");
  }

  const extension = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[extension] || "application/octet-stream";
  const content = await fs.readFile(filePath);

  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": [".html", ".js", ".css"].includes(extension)
      ? "no-cache"
      : "public, max-age=3600"
  });

  if (request.method !== "HEAD") {
    response.end(content);
  } else {
    response.end();
  }
}

async function resolveStaticPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const cleanPath = decoded === "/" ? "/index.html" : decoded;
  const directPath = path.resolve(STATIC_DIR, `.${cleanPath}`);

  if (!directPath.startsWith(STATIC_DIR)) {
    return "";
  }

  if (await exists(directPath)) {
    return directPath;
  }

  if (!path.extname(directPath)) {
    const htmlPath = `${directPath}.html`;
    if (htmlPath.startsWith(STATIC_DIR) && await exists(htmlPath)) {
      return htmlPath;
    }
  }

  return "";
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";

    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        request.destroy();
        reject(new Error("body_too_large"));
      }
    });

    request.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (error) {
        reject(new Error("invalid_json"));
      }
    });

    request.on("error", reject);
  });
}

async function exists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (error) {
    return false;
  }
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache"
  });
  response.end(JSON.stringify(body));
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache"
  });
  response.end(text);
}

function clean(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function labelType(type) {
  const labels = {
    recommend: "Рекомендація",
    complaint: "Скарга",
    add: "Стати майстром",
    bot: "Telegram-бот",
    channel: "Telegram-канал"
  };

  return labels[type] || type;
}
