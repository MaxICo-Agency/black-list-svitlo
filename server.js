const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  botPrompt,
  buildContactCard,
  buildFoundCard,
  buildIntakeCompleteCard,
  buildModerationCard,
  buildMySubmissionsCard,
  buildNotFoundCard,
  buildPublicCard,
  buildRelayCard,
  buildSubmissionDecisionCard,
  buildWelcomeCard,
  intakePrompt,
  telegramButton
} = require("./telegram-ui");

const PORT = Number(process.env.PORT || 3000);
const STATIC_DIR = __dirname;
const RUNTIME_DIR = process.env.RUNTIME_DIR || path.join(__dirname, "runtime");
const SUBMISSIONS_FILE = path.join(RUNTIME_DIR, "submissions.jsonl");
const MODERATION_EVENTS_FILE = path.join(RUNTIME_DIR, "moderation-events.jsonl");
const BOT_SESSIONS_FILE = path.join(RUNTIME_DIR, "bot-sessions.jsonl");
const MODERATION_SESSIONS_FILE = path.join(RUNTIME_DIR, "moderation-sessions.jsonl");
const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || "https://bl-svitlopark.maxicolabs.com";
const PHONES_CSV_URL = String(process.env.PHONES_CSV_URL || "").trim();
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const TELEGRAM_ADMIN_USER_ID = String(process.env.TELEGRAM_ADMIN_USER_ID || "");
const TELEGRAM_PUBLIC_CHAT_ID = String(process.env.TELEGRAM_PUBLIC_CHAT_ID || "");
const TELEGRAM_PUBLIC_URL = process.env.TELEGRAM_PUBLIC_URL || "";
const TELEGRAM_MODERATION_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "");
const TELEGRAM_BOT_USERNAME = clean(process.env.TELEGRAM_BOT_USERNAME || "bl_svitlopark_bot", 80).replace(/^@/, "");
const TELEGRAM_ADMIN_USERNAME = clean(process.env.TELEGRAM_ADMIN_USERNAME || "max_shapoval", 80).replace(/^@/, "");

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

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`bl-svitlopark listening on :${PORT}`);
  });
}

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
  const userId = String(message?.from?.id || "");

  if (!chatId) {
    return;
  }

  const text = clean(message?.text, 2000);
  const moderationSession = userId ? await getModerationSession(userId) : null;
  if (moderationSession && await processCustomRejectionMessage(message, moderationSession)) {
    return;
  }

  const session = await getBotSession(chatId);

  const [rawCommand = "", startPayload = ""] = text.split(/\s+/, 2);
  const command = rawCommand.replace(/@\w+$/, "").toLowerCase();

  if (command === "/cancel") {
    await clearBotSession(chatId);
    await sendBotMessage(chatId, botPrompt("Заявку скасовано", "Можеш почати нову дію з меню нижче."), mainMenuKeyboard());
    return;
  }

  if (command === "/start") {
    const intakePayload = parseIntakeStartPayload(startPayload);
    if (intakePayload) {
      await beginBotIntake(message, intakePayload.type, intakePayload.phone);
      return;
    }

    if (startPayload === "my") {
      await clearBotSession(chatId);
      await showMySubmissions(chatId, userId);
      return;
    }

    if (startPayload === "contact") {
      await clearBotSession(chatId);
      await sendAdminContact(chatId);
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

  if (command === "/my") {
    await showMySubmissions(chatId, userId);
    return;
  }

  if (command === "/contact") {
    await sendAdminContact(chatId);
    return;
  }

  if (session) {
    await processBotIntakeMessage(message, session);
    return;
  }

  if (hasTelegramAttachment(message)) {
    await sendBotMessage(
      chatId,
      botPrompt("Спочатку обери тип заявки", "Фото додаються наприкінці рекомендації, скарги або анкети майстра."),
      mainMenuKeyboard()
    );
    return;
  }

  if (!text) {
    return;
  }

  if (command === "/categories") {
    await sendBotMessage(chatId, botPrompt("Послуги", "Актуальний список послуг відкривається на сайті."), categoriesKeyboard());
    return;
  }

  if (command === "/search") {
    await sendBotMessage(chatId, botPrompt("Пошук за номером", "Надішли +380 XX XXX XX XX або 067 XXX XX XX.", "Пробіли, дужки й дефіси можна залишити."), mainMenuKeyboard());
    return;
  }

  if (command === "/blacklist") {
    await sendBotMessage(chatId, botPrompt("Black List", "Тут зібрані скарги, що пройшли модерацію."), blacklistKeyboard());
    return;
  }

  if (command === "/channel") {
    await sendBotMessage(chatId, botPrompt("Публічний канал", "У каналі зʼявляються тільки записи після модерації."), publicChannelKeyboard());
    return;
  }

  const phone = normalizePhone(text);

  if (!/^\+380\d{9}$/.test(phone)) {
    await sendBotMessage(
      chatId,
      botPrompt("Номер не розпізнано", "Надішли +380 XX XXX XX XX або 067 XXX XX XX."),
      mainMenuKeyboard()
    );
    return;
  }

  const records = await loadPhoneRecords();
  const record = records.find((item) => item.phones.includes(phone));

  if (!record) {
    const card = buildNotFoundCard({ phone: formatPhone(phone), rawPhone: phone });
    await sendRichBotMessage(chatId, card, notFoundKeyboard(phone));
    return;
  }

  const status = getMasterStatus(record);
  const profileUrl = siteUrl("/profile", { phone });

  const card = buildFoundCard({
    name: record.displayName,
    services: record.categoryName,
    phones: [{ value: formatPhone(phone), href: `tel:${phone}` }],
    telegramUsername: record.telegramUsername,
    positive: record.positive,
    negative: record.negative,
    lastReviewAt: record.lastReviewAt,
    status,
    profileUrl
  });
  await sendRichBotMessage(chatId, card, foundKeyboard(phone, profileUrl));
}

async function processTelegramCallback(callback) {
  const callbackId = callback.id;
  const data = clean(callback.data, 100);
  const userId = String(callback.from?.id || "");
  const chatId = String(callback.message?.chat?.id || "");
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

  if (data.startsWith("edit:")) {
    await processReviewEditCallback(callback, data);
    return;
  }

  if (data === "my:list") {
    await answerTelegramCallback(callbackId, "Відкриваю заявки.");
    await showMySubmissions(chatId, userId);
    return;
  }

  const editMatch = data.match(/^edit_review:([a-f0-9-]{36})$/i);
  if (editMatch) {
    await beginReviewEdit(callback, editMatch[1]);
    return;
  }

  const match = data.match(/^(approve|reject|reject_back|reject_custom_skip|reject_custom_cancel):([a-f0-9-]{36})$/i);
  const reasonMatch = data.match(/^reject_reason:([a-z_]+):([a-f0-9-]{36})$/i);

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
  if (["approved", "rejected", "superseded"].includes(currentStatus)) {
    await answerTelegramCallback(
      callbackId,
      currentStatus === "approved"
        ? "Заявку вже додано до бази."
        : currentStatus === "superseded"
          ? "Цю версію вже замінено."
          : "Заявку вже відхилено."
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
    await clearModerationSession(userId);
    await telegramRequest("editMessageReplyMarkup", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      reply_markup: submissionKeyboard(submission)
    });
    await answerTelegramCallback(callbackId, "Повернув кнопки модерації.");
    return;
  }

  if (action === "reject_custom_cancel") {
    const customSession = await getModerationSession(userId);
    await clearModerationSession(userId);
    await deleteTelegramMessage(chatId, customSession?.promptMessageId);
    await telegramRequest("editMessageReplyMarkup", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      reply_markup: rejectionReasonKeyboard(submission)
    });
    await answerTelegramCallback(callbackId, "Введення причини скасовано.");
    return;
  }

  if (reasonMatch?.[1] === "other") {
    await requestCustomRejectionReason(callback, submission);
    return;
  }

  const status = action === "approve" ? "approved" : "rejected";
  const rejectionCode = reasonMatch?.[1] || (action === "reject_custom_skip" ? "skipped" : "");
  const rejectionReason = reasonMatch ? rejectionReasonLabel(reasonMatch[1]) : "";
  const customSession = action === "reject_custom_skip" ? await getModerationSession(userId) : null;

  await finalizeModerationDecision({
    submission,
    status,
    rejectionCode,
    rejectionReason,
    reviewedBy: userId,
    moderationChatId: callback.message.chat.id,
    moderationMessageId: callback.message.message_id
  });

  if (customSession) {
    await clearModerationSession(userId);
    await deleteTelegramMessage(chatId, customSession.promptMessageId);
  }

  await answerTelegramCallback(callbackId, status === "approved" ? "Додано до бази." : "Заявку відхилено.");
}

async function sendBotWelcome(chatId) {
  await sendRichBotMessage(chatId, buildWelcomeCard(), mainMenuKeyboard());
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
  let knownTelegramUsername = "";
  if (hasPhone) {
    try {
      const records = await loadPhoneRecords();
      knownTelegramUsername = records.find((record) => record.phones.includes(phone))?.telegramUsername || "";
    } catch (error) {
      knownTelegramUsername = "";
    }
  }
  const session = {
    mode: "intake",
    type,
    step: hasPhone ? "name" : "phone",
    phone: hasPhone ? phone : "",
    phoneNumbers: hasPhone ? [phone] : [],
    masterName: "",
    telegramUsername: knownTelegramUsername,
    category: "",
    text: "",
    authorName: "",
    authorContact: describeTelegramUser(message.from),
    sourceChatId: chatId,
    submitterChatId: chatId,
    submitterUserId: String(message?.from?.id || ""),
    submitterUsername: message?.from?.username ? `@${message.from.username}` : "",
    sourceMessageIds: [],
    photoFileIds: [],
    photoMimeTypes: [],
    startedAt: new Date().toISOString()
  };

  const title = hasPhone ? "Як звати майстра або бригаду?" : "Номер телефону майстра";
  const question = hasPhone
    ? "Надішли імʼя майстра або назву бригади."
    : "Надішли номер майстра у форматі +380 XX XXX XX XX. Якщо номерів кілька — напиши їх через кому.";

  await showIntakePrompt(chatId, session, hasPhone ? 2 : 1, title, question, "", cancelIntakeKeyboard());
}

async function processBotIntakeMessage(message, session) {
  const chatId = String(message?.chat?.id || "");

  if (session.mode === "edit_review") {
    await processReviewEditMessage(message, session);
    return;
  }

  if (hasTelegramAttachment(message)) {
    if (session.step !== "photos") {
      await showIntakePrompt(chatId, session, intakeStepNumber(session.step), "Спочатку заверши цей крок", "Фото можна додати наприкінці форми.", "", cancelIntakeKeyboard());
      return;
    }

    const attachment = getTelegramAttachment(message);
    if (!attachment) {
      await showIntakePrompt(chatId, session, 7, "Фото не розпізнано", "Надішли його як фото або файл-зображення.", "", photoIntakeKeyboard());
      return;
    }

    if (session.photoFileIds.length >= 10) {
      await showIntakePrompt(chatId, session, 7, "Уже додано 10 фото", "Заверши заявку або скасуй форму.", "", photoIntakeKeyboard());
      return;
    }

    session.photoFileIds.push(attachment.fileId);
    session.photoMimeTypes.push(attachment.mimeType);
    session.sourceMessageIds.push(message.message_id);
    await showIntakePrompt(chatId, session, 7, "Фотографії до відгуку", `Додано фото: ${session.photoFileIds.length}. Надішли ще або заверши заявку.`, "До 10 зображень.", photoIntakeKeyboard());
    return;
  }

  const text = clean(message?.text, 2000);
  if (!text) {
    return;
  }

  if (session.step === "phone") {
    const phones = normalizePhoneList(text);
    if (!phones.length) {
      await showIntakePrompt(chatId, session, 1, "Номер не розпізнано", "Надішли +380 XX XXX XX XX або 0XX XXX XX XX.", "Пробіли, дужки й дефіси можна залишити.", cancelIntakeKeyboard());
      return;
    }
    session.phone = phones[0];
    session.phoneNumbers = phones;
    session.step = "name";
    await showIntakePrompt(chatId, session, 2, "Як звати майстра або бригаду?", "Надішли імʼя майстра або назву бригади.", "", cancelIntakeKeyboard());
    return;
  }

  if (session.step === "name") {
    if (text.length < 2) {
      await showIntakePrompt(chatId, session, 2, "Потрібне імʼя", "Вкажи імʼя майстра або назву бригади.", "", cancelIntakeKeyboard());
      return;
    }
    session.masterName = text;
    if (session.telegramUsername) {
      session.step = "category";
      await showIntakePrompt(chatId, session, 4, "Які послуги надає майстер?", "Можна вказати кілька послуг через кому.", "Telegram підтягнуто з уже наявного профілю.", cancelIntakeKeyboard());
      return;
    }
    session.step = "telegram";
    await showIntakePrompt(
      chatId,
      session,
      3,
      "Telegram майстра",
      "Надішли @username або посилання telegram.me/username.",
      "Бот не може знайти чужий Telegram лише за номером через налаштування приватності. Цей крок можна пропустити.",
      optionalTelegramKeyboard()
    );
    return;
  }

  if (session.step === "telegram") {
    const username = normalizeTelegramUsername(text);
    if (!username) {
      await showIntakePrompt(chatId, session, 3, "Telegram не розпізнано", "Надішли @username, посилання telegram.me/username або пропусти крок.", "", optionalTelegramKeyboard());
      return;
    }
    session.telegramUsername = username;
    session.step = "category";
    await showIntakePrompt(chatId, session, 4, "Які послуги надає майстер?", "Можна вказати кілька послуг через кому.", "", cancelIntakeKeyboard());
    return;
  }

  if (session.step === "category") {
    if (text.length < 2) {
      await showIntakePrompt(chatId, session, 4, "Потрібна послуга", "Вкажи хоча б одну послугу.", "", cancelIntakeKeyboard());
      return;
    }
    session.category = normalizeServices(text);
    session.step = "review";
    const prompt = session.type === "add"
      ? "Коротко опиши досвід, умови роботи або те, з чим можеш допомогти."
      : session.type === "complaint"
        ? "Опиши, що сталося. Пиши лише про власний досвід і конкретні факти."
        : "Напиши, за що рекомендуєш цього майстра.";
    await showIntakePrompt(chatId, session, 5, session.type === "complaint" ? "Що сталося?" : "Опиши свій досвід", prompt, "", cancelIntakeKeyboard());
    return;
  }

  if (session.step === "review") {
    if (text.length < 8) {
      await showIntakePrompt(chatId, session, 5, "Потрібно більше деталей", "Опиши досвід хоча б у 8 символах.", "", cancelIntakeKeyboard());
      return;
    }
    session.text = text;
    session.step = "author";
    await showIntakePrompt(chatId, session, 6, "Як підписати відгук?", "Надішли імʼя або обери анонімний варіант.", "Імʼя автора можна не публікувати.", authorKeyboard());
    return;
  }

  if (session.step === "author") {
    session.authorName = /^анон/i.test(text) ? "Анонімно" : text;
    session.step = "photos";
    await showIntakePrompt(chatId, session, 7, "Фотографії до відгуку", "Надішли фото або заверши заявку без нього.", "Можна додати до 10 зображень.", photoIntakeKeyboard());
    return;
  }

  if (session.step === "photos") {
    if (/^(готово|завершити|без фото)$/i.test(text)) {
      await finalizeBotIntake(chatId, session);
      return;
    }
    await showIntakePrompt(chatId, session, 7, "Фотографії до відгуку", "Надішли фото або натисни «Надіслати на модерацію».", "", photoIntakeKeyboard());
  }
}

async function processBotIntakeCallback(callback, data) {
  const callbackId = callback.id;
  const chatId = String(callback.message?.chat?.id || "");
  const session = await getBotSession(chatId);

  if (!session) {
    await answerTelegramCallback(callbackId, "Ця заявка вже завершена або скасована.", true);
    return;
  }

  if (data === "intake:cancel") {
    await clearBotSession(chatId);
    await editOrSendRegularBotMessage(chatId, session.flowMessageId, botPrompt("Заявку скасовано", "Можеш почати нову дію з меню нижче."), mainMenuKeyboard());
    await answerTelegramCallback(callbackId, "Скасовано.");
    return;
  }

  if (data === "intake:skip_username" && session.step === "telegram") {
    session.step = "category";
    await showIntakePrompt(chatId, session, 4, "Які послуги надає майстер?", "Можна вказати кілька послуг через кому.", "", cancelIntakeKeyboard());
    await answerTelegramCallback(callbackId, "Пропущено.");
    return;
  }

  if (data === "intake:anonymous" && session.step === "author") {
    session.authorName = "Анонімно";
    session.step = "photos";
    await showIntakePrompt(chatId, session, 7, "Фотографії до відгуку", "Надішли фото або заверши заявку без нього.", "Можна додати до 10 зображень.", photoIntakeKeyboard());
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
    const card = buildIntakeCompleteCard({
      phone: formatPhone(saved.phone),
      rawPhone: saved.phone,
      id: saved.id.slice(0, 8),
      sent: telegramResult.sent
    });
    const edited = session.flowMessageId
      ? await editRichBotMessage(chatId, session.flowMessageId, card, postSubmissionKeyboard())
      : { edited: false };
    if (!edited.edited) {
      await sendRichBotMessage(chatId, card, postSubmissionKeyboard());
    }
  } catch (error) {
    await showIntakePrompt(chatId, session, 7, "Не вдалося зберегти заявку", "Спробуй ще раз або скасуй форму.", "", cancelIntakeKeyboard());
  }
}

async function showIntakePrompt(chatId, session, step, title, body, hint, replyMarkup) {
  const html = intakePrompt(step, title, body, hint, {
    kind: intakeKindLabel(session.type),
    summary: intakeSummary(session)
  });
  const result = await editOrSendRegularBotMessage(chatId, session.flowMessageId, html, replyMarkup);
  if (result.messageId) {
    session.flowMessageId = result.messageId;
  }
  await saveBotSession(chatId, session);
  return result;
}

function intakeKindLabel(type) {
  if (type === "complaint") {
    return "⚠️ Скарга на майстра";
  }
  if (type === "add") {
    return "Анкета майстра";
  }
  return "✅ Рекомендація майстра";
}

function intakeSummary(session) {
  return [
    session.phone ? `Телефон: ${formatPhone(session.phone)}` : "",
    session.masterName ? `Майстер: ${session.masterName}` : "",
    session.telegramUsername ? `Telegram: ${session.telegramUsername}` : "",
    session.category ? `Послуги: ${session.category}` : "",
    session.authorName ? `Автор: ${session.authorName}` : ""
  ].filter(Boolean);
}

function intakeStepNumber(step) {
  return { phone: 1, name: 2, telegram: 3, category: 4, review: 5, author: 6, photos: 7 }[step] || 1;
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

async function getModerationSession(userId) {
  const events = await readJsonLines(MODERATION_SESSIONS_FILE);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (String(events[index].userId) === String(userId)) {
      return events[index].session || null;
    }
  }
  return null;
}

async function saveModerationSession(userId, session) {
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  await fs.appendFile(MODERATION_SESSIONS_FILE, `${JSON.stringify({
    userId: String(userId),
    session: { ...session, updatedAt: new Date().toISOString() }
  })}\n`, "utf8");
}

async function clearModerationSession(userId) {
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  await fs.appendFile(MODERATION_SESSIONS_FILE, `${JSON.stringify({
    userId: String(userId),
    session: null,
    updatedAt: new Date().toISOString()
  })}\n`, "utf8");
}

async function requestCustomRejectionReason(callback, submission) {
  const userId = String(callback.from?.id || "");
  const chatId = String(callback.message?.chat?.id || "");
  const mention = TELEGRAM_ADMIN_USERNAME ? `@${TELEGRAM_ADMIN_USERNAME}` : "Адміністраторе";
  const prompt = await sendBotMessage(
    chatId,
    botPrompt(
      "Власна причина відхилення",
      `${mention}, відповідь на це повідомлення буде надіслана автору заявки.`,
      "Напиши причину одним коротким повідомленням."
    ),
    {
      force_reply: true,
      input_field_placeholder: "Причина відхилення",
      selective: true
    }
  );

  await saveModerationSession(userId, {
    mode: "custom_rejection",
    submissionId: submission.id,
    chatId,
    moderationMessageId: callback.message?.message_id || "",
    promptMessageId: prompt.messageId || ""
  });
  await telegramRequest("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: callback.message.message_id,
    reply_markup: customRejectionKeyboard(submission)
  });
  await answerTelegramCallback(callback.id, "Напиши власну причину у відповідь на повідомлення.");
}

async function processCustomRejectionMessage(message, session) {
  const userId = String(message?.from?.id || "");
  const chatId = String(message?.chat?.id || "");
  const replyTo = String(message?.reply_to_message?.message_id || "");

  if (
    session.mode !== "custom_rejection" ||
    userId !== TELEGRAM_ADMIN_USER_ID ||
    chatId !== TELEGRAM_MODERATION_CHAT_ID ||
    replyTo !== String(session.promptMessageId || "")
  ) {
    return false;
  }

  const reason = clean(message?.text, 300);
  if (reason.length < 3) {
    await sendBotMessage(chatId, botPrompt("Причина надто коротка", "Напиши хоча б кілька слів у відповідь на попереднє повідомлення."));
    return true;
  }

  const submission = await findSubmissionById(session.submissionId);
  const currentStatus = await getModerationStatus(session.submissionId);
  if (!submission || ["approved", "rejected", "superseded"].includes(currentStatus)) {
    await clearModerationSession(userId);
    await deleteTelegramMessage(chatId, session.promptMessageId);
    return true;
  }

  await finalizeModerationDecision({
    submission,
    status: "rejected",
    rejectionCode: "custom",
    rejectionReason: reason,
    reviewedBy: userId,
    moderationChatId: chatId,
    moderationMessageId: session.moderationMessageId
  });
  await clearModerationSession(userId);
  await deleteTelegramMessage(chatId, session.promptMessageId);
  await deleteTelegramMessage(chatId, message.message_id);
  return true;
}

async function finalizeModerationDecision(options) {
  const {
    submission,
    status,
    rejectionCode = "",
    rejectionReason = "",
    reviewedBy,
    moderationChatId,
    moderationMessageId
  } = options;
  const publicResult = status === "approved"
    ? await publishApprovedSubmission(submission)
    : { sent: false, skipped: true };
  const event = {
    submissionId: submission.id,
    status,
    reviewedBy,
    reviewedAt: new Date().toISOString(),
    telegramMessageId: moderationMessageId || "",
    publicMessageId: publicResult.messageId || "",
    rejectionCode,
    rejectionReason
  };

  await appendModerationEvent(event);
  if (status === "approved" && submission.replacesSubmissionId) {
    await appendModerationEvent({
      submissionId: submission.replacesSubmissionId,
      status: "superseded",
      replacedBy: submission.id,
      reviewedBy,
      reviewedAt: event.reviewedAt
    });
  }
  invalidatePhoneCaches();

  const card = buildModerationCard(moderationCardView(submission, {
    status,
    rejectionReason,
    publicSent: publicResult.sent
  }));
  await editRichBotMessage(
    moderationChatId,
    moderationMessageId,
    card,
    submissionKeyboard(submission, { moderated: true })
  );
  await notifySubmissionAuthor(submission, status, rejectionCode, rejectionReason);
  return event;
}

async function appendModerationEvent(event) {
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
  await fs.appendFile(MODERATION_EVENTS_FILE, `${JSON.stringify(event)}\n`, "utf8");
}

async function notifySubmissionAuthor(submission, status, rejectionCode, rejectionReason) {
  if (!String(submission.userAgent || "").startsWith("telegram-bot/")) {
    return { sent: false, skipped: true };
  }

  const chatId = String(submission.submitterChatId || submission.sourceChatId || "");
  if (!/^\d+$/.test(chatId)) {
    return { sent: false, skipped: true };
  }

  const phone = normalizePhone(submission.phone || submission.rawPhone);
  const profileUrl = phone ? siteUrl("/profile", { phone }) : "";
  const card = buildSubmissionDecisionCard({
    status,
    type: submission.type,
    name: submission.masterName,
    phones: submissionPhoneView(submission),
    rejectionReason,
    profileUrl
  });
  return sendRichBotMessage(
    chatId,
    card,
    submissionDecisionKeyboard(submission, { status, rejectionCode, profileUrl })
  );
}

async function sendAdminContact(chatId) {
  await sendRichBotMessage(chatId, buildContactCard({ adminUrl: telegramAdminUrl() }), {
    inline_keyboard: [[telegramButton("Відкрити чат", { url: telegramAdminUrl() }, "primary")]]
  });
}

async function showMySubmissions(chatId, userId) {
  const [submissions, events] = await Promise.all([
    readJsonLines(SUBMISSIONS_FILE),
    readJsonLines(MODERATION_EVENTS_FILE)
  ]);
  const latestStatus = latestSubmissionStatuses(events);
  const owned = submissions.filter((submission) => isSubmissionOwner(submission, userId, chatId));
  const replacedIds = new Set(owned.map((submission) => submission.replacesSubmissionId).filter(Boolean));
  const visible = owned
    .filter((submission) => !replacedIds.has(submission.id))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .slice(0, 5)
    .map((submission) => ({
      submission,
      status: latestStatus.get(submission.id) || "new"
    }));
  const card = buildMySubmissionsCard({
    items: visible.map(({ submission, status }) => ({
      name: submission.masterName,
      typeLabel: labelType(submission.type),
      statusLabel: submissionStatusLabel(status),
      date: String(submission.createdAt || "").slice(0, 10),
      review: clean(submission.text, 220)
    }))
  });
  await sendRichBotMessage(chatId, card, mySubmissionsKeyboard(visible));
}

async function beginReviewEdit(callback, submissionId) {
  const chatId = String(callback.message?.chat?.id || "");
  const userId = String(callback.from?.id || "");
  const submission = await findSubmissionById(submissionId);

  if (!submission || !isSubmissionOwner(submission, userId, chatId)) {
    await answerTelegramCallback(callback.id, "Цю заявку не знайдено або вона належить іншому користувачу.", true);
    return;
  }

  const status = await getModerationStatus(submissionId);
  if (!["approved", "rejected"].includes(status)) {
    await answerTelegramCallback(callback.id, "Спочатку дочекайся рішення модератора.", true);
    return;
  }

  const session = {
    mode: "edit_review",
    step: "edit_review",
    editSubmissionId: submission.id,
    type: submission.type,
    originalType: submission.type,
    phone: submission.phone,
    phoneNumbers: submission.phoneNumbers,
    masterName: submission.masterName,
    telegramUsername: submission.telegramUsername,
    category: submission.category,
    text: submission.text,
    authorName: submission.authorName,
    authorContact: describeTelegramUser(callback.from),
    sourceChatId: chatId,
    submitterChatId: chatId,
    submitterUserId: userId,
    submitterUsername: callback.from?.username ? `@${callback.from.username}` : "",
    sourceMessageIds: submission.sourceMessageIds,
    photoFileIds: submission.photoFileIds,
    photoMimeTypes: submission.photoMimeTypes,
    flowMessageId: callback.message?.message_id || "",
    startedAt: new Date().toISOString()
  };
  await showReviewEditPrompt(chatId, session);
  await answerTelegramCallback(callback.id, "Можна змінити тип і текст відгуку.");
}

async function processReviewEditCallback(callback, data) {
  const chatId = String(callback.message?.chat?.id || "");
  const session = await getBotSession(chatId);
  if (!session || session.mode !== "edit_review") {
    await answerTelegramCallback(callback.id, "Редагування вже завершено або скасовано.", true);
    return;
  }

  if (data === "edit:cancel") {
    await clearBotSession(chatId);
    await editOrSendRegularBotMessage(chatId, session.flowMessageId, botPrompt("Редагування скасовано", "Попередня версія відгуку не змінилася."), mainMenuKeyboard());
    await answerTelegramCallback(callback.id, "Скасовано.");
    return;
  }

  if (data === "edit:toggle_type") {
    session.type = session.type === "complaint" ? "recommend" : "complaint";
    await showReviewEditPrompt(chatId, session);
    await answerTelegramCallback(callback.id, session.type === "complaint" ? "Тип змінено на скаргу." : "Тип змінено на рекомендацію.");
    return;
  }

  await answerTelegramCallback(callback.id, "Невідома дія.", true);
}

async function showReviewEditPrompt(chatId, session, error = "") {
  const typeLabel = session.type === "complaint" ? "Скарга" : "Рекомендація";
  const html = intakePrompt(
    1,
    error || "Надішли новий текст відгуку",
    `Поточний текст:\n${session.text}`,
    "За потреби зміни тип відгуку кнопкою нижче.",
    {
      total: 1,
      kind: "Редагування відгуку",
      summary: [`Майстер: ${session.masterName}`, `Тип: ${typeLabel}`]
    }
  );
  const result = await editOrSendRegularBotMessage(chatId, session.flowMessageId, html, reviewEditKeyboard(session));
  if (result.messageId) {
    session.flowMessageId = result.messageId;
  }
  await saveBotSession(chatId, session);
}

async function processReviewEditMessage(message, session) {
  const chatId = String(message?.chat?.id || "");
  if (hasTelegramAttachment(message)) {
    await showReviewEditPrompt(chatId, session, "Тут потрібен новий текст, а не фото");
    return;
  }

  const text = clean(message?.text, 2000);
  if (text.length < 8) {
    await showReviewEditPrompt(chatId, session, "Потрібно щонайменше 8 символів");
    return;
  }

  const original = await findSubmissionById(session.editSubmissionId);
  if (!original || !isSubmissionOwner(original, String(message?.from?.id || ""), chatId)) {
    await clearBotSession(chatId);
    await editOrSendRegularBotMessage(chatId, session.flowMessageId, botPrompt("Не вдалося відкрити заявку", "Попередня версія не змінилася."), mainMenuKeyboard());
    return;
  }

  try {
    const saved = await saveSubmission({
      ...original,
      type: session.type,
      text,
      authorContact: describeTelegramUser(message.from),
      sourceChatId: chatId,
      submitterChatId: chatId,
      submitterUserId: String(message?.from?.id || ""),
      submitterUsername: message?.from?.username ? `@${message.from.username}` : "",
      replacesSubmissionId: original.id,
      revisionNumber: Number(original.revisionNumber || 0) + 1,
      userAgent: "telegram-bot/2.1"
    });
    const telegramResult = await sendTelegram(saved);
    await clearBotSession(chatId);
    const card = buildIntakeCompleteCard({
      phone: formatPhone(saved.phone),
      rawPhone: saved.phone,
      id: saved.id.slice(0, 8),
      sent: telegramResult.sent
    });
    const edited = await editRichBotMessage(chatId, session.flowMessageId, card, postSubmissionKeyboard());
    if (!edited.edited) {
      await sendRichBotMessage(chatId, card, postSubmissionKeyboard());
    }
  } catch (error) {
    await showReviewEditPrompt(chatId, session, "Не вдалося надіслати зміни");
  }
}

function isSubmissionOwner(submission, userId, chatId) {
  if (!String(submission.userAgent || "").startsWith("telegram-bot/")) {
    return false;
  }
  if (submission.submitterUserId && String(submission.submitterUserId) === String(userId)) {
    return true;
  }
  return String(submission.submitterChatId || submission.sourceChatId || "") === String(chatId);
}

function submissionStatusLabel(status) {
  const labels = {
    new: "На модерації",
    approved: "Схвалено",
    rejected: "Відхилено",
    superseded: "Замінено новою версією"
  };
  return labels[status] || status;
}

function latestSubmissionStatuses(events) {
  const statuses = new Map();
  events.forEach((event) => {
    if (event.submissionId && event.status) {
      statuses.set(event.submissionId, event.status);
    }
  });
  return statuses;
}

async function deleteTelegramMessage(chatId, messageId) {
  if (!chatId || !messageId) {
    return false;
  }
  const result = await telegramRequest("deleteMessage", {
    chat_id: chatId,
    message_id: Number(messageId)
  });
  return result.ok;
}

function normalizeSubmission(payload) {
  return {
    type: clean(payload.type, 40),
    phone: normalizePhone(payload.phone || payload.rawPhone),
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
    submitterChatId: clean(payload.submitterChatId, 80),
    submitterUserId: clean(payload.submitterUserId, 80),
    submitterUsername: normalizeTelegramUsername(payload.submitterUsername),
    sourceMessageIds: cleanArray(payload.sourceMessageIds, 20, 40),
    photoFileIds: cleanArray(payload.photoFileIds, 10, 300),
    photoMimeTypes: cleanArray(payload.photoMimeTypes, 10, 100),
    replacesSubmissionId: clean(payload.replacesSubmissionId, 36),
    revisionNumber: Math.max(0, Math.min(Number(payload.revisionNumber) || 0, 100)),
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

  const card = buildModerationCard(moderationCardView(submission));
  const result = await sendRichBotMessage(chatId, card, submissionKeyboard(submission));

  if (result.sent && submission.sourceChatId && submission.sourceMessageIds.length) {
    for (const messageId of submission.sourceMessageIds) {
      await telegramRequest("copyMessage", {
        chat_id: chatId,
        from_chat_id: submission.sourceChatId,
        message_id: Number(messageId)
      });
    }
  }

  return {
    sent: result.sent,
    messageId: result.messageId || ""
  };
}

async function publishApprovedSubmission(submission) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !TELEGRAM_PUBLIC_CHAT_ID) {
    return { sent: false, skipped: true };
  }

  const phone = normalizePhone(submission.phone || submission.rawPhone);
  const isComplaint = submission.type === "complaint";
  const profileUrl = siteUrl("/profile", { phone });
  const sourceNote = submission.sourceNote || (isAutomatedImport(submission)
    ? "* Дані витягнуто автоматизовано з чату будинку."
    : "");
  const card = buildPublicCard({
    type: submission.type,
    name: submission.masterName,
    services: submission.category,
    phones: submissionPhoneView(submission),
    telegramUsername: submission.telegramUsername,
    review: submission.text,
    author: submission.authorName,
    profileUrl,
    disclaimer: isComplaint
      ? "Це опис користувацького досвіду, а не встановлений платформою факт порушення."
      : "Запис перевірено модератором перед публікацією.",
    source: sourceNote.replace(/^\*\s*/, "")
  });
  const keyboard = {
    inline_keyboard: [[telegramButton("Перевірити інший номер", { url: telegramBotUrl() }, "primary")]]
  };
  let replacedPublicMessageId = "";
  if (submission.replacesSubmissionId) {
    const replacedEvent = await findLatestModerationEvent(submission.replacesSubmissionId, "approved");
    replacedPublicMessageId = replacedEvent?.publicMessageId || "";
    if (replacedPublicMessageId) {
      const edited = await editRichBotMessage(TELEGRAM_PUBLIC_CHAT_ID, replacedPublicMessageId, card, keyboard);
      if (edited.edited) {
        return { sent: true, edited: true, messageId: replacedPublicMessageId };
      }
    }
  }

  const result = await sendRichBotMessage(TELEGRAM_PUBLIC_CHAT_ID, card, keyboard);
  if (result.sent && replacedPublicMessageId) {
    await deleteTelegramMessage(TELEGRAM_PUBLIC_CHAT_ID, replacedPublicMessageId);
  }

  return {
    sent: result.sent,
    messageId: result.messageId || ""
  };
}

function submissionPhoneView(submission) {
  return submissionPhones(submission).map((phone) => ({
    value: formatPhone(phone),
    href: `tel:${phone}`
  }));
}

function moderationCardView(submission, state = {}) {
  const phone = normalizePhone(submission.phone || submission.rawPhone);
  return {
    type: submission.type,
    name: submission.masterName,
    services: submission.category,
    phones: submissionPhoneView(submission),
    telegramUsername: submission.telegramUsername,
    author: submission.authorName,
    submittedBy: submission.authorContact,
    photoCount: submission.photoFileIds.length || (submission.photoUrl ? 1 : 0),
    source: submission.sourceNote?.replace(/^\*\s*/, ""),
    sourceUrl: submission.sourceUrl,
    review: submission.text,
    id: submission.id.slice(0, 8),
    revisionOf: submission.replacesSubmissionId ? submission.replacesSubmissionId.slice(0, 8) : "",
    profileUrl: phone ? siteUrl("/profile", { phone }) : "",
    ...state
  };
}

async function sendBotMessage(chatId, html, replyMarkup = null) {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return { sent: false, skipped: true };
  }

  const result = await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });

  return {
    sent: result.ok,
    messageId: result.data?.result?.message_id || "",
    mode: "regular"
  };
}

async function editOrSendRegularBotMessage(chatId, messageId, html, replyMarkup = null) {
  if (messageId) {
    const result = await telegramRequest("editMessageText", {
      chat_id: chatId,
      message_id: Number(messageId),
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    });
    if (result.ok || isTelegramMessageNotModified(result)) {
      return { sent: true, edited: true, messageId: Number(messageId), mode: "regular" };
    }
  }
  return sendBotMessage(chatId, html, replyMarkup);
}

async function sendRichBotMessage(chatId, card, replyMarkup = null) {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return { sent: false, skipped: true };
  }

  const richResult = await telegramRequest("sendRichMessage", {
    chat_id: chatId,
    rich_message: { html: card.richHtml },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });

  if (!richResult.ok) {
    return sendBotMessage(chatId, card.fallbackHtml, replyMarkup);
  }

  return {
    sent: true,
    messageId: richResult.data?.result?.message_id || "",
    mode: "rich"
  };
}

async function editRichBotMessage(chatId, messageId, card, replyMarkup = null) {
  const richResult = await telegramRequest("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    rich_message: { html: card.richHtml },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });

  if (richResult.ok || isTelegramMessageNotModified(richResult)) {
    return { edited: true, messageId, mode: "rich" };
  }

  const fallbackResult = await telegramRequest("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: card.fallbackHtml,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });

  return {
    edited: fallbackResult.ok || isTelegramMessageNotModified(fallbackResult),
    messageId,
    mode: "regular"
  };
}

async function relayTelegramAttachmentToAdmin(message, submissionId = "") {
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!process.env.TELEGRAM_BOT_TOKEN || !chatId) {
    return false;
  }

  const caption = clean(message.caption, 1000);
  const card = buildRelayCard({
    title: "Фото в Telegram-боті",
    sender: describeTelegramSender(message),
    submissionId: submissionId || "не привʼязана",
    text: caption,
    footer: "Оригінал нижче скопійовано в цей чат."
  });

  await sendRichBotMessage(chatId, card);
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

  const result = await sendRichBotMessage(chatId, buildRelayCard({
    title: "Повідомлення у Telegram-боті",
    sender: describeTelegramSender(message),
    text
  }));

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

    const data = await telegramResponse.json().catch(() => ({}));
    if (!telegramResponse.ok || data.ok === false) {
      const description = clean(data.description, 160);
      if (!/message is not modified/i.test(description)) {
        console.warn(`Telegram ${method} failed: ${telegramResponse.status} ${description}`);
      }
      return { ok: false, data, description };
    }

    return { ok: true, data };
  } catch (error) {
    console.warn(`Telegram ${method} failed: ${error.message}`);
    return { ok: false };
  }
}

function isTelegramMessageNotModified(result) {
  return /message is not modified/i.test(String(result?.description || result?.data?.description || ""));
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
    rows.push([telegramButton("Схвалити й додати до бази", { callback_data: `approve:${submission.id}` }, "success")]);
    rows.push([telegramButton("Відхилити заявку", { callback_data: `reject:${submission.id}` }, "danger")]);
  }

  if (submission.phone) {
    rows.push([telegramButton("Відкрити профіль", { url: siteUrl("/profile", { phone: submission.phone }) }, "primary")]);
  }

  return { inline_keyboard: rows };
}

function rejectionReasonKeyboard(submission) {
  const id = submission.id;
  return {
    inline_keyboard: [
      [telegramButton("Недостатньо підтверджень", { callback_data: `reject_reason:evidence:${id}` }, "danger")],
      [telegramButton("Бракує деталей / фото", { callback_data: `reject_reason:details:${id}` }, "danger")],
      [
        telegramButton("Дублікат", { callback_data: `reject_reason:duplicate:${id}` }, "danger"),
        telegramButton("Реклама / спам", { callback_data: `reject_reason:spam:${id}` }, "danger")
      ],
      [telegramButton("Некоректний контакт", { callback_data: `reject_reason:contact:${id}` }, "danger")],
      [telegramButton("Вказати власну причину", { callback_data: `reject_reason:other:${id}` }, "primary")],
      [telegramButton("Повернутися", { callback_data: `reject_back:${id}` })]
    ]
  };
}

function customRejectionKeyboard(submission) {
  return {
    inline_keyboard: [
      [telegramButton("Відхилити без пояснення", { callback_data: `reject_custom_skip:${submission.id}` }, "danger")],
      [telegramButton("Скасувати власну причину", { callback_data: `reject_custom_cancel:${submission.id}` })]
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
  return {
    inline_keyboard: [
      [telegramButton("Відкрити пошук", { url: siteUrl("/") }, "primary")],
      [
        telegramButton("Порекомендувати", { callback_data: "start:recommend" }, "success"),
        telegramButton("Залишити скаргу", { callback_data: "start:complaint" }, "danger")
      ],
      [telegramButton("Мої заявки", { callback_data: "my:list" }, "primary")],
      [telegramButton("Звʼязатися з адміністрацією", { url: telegramAdminUrl() })]
    ]
  };
}

function postSubmissionKeyboard() {
  return {
    inline_keyboard: [
      [telegramButton("Мої заявки", { callback_data: "my:list" }, "primary")],
      [telegramButton("Перевірити інший номер", { url: siteUrl("/") })],
      [telegramButton("Звʼязатися з адміністрацією", { url: telegramAdminUrl() })]
    ]
  };
}

function mySubmissionsKeyboard(entries) {
  const rows = entries
    .filter(({ submission, status }) => ["recommend", "complaint"].includes(submission.type) && ["approved", "rejected"].includes(status))
    .map(({ submission }) => [telegramButton(
      `Змінити: ${clean(submission.masterName || "відгук", 28)}`,
      { callback_data: `edit_review:${submission.id}` },
      "primary"
    )]);
  rows.push([telegramButton("Звʼязатися з адміністрацією", { url: telegramAdminUrl() })]);
  return { inline_keyboard: rows };
}

function reviewEditKeyboard(session) {
  const target = session.type === "complaint" ? "Змінити на рекомендацію" : "Змінити на скаргу";
  const style = session.type === "complaint" ? "success" : "danger";
  return {
    inline_keyboard: [
      [telegramButton(target, { callback_data: "edit:toggle_type" }, style)],
      [telegramButton("Скасувати редагування", { callback_data: "edit:cancel" }, "danger")]
    ]
  };
}

function submissionDecisionKeyboard(submission, options = {}) {
  const rows = [];
  if (options.status === "approved" && options.profileUrl) {
    rows.push([telegramButton("Відкрити профіль", { url: options.profileUrl }, "primary")]);
  }
  if (["recommend", "complaint"].includes(submission.type)) {
    rows.push([telegramButton("Змінити відгук", { callback_data: `edit_review:${submission.id}` }, "primary")]);
  }
  if (options.rejectionCode === "spam") {
    rows.push([telegramButton("Стати майстром", { url: siteUrl("/submit", { type: "add", phone: submission.phone }) }, "success")]);
  }
  rows.push([telegramButton("Звʼязатися з адміністрацією", { url: telegramAdminUrl() })]);
  return { inline_keyboard: rows };
}

function categoriesKeyboard() {
  return {
    inline_keyboard: [[telegramButton("Відкрити всі послуги", { url: siteUrl("/#service-categories") }, "primary")]]
  };
}

function blacklistKeyboard() {
  return {
    inline_keyboard: [[telegramButton("Відкрити Black List", { url: siteUrl("/complaints") }, "danger")]]
  };
}

function publicChannelKeyboard() {
  return {
    inline_keyboard: [[telegramButton("Відкрити канал", {
      url: normalizeTelegramLink(TELEGRAM_PUBLIC_URL) || siteUrl("/")
    }, "primary")]]
  };
}

function cancelIntakeKeyboard() {
  return {
    inline_keyboard: [[telegramButton("Скасувати", { callback_data: "intake:cancel" }, "danger")]]
  };
}

function optionalTelegramKeyboard() {
  return {
    inline_keyboard: [
      [telegramButton("Пропустити", { callback_data: "intake:skip_username" }, "primary")],
      [telegramButton("Скасувати", { callback_data: "intake:cancel" }, "danger")]
    ]
  };
}

function authorKeyboard() {
  return {
    inline_keyboard: [
      [telegramButton("Анонімно", { callback_data: "intake:anonymous" }, "primary")],
      [telegramButton("Скасувати", { callback_data: "intake:cancel" }, "danger")]
    ]
  };
}

function photoIntakeKeyboard() {
  return {
    inline_keyboard: [
      [telegramButton("Надіслати на модерацію", { callback_data: "intake:finish" }, "success")],
      [telegramButton("Скасувати", { callback_data: "intake:cancel" }, "danger")]
    ]
  };
}

function notFoundKeyboard(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return {
    inline_keyboard: [
      [
        telegramButton("Рекомендація", { callback_data: `start:recommend:${digits}` }, "success"),
        telegramButton("Скарга", { callback_data: `start:complaint:${digits}` }, "danger")
      ]
    ]
  };
}

function foundKeyboard(phone, profileUrl) {
  const digits = String(phone || "").replace(/\D/g, "");
  return {
    inline_keyboard: [
      [telegramButton("Відкрити профіль", { url: profileUrl }, "primary")],
      [
        telegramButton("Додати рекомендацію", { callback_data: `start:recommend:${digits}` }, "success"),
        telegramButton("Залишити скаргу", { callback_data: `start:complaint:${digits}` }, "danger")
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

function telegramAdminUrl() {
  return TELEGRAM_ADMIN_USERNAME
    ? `https://telegram.me/${TELEGRAM_ADMIN_USERNAME}`
    : telegramBotUrl("contact");
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

async function findLatestModerationEvent(submissionId, status = "") {
  const events = await readJsonLines(MODERATION_EVENTS_FILE);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.submissionId === submissionId && (!status || event.status === status)) {
      return event;
    }
  }
  return null;
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

module.exports = {
  customRejectionKeyboard,
  isSubmissionOwner,
  mainMenuKeyboard,
  normalizeSubmission,
  normalizeTelegramUsername,
  processTelegramUpdate,
  rejectionReasonKeyboard,
  saveSubmission,
  sendTelegram,
  server,
  submissionDecisionKeyboard
};
