const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const STATIC_DIR = __dirname;
const RUNTIME_DIR = process.env.RUNTIME_DIR || path.join(__dirname, "runtime");
const SUBMISSIONS_FILE = path.join(RUNTIME_DIR, "submissions.jsonl");
const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || "https://bl-svitlopark.maxicolabs.com";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

const allowedTypes = new Set(["recommend", "complaint", "add", "bot", "channel"]);

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, PUBLIC_SITE_URL);

    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, { ok: true, service: "bl-svitlopark" });
    }

    if (url.pathname === "/api/submissions") {
      return handleSubmission(request, response);
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
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
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

  try {
    const telegramResponse = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true
      })
    });

    if (!telegramResponse.ok) {
      const text = await telegramResponse.text();
      console.warn(`Telegram send failed: ${telegramResponse.status} ${text.slice(0, 160)}`);
      return { sent: false };
    }

    return { sent: true };
  } catch (error) {
    console.warn(`Telegram send failed: ${error.message}`);
    return { sent: false };
  }
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
    "Cache-Control": extension === ".html" || extension === ".js" ? "no-cache" : "public, max-age=3600"
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
    add: "Додати майстра",
    bot: "Telegram-бот",
    channel: "Telegram-канал"
  };

  return labels[type] || type;
}
