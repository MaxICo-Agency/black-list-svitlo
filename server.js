const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const STATIC_DIR = __dirname;
const RUNTIME_DIR = process.env.RUNTIME_DIR || path.join(__dirname, "runtime");
const SUBMISSIONS_FILE = path.join(RUNTIME_DIR, "submissions.jsonl");
const MODERATION_EVENTS_FILE = path.join(RUNTIME_DIR, "moderation-events.jsonl");
const BOT_SESSIONS_FILE = path.join(RUNTIME_DIR, "bot-sessions.jsonl");
const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || "https://bl-svitlopark.maxicolabs.com";
const PHONES_CSV_URL = String(process.env.PHONES_CSV_URL || "").trim();
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const TELEGRAM_ADMIN_USER_ID = String(process.env.TELEGRAM_ADMIN_USER_ID || "");
const TELEGRAM_PUBLIC_CHAT_ID = String(process.env.TELEGRAM_PUBLIC_CHAT_ID || "");
const TELEGRAM_PUBLIC_URL = process.env.TELEGRAM_PUBLIC_URL || "";
const TELEGRAM_MODERATION_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "");
const TELEGRAM_BOT_USERNAME = clean(process.env.TELEGRAM_BOT_USERNAME || "bl_svitlopark_bot", 80).replace(/^@/, "");

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

const legacyRouteRedirects = new Map([
  ["/index.html", "/"],
  ["/profile.html", "/profile"],
  ["/category.html", "/services"],
  ["/submit.html", "/submit"],
  ["/rules.html", "/rules"],
  ["/privacy.html", "/privacy"],
  ["/directory.html", "/recommendations"]
]);

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, PUBLIC_SITE_URL);

    if (request.method === "GET" && ["/health", "/api/health"].includes(url.pathname)) {
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

    if (request.method === "GET" && url.pathname.startsWith("/api/media/")) {
      return handleTelegramMedia(url.pathname, response);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return sendJson(response, 405, { error: "method_not_allowed" });
    }

    if (legacyRouteRedirects.has(url.pathname)) {
      const target = new URL(legacyRouteRedirects.get(url.pathname), PUBLIC_SITE_URL);
      target.search = url.search;
      response.writeHead(301, { Location: `${target.pathname}${target.search}` });
      response.end();
      return;
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

  return sendJson(response, 410, {
    error: "telegram_only",
    message: "Заявки приймаються у Telegram-боті.",
    telegramUrl: telegramBotUrl("recommend")
  });
}

async function saveSubmission(payload) {
  const submission = normalizeSubmission(payload);
  const validationError = validateSubmission(submission);

  if (validationError) {
    throw new Error(validationError);
  }

  const saved = {
    ...submission,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    status: "new"
  };

  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  await fs.appendFile(SUBMISSIONS_FILE, `${JSON.stringify(saved)}\n`, "utf8");
  return saved;
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

async function handleTelegramMedia(pathname, response) {
  const match = pathname.match(/^\/api\/media\/([a-f0-9-]{36})\/(\d+)$/i);
  if (!match || !process.env.TELEGRAM_BOT_TOKEN) {
    return sendText(response, 404, "Not found");
  }

  const submission = await findSubmissionById(match[1]);
  const status = await getModerationStatus(match[1]);
  const index = Number(match[2]);
  const fileId = submission?.photoFileIds?.[index];

  if (!submission || status !== "approved" || !fileId) {
    return sendText(response, 404, "Not found");
  }

  const fileResult = await telegramRequest("getFile", { file_id: fileId });
  const filePath = fileResult.data?.result?.file_path;
  if (!fileResult.ok || !filePath) {
    return sendText(response, 502, "Media unavailable");
  }

  const mediaResponse = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!mediaResponse.ok) {
    return sendText(response, 502, "Media unavailable");
  }

  const content = Buffer.from(await mediaResponse.arrayBuffer());
  const contentType = submission.photoMimeTypes?.[index]
    || mediaResponse.headers.get("content-type")
    || "image/jpeg";
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": content.length,
    "Cache-Control": "public, max-age=86400"
  });
  response.end(content);
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
  const chatId = String(message?.chat?.id || "");

  if (!chatId) {
    return;
  }

  const text = clean(message?.text, 2000);
  const session = await getBotSession(chatId);

  const [rawCommand = "", startPayload = ""] = text.split(/\s+/, 2);
  const command = rawCommand.replace(/@\w+$/, "").toLowerCase();

  if (command === "/cancel") {
    await clearBotSession(chatId);
    await sendBotMessage(chatId, "Заявку скасовано.", mainMenuKeyboard());
    return;
  }

  if (command === "/start") {
    const intakePayload = parseIntakeStartPayload(startPayload);
    if (intakePayload) {
      await beginBotIntake(message, intakePayload.type, intakePayload.phone);
      return;
    }

    await clearBotSession(chatId);
    await sendBotWelcome(chatId);
    return;
  }

  if (command === "/help") {
    await sendBotWelcome(chatId);
    return;
  }

  if (command === "/recommend" || command === "/complaint" || command === "/add") {
    const type = command.slice(1);
    await beginBotIntake(message, type);
    return;
  }

  if (session) {
    await processBotIntakeMessage(message, session);
    return;
  }

  if (hasTelegramAttachment(message)) {
    await sendBotMessage(
      chatId,
      "Спочатку обери тип заявки. Фото додаються всередині рекомендації, скарги або анкети майстра.",
      mainMenuKeyboard()
    );
    return;
  }

  if (!text) {
    return;
  }

  if (command === "/categories") {
    await sendBotMessage(chatId, "Послуги формуються з анкет і схвалених відгуків мешканців.", categoriesKeyboard());
    return;
  }

  if (command === "/search") {
    await sendBotMessage(chatId, "Надішли номер майстра у форматі +380 XX XXX XX XX або 067 XXX XX XX.", mainMenuKeyboard());
    return;
  }

  if (command === "/blacklist") {
    await sendBotMessage(chatId, "Відкрий список схвалених скарг.", blacklistKeyboard());
    return;
  }

  if (command === "/channel") {
    await sendBotMessage(chatId, "У каналі публікуються тільки записи після модерації.", publicChannelKeyboard());
    return;
  }

  const phone = normalizePhone(text);

  if (!/^\+380\d{9}$/.test(phone)) {
    await sendBotMessage(
      chatId,
      "Не бачу коректного номера. Надішли +380 XX XXX XX XX або обери дію нижче.",
      mainMenuKeyboard()
    );
    return;
  }

  const records = await loadPhoneRecords();
  const record = records.find((item) => item.phones.includes(phone));

  if (!record) {
    await sendBotMessage(chatId, [
      "НІЧОГО НЕ ЗНАЙДЕНО",
      "",
      "Майстра з таким номером поки немає в базі.",
      `Перевірений номер: ${formatPhone(phone)}`
    ].join("\n"), notFoundKeyboard(phone));
    return;
  }

  const status = getMasterStatus(record);
  const profileUrl = siteUrl("/profile", { phone });

  await sendBotMessage(chatId, [
    "ЗНАЙДЕНО МАЙСТРА",
    "",
    `Імʼя: ${record.displayName}`,
    `Послуги: ${record.categoryName}`,
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
  const callbackMessage = {
    chat: callback.message?.chat,
    from: callback.from
  };

  const intakeStart = data.match(/^start:(recommend|complaint|add)(?::(\d{9,12}))?$/);
  if (intakeStart) {
    await beginBotIntake(callbackMessage, intakeStart[1], intakeStart[2] || "");
    await answerTelegramCallback(callbackId, "Починаємо.");
    return;
  }

  if (data.startsWith("intake:")) {
    await processBotIntakeCallback(callback, data);
    return;
  }

  const match = data.match(/^(approve|reject|reject_back):([a-f0-9-]{36})$/i);
  const reasonMatch = data.match(/^reject_reason:([a-z_]+):([a-f0-9-]{36})$/i);
  const userId = String(callback.from?.id || "");
  const chatId = String(callback.message?.chat?.id || "");

  if (!match && !reasonMatch) {
    await answerTelegramCallback(callbackId, "Невідома дія.");
    return;
  }

  if (!TELEGRAM_ADMIN_USER_ID || userId !== TELEGRAM_ADMIN_USER_ID || chatId !== TELEGRAM_MODERATION_CHAT_ID) {
    await answerTelegramCallback(callbackId, "Ця дія доступна тільки адміністратору.", true);
    return;
  }

  const action = reasonMatch ? "reject_reason" : match[1].toLowerCase();
  const submissionId = reasonMatch ? reasonMatch[2] : match[2];
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

  if (action === "reject") {
    await telegramRequest("editMessageReplyMarkup", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      reply_markup: rejectionReasonKeyboard(submission)
    });
    await answerTelegramCallback(callbackId, "Оберіть причину відхилення.");
    return;
  }

  if (action === "reject_back") {
    await telegramRequest("editMessageReplyMarkup", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      reply_markup: submissionKeyboard(submission)
    });
    await answerTelegramCallback(callbackId, "Повернув кнопки модерації.");
    return;
  }

  const rejectionReason = reasonMatch ? rejectionReasonLabel(reasonMatch[1]) : "";
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
    publicMessageId: publicResult.messageId || "",
    rejectionReason
  };

  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  await fs.appendFile(MODERATION_EVENTS_FILE, `${JSON.stringify(event)}\n`, "utf8");
  invalidatePhoneCaches();

  const statusLine = status === "approved"
    ? `Статус: додано до бази і вже доступно в пошуку${publicResult.sent ? " та публічному каналі" : ""}.`
    : `Статус: відхилено.\nПричина: ${rejectionReason || "не вказана"}.`;
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

async function sendBotWelcome(chatId) {
  await sendBotMessage(chatId, [
    "BLACK LIST СВІТЛО ПАРК",
    "",
    "Надішли номер телефону майстра, бригади або підрядника — я перевірю рекомендації та скарги.",
    "",
    "Також тут можна повністю оформити рекомендацію, скаргу або анкету майстра разом із фото."
  ].join("\n"), mainMenuKeyboard());
}

function parseIntakeStartPayload(payload) {
  const match = clean(payload, 64).match(/^(recommend|complaint|add)(?:_(\d{9,12}))?$/i);
  if (!match) {
    return null;
  }
  return { type: match[1].toLowerCase(), phone: match[2] || "" };
}

async function beginBotIntake(message, type, rawPhone = "") {
  const chatId = String(message?.chat?.id || "");
  if (!chatId || !["recommend", "complaint", "add"].includes(type)) {
    return;
  }

  const phone = normalizePhone(rawPhone);
  const hasPhone = /^\+380\d{9}$/.test(phone);
  const session = {
    type,
    step: hasPhone ? "name" : "phone",
    phone: hasPhone ? phone : "",
    phoneNumbers: hasPhone ? [phone] : [],
    masterName: "",
    telegramUsername: "",
    category: "",
    text: "",
    authorName: "",
    authorContact: describeTelegramUser(message.from),
    sourceChatId: chatId,
    sourceMessageIds: [],
    photoFileIds: [],
    photoMimeTypes: [],
    startedAt: new Date().toISOString()
  };

  await saveBotSession(chatId, session);
  const intro = type === "recommend"
    ? "✅ НОВА РЕКОМЕНДАЦІЯ"
    : type === "complaint"
      ? "⚠️ НОВА СКАРГА"
      : "🧰 АНКЕТА МАЙСТРА";
  const question = hasPhone
    ? `Номер: ${formatPhone(phone)}\n\nЯк звати майстра або бригаду?`
    : "Надішли номер телефону майстра у форматі +380 XX XXX XX XX. Якщо номерів кілька — напиши їх через кому.";

  await sendBotMessage(chatId, `${intro}\n\n${question}`, cancelIntakeKeyboard());
}

async function processBotIntakeMessage(message, session) {
  const chatId = String(message?.chat?.id || "");

  if (hasTelegramAttachment(message)) {
    if (session.step !== "photos") {
      await sendBotMessage(chatId, "Фото додамо наприкінці. Спочатку дай відповідь на поточне запитання.", cancelIntakeKeyboard());
      return;
    }

    const attachment = getTelegramAttachment(message);
    if (!attachment) {
      await sendBotMessage(chatId, "Не вдалося прочитати це фото. Спробуй надіслати його як фото або зображення.", photoIntakeKeyboard());
      return;
    }

    session.photoFileIds.push(attachment.fileId);
    session.photoMimeTypes.push(attachment.mimeType);
    session.sourceMessageIds.push(message.message_id);
    await saveBotSession(chatId, session);
    await sendBotMessage(
      chatId,
      `Фото додано: ${session.photoFileIds.length}. Можна надіслати ще або завершити заявку.`,
      photoIntakeKeyboard()
    );
    return;
  }

  const text = clean(message?.text, 2000);
  if (!text) {
    return;
  }

  if (session.step === "phone") {
    const phones = normalizePhoneList(text);
    if (!phones.length) {
      await sendBotMessage(chatId, "Номер не розпізнано. Надішли +380 XX XXX XX XX або 0XX XXX XX XX.", cancelIntakeKeyboard());
      return;
    }
    session.phone = phones[0];
    session.phoneNumbers = phones;
    session.step = "name";
    await saveBotSession(chatId, session);
    await sendBotMessage(chatId, "Як звати майстра або бригаду?", cancelIntakeKeyboard());
    return;
  }

  if (session.step === "name") {
    if (text.length < 2) {
      await sendBotMessage(chatId, "Вкажи імʼя майстра або назву бригади.", cancelIntakeKeyboard());
      return;
    }
    session.masterName = text;
    session.step = "telegram";
    await saveBotSession(chatId, session);
    await sendBotMessage(chatId, "Якщо знаєш Telegram майстра — надішли @username. Інакше натисни «Пропустити».", optionalTelegramKeyboard());
    return;
  }

  if (session.step === "telegram") {
    const username = normalizeTelegramUsername(text);
    if (!username) {
      await sendBotMessage(chatId, "Надішли @username або натисни «Пропустити».", optionalTelegramKeyboard());
      return;
    }
    session.telegramUsername = username;
    session.step = "category";
    await saveBotSession(chatId, session);
    await sendBotMessage(chatId, "Які послуги надає майстер? Можна вказати кілька через кому.", cancelIntakeKeyboard());
    return;
  }

  if (session.step === "category") {
    if (text.length < 2) {
      await sendBotMessage(chatId, "Вкажи хоча б одну послугу.", cancelIntakeKeyboard());
      return;
    }
    session.category = normalizeServices(text);
    session.step = "review";
    await saveBotSession(chatId, session);
    const prompt = session.type === "add"
      ? "Коротко опиши досвід, умови роботи або те, з чим можеш допомогти."
      : session.type === "complaint"
        ? "Опиши, що сталося. Пиши лише про власний досвід і конкретні факти."
        : "Напиши, за що рекомендуєш цього майстра.";
    await sendBotMessage(chatId, prompt, cancelIntakeKeyboard());
    return;
  }

  if (session.step === "review") {
    if (text.length < 8) {
      await sendBotMessage(chatId, "Додай трохи деталей — мінімум 8 символів.", cancelIntakeKeyboard());
      return;
    }
    session.text = text;
    session.step = "author";
    await saveBotSession(chatId, session);
    await sendBotMessage(chatId, "Як підписати цей відгук? Надішли імʼя або обери «Анонімно».", authorKeyboard());
    return;
  }

  if (session.step === "author") {
    session.authorName = /^анон/i.test(text) ? "Анонімно" : text;
    session.step = "photos";
    await saveBotSession(chatId, session);
    await sendBotMessage(chatId, "Надішли фото до відгуку або заверши заявку без фото.", photoIntakeKeyboard());
    return;
  }

  if (session.step === "photos") {
    if (/^(готово|завершити|без фото)$/i.test(text)) {
      await finalizeBotIntake(chatId, session);
      return;
    }
    await sendBotMessage(chatId, "На цьому кроці надішли фото або натисни «Готово».", photoIntakeKeyboard());
  }
}

async function processBotIntakeCallback(callback, data) {
  const callbackId = callback.id;
  const chatId = String(callback.message?.chat?.id || "");
  const session = await getBotSession(chatId);

  if (!session) {
    await answerTelegramCallback(callbackId, "Заявка вже завершена або скасована.", true);
    return;
  }

  if (data === "intake:cancel") {
    await clearBotSession(chatId);
    await sendBotMessage(chatId, "Заявку скасовано.", mainMenuKeyboard());
    await answerTelegramCallback(callbackId, "Скасовано.");
    return;
  }

  if (data === "intake:skip_username" && session.step === "telegram") {
    session.step = "category";
    await saveBotSession(chatId, session);
    await sendBotMessage(chatId, "Які послуги надає майстер? Можна вказати кілька через кому.", cancelIntakeKeyboard());
    await answerTelegramCallback(callbackId, "Пропущено.");
    return;
  }

  if (data === "intake:anonymous" && session.step === "author") {
    session.authorName = "Анонімно";
    session.step = "photos";
    await saveBotSession(chatId, session);
    await sendBotMessage(chatId, "Надішли фото до відгуку або заверши заявку без фото.", photoIntakeKeyboard());
    await answerTelegramCallback(callbackId, "Відгук буде анонімним.");
    return;
  }

  if (data === "intake:finish" && session.step === "photos") {
    await answerTelegramCallback(callbackId, "Надсилаю на модерацію.");
    await finalizeBotIntake(chatId, session);
    return;
  }

  await answerTelegramCallback(callbackId, "Спочатку заверши поточний крок.", true);
}

async function finalizeBotIntake(chatId, session) {
  try {
    const saved = await saveSubmission({
      ...session,
      rawPhone: session.phone,
      userAgent: "telegram-bot/2.0"
    });
    const telegramResult = await sendTelegram(saved);
    await clearBotSession(chatId);
    await sendBotMessage(chatId, [
      "ЗАЯВКУ ПЕРЕДАНО НА МОДЕРАЦІЮ",
      "",
      `Номер: ${formatPhone(saved.phone)}`,
      `Заявка: ${saved.id.slice(0, 8)}`,
      telegramResult.sent
        ? "Після перевірки запис зʼявиться у пошуку та каналі."
        : "Заявку збережено, але модераційний чат тимчасово недоступний."
    ].join("\n"), mainMenuKeyboard());
  } catch (error) {
    await sendBotMessage(chatId, "Не вдалося зберегти заявку. Спробуй ще раз або напиши /cancel.", cancelIntakeKeyboard());
  }
}

async function getBotSession(chatId) {
  const events = await readJsonLines(BOT_SESSIONS_FILE);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (String(events[index].chatId) === String(chatId)) {
      return events[index].session || null;
    }
  }
  return null;
}

async function saveBotSession(chatId, session) {
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  await fs.appendFile(BOT_SESSIONS_FILE, `${JSON.stringify({
    chatId: String(chatId),
    session: { ...session, updatedAt: new Date().toISOString() }
  })}\n`, "utf8");
}

async function clearBotSession(chatId) {
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  await fs.appendFile(BOT_SESSIONS_FILE, `${JSON.stringify({
    chatId: String(chatId),
    session: null,
    updatedAt: new Date().toISOString()
  })}\n`, "utf8");
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
    phoneNumbers: cleanArray(payload.phoneNumbers, 10, 32).map(normalizePhone).filter((phone) => /^\+380\d{9}$/.test(phone)),
    rawPhone: clean(payload.rawPhone, 64),
    masterName: clean(payload.masterName, 160),
    category: clean(payload.category, 120),
    telegramUsername: normalizeTelegramUsername(payload.telegramUsername),
    text: clean(payload.text, 2000),
    authorName: clean(payload.authorName, 120) || "Анонімно",
    authorContact: clean(payload.authorContact, 160),
    photoUrl: clean(payload.photoUrl, 500),
    sourceUrl: clean(payload.sourceUrl, 500),
    sourceNote: clean(payload.sourceNote, 300),
    sourceChatId: clean(payload.sourceChatId, 80),
    sourceMessageIds: cleanArray(payload.sourceMessageIds, 20, 40),
    photoFileIds: cleanArray(payload.photoFileIds, 10, 300),
    photoMimeTypes: cleanArray(payload.photoMimeTypes, 10, 100),
    userAgent: clean(payload.userAgent, 500),
    isPinned: Boolean(payload.isPinned)
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

  if (submission.phoneNumbers.some((phone) => !/^\+380\d{9}$/.test(phone))) {
    return "invalid_phone";
  }

  if (submission.text.length < 8) {
    return "text_too_short";
  }

  return "";
}

async function sendTelegram(submission) {
  const chatId = TELEGRAM_MODERATION_CHAT_ID;

  if (!process.env.TELEGRAM_BOT_TOKEN || !chatId) {
    return { sent: false, skipped: true };
  }

  const heading = submission.type === "recommend"
    ? "✅ НОВА РЕКОМЕНДАЦІЯ"
    : submission.type === "complaint"
      ? "⚠️ НОВА СКАРГА"
      : "🧰 НОВА АНКЕТА МАЙСТРА";
  const message = [
    heading,
    "",
    `Майстер: ${submission.masterName || "не вказано"}`,
    `Послуги: ${submission.category || "не вказано"}`,
    `Телефон: ${submissionPhones(submission).map(formatPhone).join(", ") || "не вказано"}`,
    submission.telegramUsername ? `Telegram: ${submission.telegramUsername}` : "",
    `Автор відгуку: ${submission.authorName || "Анонімно"}`,
    `Надіслав: ${submission.authorContact || "не вказано"}`,
    `Фото: ${submission.photoFileIds.length || (submission.photoUrl ? 1 : 0)}`,
    submission.sourceNote ? `Джерело: ${submission.sourceNote.replace(/^\*\s*/, "")}` : "",
    "",
    submission.text,
    "",
    `Заявка: ${submission.id.slice(0, 8)}`
  ].filter(Boolean).join("\n");

  const result = await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: message,
    disable_web_page_preview: true,
    reply_markup: submissionKeyboard(submission)
  });

  if (result.ok && submission.sourceChatId && submission.sourceMessageIds.length) {
    for (const messageId of submission.sourceMessageIds) {
      await telegramRequest("copyMessage", {
        chat_id: chatId,
        from_chat_id: submission.sourceChatId,
        message_id: Number(messageId)
      });
    }
  }

  return {
    sent: result.ok,
    messageId: result.data?.result?.message_id || ""
  };
}

async function publishApprovedSubmission(submission) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !TELEGRAM_PUBLIC_CHAT_ID) {
    return { sent: false, skipped: true };
  }

  const phone = normalizePhone(submission.phone || submission.rawPhone);
  const isComplaint = submission.type === "complaint";
  const isRecommendation = submission.type === "recommend";
  const heading = isComplaint
    ? "⚠️ Є СКАРГА"
    : isRecommendation
      ? "✅ РЕКОМЕНДУЮТЬ"
      : "🧰 НОВИЙ МАЙСТЕР";
  const profileUrl = siteUrl("/profile", { phone });
  const sourceNote = submission.sourceNote || (isAutomatedImport(submission)
    ? "* Дані витягнуто автоматизовано з чату будинку."
    : "");
  const message = [
    heading,
    "",
    `Майстер: ${submission.masterName || "імʼя не вказано"}`,
    `Послуги: ${submission.category || "не вказано"}`,
    `Телефон: ${submissionPhones(submission).map(formatPhone).join(", ") || formatPhone(phone)}`,
    submission.telegramUsername ? `Telegram: ${submission.telegramUsername}` : "",
    "",
    submission.text,
    "",
    isComplaint
      ? "Це опис користувацького досвіду, а не встановлений платформою факт порушення."
      : "Запис перевірено модератором перед публікацією.",
    sourceNote,
    "",
    `Відкрити профіль: ${profileUrl}`
  ].filter(Boolean).join("\n");
  const result = await telegramRequest("sendMessage", {
    chat_id: TELEGRAM_PUBLIC_CHAT_ID,
    text: message,
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: "Перевірити інший номер", url: telegramBotUrl() }]]
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

function getTelegramAttachment(message) {
  if (Array.isArray(message?.photo) && message.photo.length) {
    const photo = message.photo[message.photo.length - 1];
    return { fileId: photo.file_id, mimeType: "image/jpeg" };
  }

  if (message?.document?.file_id && message.document.mime_type?.startsWith("image/")) {
    return { fileId: message.document.file_id, mimeType: message.document.mime_type };
  }

  return null;
}

function describeTelegramSender(message) {
  const from = message.from || {};
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  const username = from.username ? `@${from.username}` : "";
  const chat = message.chat?.username ? `@${message.chat.username}` : `chat ${message.chat?.id || "невідомий"}`;

  return [name, username, chat].filter(Boolean).join(" · ");
}

function describeTelegramUser(user) {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
  const username = user?.username ? `@${user.username}` : "";
  const id = user?.id ? `ID ${user.id}` : "";
  return [name, username, id].filter(Boolean).join(" · ");
}

function normalizeServices(value) {
  return Array.from(new Set(String(value || "")
    .split(/[;,|\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)))
    .join("; ")
    .slice(0, 120);
}

function cleanArray(value, maxItems, maxLength) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, maxItems).map((item) => clean(item, maxLength)).filter(Boolean);
}

function isAutomatedImport(submission) {
  return submission.userAgent === "svitlopark-approved-import/1.0" || Boolean(submission.sourceNote);
}

function submissionKeyboard(submission, options = {}) {
  const rows = [];

  if (!options.moderated) {
    rows.push([
      { text: "✅ Додати до бази", callback_data: `approve:${submission.id}` },
      { text: "✕ Відхилити", callback_data: `reject:${submission.id}` }
    ]);
  }

  if (submission.phone) {
    rows.push([{ text: "Відкрити профіль", url: siteUrl("/profile", { phone: submission.phone }) }]);
  }

  return { inline_keyboard: rows };
}

function rejectionReasonKeyboard(submission) {
  const id = submission.id;
  return {
    inline_keyboard: [
      [{ text: "Недостатньо доказів", callback_data: `reject_reason:evidence:${id}` }],
      [{ text: "Бракує деталей або фото", callback_data: `reject_reason:details:${id}` }],
      [{ text: "Дублікат", callback_data: `reject_reason:duplicate:${id}` }],
      [{ text: "Спам або реклама", callback_data: `reject_reason:spam:${id}` }],
      [{ text: "Некоректний контакт", callback_data: `reject_reason:contact:${id}` }],
      [{ text: "Інша причина", callback_data: `reject_reason:other:${id}` }],
      [{ text: "Назад", callback_data: `reject_back:${id}` }]
    ]
  };
}

function rejectionReasonLabel(code) {
  const labels = {
    evidence: "недостатньо доказів",
    details: "бракує деталей або фото",
    duplicate: "дублікат",
    spam: "спам або реклама",
    contact: "некоректний контакт",
    other: "інша причина"
  };
  return labels[code] || labels.other;
}

function mainMenuKeyboard() {
  const rows = [
    [{ text: "🔎 Відкрити пошук", url: siteUrl("/") }],
    [
      { text: "✅ Порекомендувати", callback_data: "start:recommend" },
      { text: "⚠️ Залишити скаргу", callback_data: "start:complaint" }
    ],
    [{ text: "🧰 Стати майстром", callback_data: "start:add" }],
    [
      { text: "Усі послуги", url: siteUrl("/#service-categories") },
      { text: "Black List", url: siteUrl("/complaints") }
    ]
  ];

  if (TELEGRAM_PUBLIC_URL) {
    rows.push([{ text: "Публічний канал", url: normalizeTelegramLink(TELEGRAM_PUBLIC_URL) }]);
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
    inline_keyboard: [[{ text: "Відкрити Black List", url: siteUrl("/complaints") }]]
  };
}

function publicChannelKeyboard() {
  return {
    inline_keyboard: [[{
      text: "Відкрити канал",
      url: normalizeTelegramLink(TELEGRAM_PUBLIC_URL) || siteUrl("/")
    }]]
  };
}

function cancelIntakeKeyboard() {
  return {
    inline_keyboard: [[{ text: "Скасувати", callback_data: "intake:cancel" }]]
  };
}

function optionalTelegramKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Пропустити", callback_data: "intake:skip_username" }],
      [{ text: "Скасувати", callback_data: "intake:cancel" }]
    ]
  };
}

function authorKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Анонімно", callback_data: "intake:anonymous" }],
      [{ text: "Скасувати", callback_data: "intake:cancel" }]
    ]
  };
}

function photoIntakeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Готово, на модерацію", callback_data: "intake:finish" }],
      [{ text: "Скасувати", callback_data: "intake:cancel" }]
    ]
  };
}

function notFoundKeyboard(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return {
    inline_keyboard: [
      [
        { text: "✅ Рекомендація", callback_data: `start:recommend:${digits}` },
        { text: "⚠️ Скарга", callback_data: `start:complaint:${digits}` }
      ],
      [{ text: "🧰 Стати майстром", callback_data: `start:add:${digits}` }]
    ]
  };
}

function foundKeyboard(phone, profileUrl) {
  const digits = String(phone || "").replace(/\D/g, "");
  return {
    inline_keyboard: [
      [{ text: "Відкрити профіль", url: profileUrl }],
      [
        { text: "✅ Додати рекомендацію", callback_data: `start:recommend:${digits}` },
        { text: "⚠️ Залишити скаргу", callback_data: `start:complaint:${digits}` }
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
  if (!TELEGRAM_BOT_USERNAME) {
    return "";
  }

  const url = new URL(`https://telegram.me/${TELEGRAM_BOT_USERNAME}`);
  if (startPayload) {
    url.searchParams.set("start", startPayload);
  }
  return url.toString();
}

function normalizeTelegramLink(value) {
  return clean(value, 500).replace(/^https?:\/\/t\.me\//i, "https://telegram.me/");
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
  if (PHONES_CSV_URL) {
    try {
      const response = await fetch(PHONES_CSV_URL, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`sheet_fetch_failed_${response.status}`);
      }
      csv = await response.text();
    } catch (error) {
      console.warn(`Phones sheet fallback: ${error.message}`);
    }
  }

  if (!csv) {
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
  const submissionPhoneList = submissionPhones(submission);
  const phone = submissionPhoneList[0] || normalizePhone(submission.phone || submission.rawPhone);
  if (!/^\+380\d{9}$/.test(phone)) {
    return;
  }

  let row = rows.find((item) => rowPhones(item).some((itemPhone) => submissionPhoneList.includes(itemPhone)));
  if (!row) {
    row = createPhoneRow(submission, phone);
    rows.push(row);
  }

  if (!row.display_name && submission.masterName) {
    row.display_name = submission.masterName;
  }

  const phones = Array.from(new Set([
    ...rowPhones(row),
    ...submissionPhones(submission)
  ]));
  row.primary_phone = row.primary_phone || phones[0] || phone;
  row.phone_numbers = phones.join("; ");

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

  for (let index = 10; index >= 2; index -= 1) {
    ["author", "type", "date", "text", "photo_url", "photo_urls", "source_note"].forEach((field) => {
      row[`review_${index}_${field}`] = row[`review_${index - 1}_${field}`] || "";
    });
  }

  const photoUrls = cleanArray(submission.photoFileIds, 10, 300)
    .map((_, index) => siteUrl(`/api/media/${submission.id}/${index}`));
  if (submission.photoUrl) {
    photoUrls.push(submission.photoUrl);
  }
  row.review_1_author = submission.authorName || "Анонімно";
  row.review_1_type = reviewType;
  row.review_1_date = row.last_review_at;
  row.review_1_text = submission.text;
  row.review_1_photo_url = photoUrls[0] || "";
  row.review_1_photo_urls = Array.from(new Set(photoUrls)).join("; ");
  row.review_1_source_note = submission.sourceNote || (isAutomatedImport(submission)
    ? "* Дані витягнуто автоматизовано з чату будинку."
    : "");
  row.is_pinned = submission.isPinned ? "true" : (row.is_pinned || "");
}

function createPhoneRow(submission, phone) {
  const category = submission.category || "Послуга не вказана";
  const phones = submissionPhones(submission);
  return {
    master_id: `submission-${String(submission.id || randomUUID()).slice(0, 8)}`,
    display_name: submission.masterName || `Майстер ${formatPhone(phone)}`,
    category_name: category,
    category_names: category,
    primary_phone: phones[0] || phone,
    phone_numbers: (phones.length ? phones : [phone]).join("; "),
    telegram_username: submission.telegramUsername || "",
    master_photo_url: "",
    positive_reviews_count: "0",
    negative_reviews_count: "0",
    last_review_at: "",
    last_review_text: "",
    work_photo_url: "",
    work_photo_urls: "",
    profile_url: "",
    is_pinned: submission.isPinned ? "true" : ""
  };
}

function submissionPhones(submission) {
  return Array.from(new Set([
    normalizePhone(submission.phone || submission.rawPhone),
    ...cleanArray(submission.phoneNumbers, 10, 32).map(normalizePhone)
  ].filter((phone) => /^\+380\d{9}$/.test(phone))));
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

function normalizePhoneList(value) {
  const candidates = String(value || "")
    .split(/[;,|\n]+/)
    .map(normalizePhone)
    .filter((phone) => /^\+380\d{9}$/.test(phone));
  return Array.from(new Set(candidates)).slice(0, 10);
}

function normalizeTelegramUsername(value) {
  const match = clean(value, 80).match(/^(?:https?:\/\/(?:t\.me|telegram\.me)\/)?@?([A-Za-z0-9_]{5,32})$/i);
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
  const cleanRoutes = {
    "/": "/index.html",
    "/profile": "/profile.html",
    "/services": "/category.html",
    "/recommendations": "/directory.html",
    "/complaints": "/directory.html",
    "/submit": "/submit.html",
    "/rules": "/rules.html",
    "/privacy": "/privacy.html"
  };
  const cleanPath = cleanRoutes[decoded] || decoded;
  const directPath = path.resolve(STATIC_DIR, `.${cleanPath}`);
  const relativePath = path.relative(STATIC_DIR, directPath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return "";
  }

  if (await exists(directPath)) {
    return directPath;
  }

  if (!path.extname(directPath)) {
    const htmlPath = `${directPath}.html`;
    const htmlRelativePath = path.relative(STATIC_DIR, htmlPath);
    if (!htmlRelativePath.startsWith("..") && !path.isAbsolute(htmlRelativePath) && await exists(htmlPath)) {
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
