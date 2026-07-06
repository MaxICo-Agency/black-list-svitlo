const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const STATIC_DIR = __dirname;
const RUNTIME_DIR = process.env.RUNTIME_DIR || path.join(__dirname, "runtime");
const SUBMISSIONS_FILE = path.join(RUNTIME_DIR, "submissions.jsonl");
const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || "https://bl-svitlopark.maxicolabs.com";
const PHONES_CSV_URL = process.env.PHONES_CSV_URL || "https://docs.google.com/spreadsheets/d/1nUh-orSW5NA7F0_sCdcNm3folUEhQeZWS72RoD8nvDE/export?format=csv&gid=0";
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

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

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, PUBLIC_SITE_URL);

    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, { ok: true, service: "bl-svitlopark" });
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
  const message = update.message || update.edited_message;
  const chatId = message?.chat?.id;

  if (!chatId) {
    return;
  }

  if (hasTelegramAttachment(message)) {
    const relayed = await relayTelegramAttachmentToAdmin(message);
    await sendBotMessage(
      chatId,
      relayed
        ? "Фото отримано і передано на модерацію. Якщо потрібно, додай ще номер майстра текстом."
        : "Фото отримано, але модераційний чат ще не підключений. Надішли, будь ласка, номер або опис текстом.",
      mainMenuKeyboard()
    );
    return;
  }

  const text = clean(message?.text, 1000);

  if (!text) {
    return;
  }

  if (text.startsWith("/start") || text.startsWith("/help")) {
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

function normalizeSubmission(payload) {
  return {
    type: clean(payload.type, 40),
    phone: clean(payload.phone, 32),
    rawPhone: clean(payload.rawPhone, 64),
    masterName: clean(payload.masterName, 160),
    category: clean(payload.category, 120),
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

async function relayTelegramAttachmentToAdmin(message) {
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!process.env.TELEGRAM_BOT_TOKEN || !chatId) {
    return false;
  }

  const caption = clean(message.caption, 1000);
  const intro = [
    "Фото/файл у Telegram-боті",
    `Від: ${describeTelegramSender(message)}`,
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

function submissionKeyboard(submission) {
  const rows = [];

  if (submission.phone) {
    rows.push([{ text: "Відкрити профіль", url: siteUrl("/profile.html", { phone: submission.phone }) }]);
  }

  rows.push([
    { text: "Рекомендація", url: siteUrl("/submit.html", { type: "recommend", phone: submission.phone }) },
    { text: "Скарга", url: siteUrl("/submit.html", { type: "complaint", phone: submission.phone }) }
  ]);

  rows.push([{ text: "Відкрити сайт", url: siteUrl("/") }]);

  const botUrl = telegramBotUrl("photo");
  if (botUrl) {
    rows.push([{ text: "Фото через бота", url: botUrl }]);
  }

  return { inline_keyboard: rows };
}

function mainMenuKeyboard() {
  const botUrl = telegramBotUrl("photo");
  const rows = [
    [{ text: "Відкрити сайт", url: siteUrl("/") }],
    [
      { text: "Порекомендувати", url: siteUrl("/submit.html", { type: "recommend" }) },
      { text: "Залишити скаргу", url: siteUrl("/submit.html", { type: "complaint" }) }
    ],
    [{ text: "Стати майстром", url: siteUrl("/submit.html", { type: "add" }) }]
  ];

  if (botUrl) {
    rows.push([{ text: "Надіслати фото", url: botUrl }]);
  }

  return {
    inline_keyboard: rows
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

  const response = await fetch(PHONES_CSV_URL, { cache: "no-store" });
  const csv = response.ok ? await response.text() : await fs.readFile(path.join(STATIC_DIR, "data", "phones.csv"), "utf8");
  const records = parseCsv(csv).map(normalizePhoneRecord).filter((record) => record.phones.length);

  phoneRecordsCache = { loadedAt: now, records };
  return records;
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
