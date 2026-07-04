(function () {
  const config = window.CHSP_CONFIG || {};
  const links = config.links || {};

  const form = document.querySelector("#phone-search-form");
  const input = document.querySelector("#phone-input");
  const searchButton = document.querySelector("#search-button");
  const resultPanel = document.querySelector("#result-panel");

  const phoneFields = [
    "primary_phone",
    "phone",
    "phone_number",
    "normalized_phone",
    "phone_normalized"
  ];

  const fieldAliases = {
    displayName: ["display_name", "name", "master_name", "team_name"],
    categoryName: ["category_name", "category", "service_category"],
    primaryPhone: phoneFields,
    telegramUsername: ["telegram_username", "telegram", "tg", "username"],
    positiveReviewsCount: ["positive_reviews_count", "recommendations_count", "positive_count"],
    negativeReviewsCount: ["negative_reviews_count", "complaints_count", "negative_count"],
    lastReviewAt: ["last_review_at", "last_review", "updated_at"],
    profileUrl: ["profile_url", "url", "master_url"],
    masterId: ["master_id", "id"]
  };

  let phonesCache = null;

  function normalizePhone(value) {
    const digits = String(value || "").replace(/\D/g, "");

    if (!digits) {
      return "";
    }

    if (digits.length === 12 && digits.startsWith("380")) {
      return `+${digits}`;
    }

    if (digits.length === 10 && digits.startsWith("0")) {
      return `+38${digits}`;
    }

    if (digits.length === 11 && digits.startsWith("80")) {
      return `+3${digits}`;
    }

    if (digits.length === 9) {
      return `+380${digits}`;
    }

    return digits.startsWith("380") ? `+${digits}` : `+${digits}`;
  }

  function isValidUkrainianPhone(phone) {
    return /^\+380\d{9}$/.test(phone);
  }

  function formatPhone(phone) {
    const normalized = normalizePhone(phone);
    const match = normalized.match(/^\+380(\d{2})(\d{3})(\d{2})(\d{2})$/);

    if (!match) {
      return phone || "Не вказано";
    }

    return `+380 ${match[1]} ${match[2]} ${match[3]} ${match[4]}`;
  }

  function parseCsv(csvText) {
    const rows = [];
    let row = [];
    let cell = "";
    let insideQuotes = false;

    for (let i = 0; i < csvText.length; i += 1) {
      const char = csvText[i];
      const nextChar = csvText[i + 1];

      if (char === '"' && insideQuotes && nextChar === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        insideQuotes = !insideQuotes;
      } else if (char === "," && !insideQuotes) {
        row.push(cell);
        cell = "";
      } else if ((char === "\n" || char === "\r") && !insideQuotes) {
        if (char === "\r" && nextChar === "\n") {
          i += 1;
        }
        row.push(cell);
        if (row.some((value) => value.trim() !== "")) {
          rows.push(row);
        }
        row = [];
        cell = "";
      } else {
        cell += char;
      }
    }

    row.push(cell);
    if (row.some((value) => value.trim() !== "")) {
      rows.push(row);
    }

    return rows;
  }

  function normalizeKey(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_");
  }

  function csvToObjects(csvText) {
    const rows = parseCsv(csvText);

    if (rows.length < 2) {
      return [];
    }

    const headers = rows[0].map(normalizeKey);

    return rows.slice(1).map((row) => {
      return headers.reduce((record, header, index) => {
        record[header] = (row[index] || "").trim();
        return record;
      }, {});
    });
  }

  function getField(record, keys) {
    for (const key of keys) {
      const value = record[normalizeKey(key)];
      if (value !== undefined && value !== "") {
        return value;
      }
    }

    return "";
  }

  function toNumber(value) {
    const number = Number.parseInt(String(value || "0").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(number) ? number : 0;
  }

  function getMasterStatus(master) {
    const positive = toNumber(getField(master, fieldAliases.positiveReviewsCount));
    const negative = toNumber(getField(master, fieldAliases.negativeReviewsCount));

    if (negative > 0) {
      return {
        label: "⚠️ Є скарги",
        className: "status-pill--warning"
      };
    }

    if (positive > 0) {
      return {
        label: "✅ Є позитивні відгуки",
        className: "status-pill--good"
      };
    }

    return {
      label: "ℹ️ Мало інформації",
      className: "status-pill--info"
    };
  }

  async function loadPhones() {
    if (phonesCache) {
      return phonesCache;
    }

    if (!config.phonesCsvUrl) {
      throw new Error("missing_sheet_url");
    }

    const response = await fetch(config.phonesCsvUrl, {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error("sheet_fetch_failed");
    }

    phonesCache = csvToObjects(await response.text());
    return phonesCache;
  }

  function findMasterByPhone(records, normalizedPhone) {
    return records.find((record) => {
      return phoneFields.some((field) => {
        const value = getField(record, [field]);
        return normalizePhone(value) === normalizedPhone;
      });
    });
  }

  function buildLink(kind, phone, master) {
    const configuredLink = links[kind];

    if (configuredLink && configuredLink !== "#") {
      const url = new URL(configuredLink, window.location.href);
      if (phone) {
        url.searchParams.set("phone", phone);
      }
      return url.toString();
    }

    if (kind === "profile") {
      const profileUrl = getField(master || {}, fieldAliases.profileUrl);
      const masterId = getField(master || {}, fieldAliases.masterId);

      if (profileUrl) {
        return profileUrl;
      }

      if (masterId) {
        return `profile.html?id=${encodeURIComponent(masterId)}`;
      }

      return `profile.html?phone=${encodeURIComponent(phone)}`;
    }

    return "#";
  }

  function renderLoading(phone) {
    resultPanel.hidden = false;
    resultPanel.innerHTML = `
      <p class="result-eyebrow">Пошук</p>
      <h2 class="result-title">Перевіряємо ${escapeHtml(formatPhone(phone))}</h2>
      <p class="result-message">Шукаємо номер у листі Phones.</p>
    `;
  }

  function renderNotFound(phone) {
    resultPanel.hidden = false;
    resultPanel.innerHTML = `
      <p class="result-eyebrow">Не знайдено</p>
      <h2 class="result-title">Майстра з таким номером поки немає в базі.</h2>
      <p class="result-message">Перевірений номер: ${escapeHtml(formatPhone(phone))}</p>
      <div class="result-actions">
        <a class="primary-result-action" href="${escapeAttribute(buildLink("addMaster", phone))}">➕ Додати майстра</a>
        <a class="good-action" href="${escapeAttribute(buildLink("recommend", phone))}">✅ Залишити рекомендацію</a>
        <a class="warning-action" href="${escapeAttribute(buildLink("complaint", phone))}">⚠️ Залишити скаргу</a>
      </div>
    `;
  }

  function renderFound(master, phone) {
    const displayName = getField(master, fieldAliases.displayName) || "Без назви";
    const categoryName = getField(master, fieldAliases.categoryName) || "Категорія не вказана";
    const masterPhone = getField(master, fieldAliases.primaryPhone) || phone;
    const telegram = getField(master, fieldAliases.telegramUsername) || "Не вказано";
    const positive = getField(master, fieldAliases.positiveReviewsCount) || "0";
    const negative = getField(master, fieldAliases.negativeReviewsCount) || "0";
    const lastReview = getField(master, fieldAliases.lastReviewAt) || "Ще немає";
    const status = getMasterStatus(master);

    resultPanel.hidden = false;
    resultPanel.innerHTML = `
      <p class="result-eyebrow">Знайдено майстра</p>
      <h2 class="result-title">${escapeHtml(displayName)}</h2>
      <div class="master-grid">
        ${renderField("Імʼя", displayName)}
        ${renderField("Категорія", categoryName)}
        ${renderField("Телефон", formatPhone(masterPhone))}
        ${renderField("Telegram", telegram)}
        ${renderField("Рекомендацій", positive)}
        ${renderField("Скарг", negative)}
        ${renderField("Останній відгук", lastReview)}
        <div class="master-field">
          <span>Статус</span>
          <strong class="status-pill ${status.className}">${escapeHtml(status.label)}</strong>
        </div>
      </div>
      <div class="result-actions">
        <a class="primary-result-action" href="${escapeAttribute(buildLink("profile", phone, master))}">👤 Відкрити профіль</a>
        <a class="good-action" href="${escapeAttribute(buildLink("recommend", phone, master))}">✅ Додати рекомендацію</a>
        <a class="warning-action" href="${escapeAttribute(buildLink("complaint", phone, master))}">⚠️ Залишити скаргу</a>
      </div>
    `;
  }

  function renderField(label, value) {
    return `
      <div class="master-field">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value || "Не вказано")}</strong>
      </div>
    `;
  }

  function renderError(error) {
    const isMissingSheet = error.message === "missing_sheet_url";
    resultPanel.hidden = false;
    resultPanel.innerHTML = `
      <p class="result-eyebrow">Пошук недоступний</p>
      <h2 class="result-title">${
        isMissingSheet
          ? "Google Sheets ще не підключено."
          : "Не вдалося отримати дані з Google Sheets."
      }</h2>
      <p class="result-message">${
        isMissingSheet
          ? "Додай CSV-посилання листа Phones у config.js."
          : "Спробуй ще раз трохи пізніше або перевір публічний доступ до листа Phones."
      }</p>
    `;
  }

  function renderInvalidPhone() {
    resultPanel.hidden = false;
    resultPanel.innerHTML = `
      <p class="result-eyebrow">Перевір номер</p>
      <h2 class="result-title">Введи номер у форматі +380 XX XXX XX XX.</h2>
      <p class="result-message">Пробіли, дужки та дефіси можна залишити — ми очистимо їх автоматично.</p>
    `;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  function wireStaticLinks() {
    document.querySelectorAll("[data-link]").forEach((element) => {
      const key = element.getAttribute("data-link");
      if (links[key]) {
        element.setAttribute("href", links[key]);
      }
    });
  }

  async function handleSearch(event) {
    event.preventDefault();

    const normalizedPhone = normalizePhone(input.value);

    if (!isValidUkrainianPhone(normalizedPhone)) {
      renderInvalidPhone();
      input.focus();
      return;
    }

    input.value = formatPhone(normalizedPhone);
    searchButton.disabled = true;
    searchButton.textContent = "Перевіряємо...";
    renderLoading(normalizedPhone);

    try {
      const records = await loadPhones();
      const master = findMasterByPhone(records, normalizedPhone);

      if (master) {
        renderFound(master, normalizedPhone);
      } else {
        renderNotFound(normalizedPhone);
      }
    } catch (error) {
      renderError(error);
    } finally {
      searchButton.disabled = false;
      searchButton.textContent = "Перевірити майстра";
    }
  }

  wireStaticLinks();
  form.addEventListener("submit", handleSearch);
})();
