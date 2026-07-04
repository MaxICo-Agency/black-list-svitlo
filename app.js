(function () {
  const config = window.CHSP_CONFIG || {};
  const links = config.links || {};

  const form = document.querySelector("#phone-search-form");
  const input = document.querySelector("#phone-input");
  const searchButton = document.querySelector("#search-button");
  const resultPanel = document.querySelector("#result-panel");
  const menuButton = document.querySelector("#menu-button");
  const siteMenu = document.querySelector("#site-menu");
  const categoriesList = document.querySelector("#categories-list");
  const recommendedList = document.querySelector("#recommended-list");
  const blacklistList = document.querySelector("#blacklist-list");
  const dataSummary = document.querySelector("#data-summary");

  const phoneFields = [
    "primary_phone",
    "phone",
    "phone_number",
    "phones",
    "phone_numbers",
    "all_phones",
    "alternate_phones",
    "normalized_phone",
    "phone_normalized"
  ];

  const fieldAliases = {
    displayName: ["display_name", "name", "master_name", "team_name"],
    categoryName: ["category_name", "category", "service_category"],
    categoryNames: ["category_names", "categories", "service_categories"],
    primaryPhone: phoneFields,
    telegramUsername: ["telegram_username", "telegram", "tg", "username"],
    positiveReviewsCount: ["positive_reviews_count", "recommendations_count", "positive_count"],
    negativeReviewsCount: ["negative_reviews_count", "complaints_count", "negative_count"],
    lastReviewAt: ["last_review_at", "last_review", "updated_at"],
    lastReviewText: ["last_review_text", "last_review_summary", "review_text", "comment"],
    workPhotoUrl: ["work_photo_url", "photo_url", "image_url", "portfolio_photo_url"],
    profileUrl: ["profile_url", "url", "master_url"],
    masterId: ["master_id", "id"]
  };

  const categoryIcons = [
    { match: "елект", icon: "⚡" },
    { match: "сант", icon: "🚿" },
    { match: "плит", icon: "▧" },
    { match: "ремонт", icon: "🛠" },
    { match: "фарб", icon: "◒" },
    { match: "маляр", icon: "◒" },
    { match: "меб", icon: "▤" },
    { match: "вікн", icon: "▣" },
    { match: "балкон", icon: "▣" },
    { match: "кондиц", icon: "❄" },
    { match: "приби", icon: "✦" },
    { match: "дизайн", icon: "◇" },
    { match: "двер", icon: "▥" },
    { match: "звуко", icon: "≋" }
  ];

  const categoryPhotos = [
    { match: "елект", src: "assets/work/electric.svg" },
    { match: "сант", src: "assets/work/plumbing.svg" },
    { match: "плит", src: "assets/work/tile.svg" },
    { match: "ремонт", src: "assets/work/renovation.svg" },
    { match: "фарб", src: "assets/work/painting.svg" },
    { match: "маляр", src: "assets/work/painting.svg" },
    { match: "меб", src: "assets/work/furniture.svg" },
    { match: "вікн", src: "assets/work/windows.svg" },
    { match: "балкон", src: "assets/work/windows.svg" },
    { match: "кондиц", src: "assets/work/climate.svg" },
    { match: "приби", src: "assets/work/cleaning.svg" },
    { match: "дизайн", src: "assets/work/design.svg" },
    { match: "двер", src: "assets/work/doors.svg" },
    { match: "звуко", src: "assets/work/acoustic.svg" }
  ];

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

  function splitList(value) {
    return String(value || "")
      .split(/[\n;|,/]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function getPhones(record) {
    const values = phoneFields.flatMap((field) => splitList(getField(record, [field])));
    const normalized = values.map(normalizePhone).filter(isValidUkrainianPhone);

    return Array.from(new Set(normalized));
  }

  function getCategories(record) {
    const values = [
      ...splitList(getField(record, fieldAliases.categoryNames)),
      ...splitList(getField(record, fieldAliases.categoryName))
    ].filter(Boolean);

    return Array.from(new Set(values)).length ? Array.from(new Set(values)) : ["Категорія не вказана"];
  }

  function toNumber(value) {
    const number = Number.parseInt(String(value || "0").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(number) ? number : 0;
  }

  function toDateValue(value) {
    const date = new Date(value);
    const time = date.getTime();
    return Number.isFinite(time) ? time : 0;
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
    return records.find((record) => getPhones(record).includes(normalizedPhone));
  }

  function getMasterView(record) {
    const displayName = getField(record, fieldAliases.displayName) || "Без назви";
    const categories = getCategories(record);
    const categoryName = categories[0];
    const phones = getPhones(record);
    const primaryPhone = phones[0] || normalizePhone(getField(record, fieldAliases.primaryPhone));
    const positive = toNumber(getField(record, fieldAliases.positiveReviewsCount));
    const negative = toNumber(getField(record, fieldAliases.negativeReviewsCount));

    return {
      record,
      displayName,
      categories,
      categoryName,
      phones,
      primaryPhone,
      telegramUsername: getField(record, fieldAliases.telegramUsername),
      positive,
      negative,
      lastReviewAt: getField(record, fieldAliases.lastReviewAt) || "Ще немає",
      lastReviewText: getField(record, fieldAliases.lastReviewText),
      workPhotoUrl: getWorkPhotoUrl(record, categoryName),
      profileUrl: buildLink("profile", normalizePhone(primaryPhone), record)
    };
  }

  function renderHomepageData(records) {
    const masters = records.map(getMasterView);
    const categoryMap = masters.reduce((map, master) => {
      master.categories.forEach((categoryName) => {
        const current = map.get(categoryName) || {
          name: categoryName,
          total: 0,
          positive: 0,
          negative: 0
        };

        current.total += 1;
        current.positive += master.positive;
        current.negative += master.negative;
        map.set(categoryName, current);
      });

      return map;
    }, new Map());

    const categories = Array.from(categoryMap.values()).sort((a, b) => b.total - a.total);
    const recommended = masters
      .filter((master) => master.positive > 0 && master.negative === 0)
      .sort((a, b) => b.positive - a.positive || toDateValue(b.lastReviewAt) - toDateValue(a.lastReviewAt))
      .slice(0, 6);
    const blacklist = masters
      .filter((master) => master.negative > 0)
      .sort((a, b) => toDateValue(b.lastReviewAt) - toDateValue(a.lastReviewAt) || b.negative - a.negative)
      .slice(0, 6);

    dataSummary.textContent = `${records.length} тестових записів у базі. Пошук і списки читають один лист Phones.`;
    categoriesList.innerHTML = categories.map(renderCategoryCard).join("");
    recommendedList.innerHTML = recommended.length
      ? recommended.map((master) => renderPersonCard(master)).join("")
      : renderEmptyList("Поки немає майстрів із позитивними рекомендаціями.");
    blacklistList.innerHTML = blacklist.length
      ? blacklist.map((master) => renderPersonRow(master, "warning")).join("")
      : renderEmptyList("Поки немає записів зі скаргами.");
  }

  function renderCategoryCard(category) {
    return `
      <a class="category-card" href="#recommended-title" data-category="${escapeAttribute(category.name)}">
        <span class="category-icon" aria-hidden="true">${escapeHtml(getCategoryIcon(category.name))}</span>
        <strong>${escapeHtml(category.name)}</strong>
        <span>${category.total} ${pluralize(category.total, "майстер", "майстри", "майстрів")}</span>
        <small>${category.positive} рек. · ${category.negative} скарг</small>
      </a>
    `;
  }

  function renderPersonCard(master) {
    const phoneLabel = master.primaryPhone ? formatPhone(master.primaryPhone) : "Телефон не вказано";
    const reviewText = master.lastReviewText || "Є позитивні відгуки від мешканців.";

    return `
      <article class="person-card">
        <img src="${escapeAttribute(master.workPhotoUrl)}" alt="${escapeAttribute(`Робота: ${master.categoryName}`)}" loading="lazy" />
        <div class="person-card-body">
          <div>
            <h3>${escapeHtml(master.displayName)}</h3>
            <p>${escapeHtml(master.categories.join(" · "))}</p>
          </div>
          <div class="person-score">
            <span>${master.positive} ${pluralize(master.positive, "рекомендація", "рекомендації", "рекомендацій")}</span>
            <span>${master.negative} ${pluralize(master.negative, "скарга", "скарги", "скарг")}</span>
          </div>
          <small>${escapeHtml(reviewText)}</small>
          <a href="${escapeAttribute(buildLink("profile", master.primaryPhone, master.record))}">${escapeHtml(phoneLabel)}</a>
        </div>
      </article>
    `;
  }

  function renderPersonRow(master, tone) {
    const isWarning = tone === "warning";
    const reviewsLine = isWarning
      ? `${master.negative} ${pluralize(master.negative, "скарга", "скарги", "скарг")}`
      : `${master.positive} ${pluralize(master.positive, "рекомендація", "рекомендації", "рекомендацій")}`;
    const reviewText = master.lastReviewText || (isWarning ? "Є скарги від мешканців." : "Є позитивні відгуки від мешканців.");

    return `
      <article class="person-row person-row--${tone}">
        <div>
          <h3>${escapeHtml(master.displayName)}</h3>
          <p>${escapeHtml(master.categories.join(" · "))} · ${escapeHtml(formatPhone(master.primaryPhone))}</p>
          <small>${escapeHtml(reviewText)}</small>
        </div>
        <div class="person-meta">
          <strong>${escapeHtml(reviewsLine)}</strong>
          <span>${escapeHtml(master.lastReviewAt)}</span>
        </div>
      </article>
    `;
  }

  function renderEmptyList(message) {
    return `<p class="empty-list">${escapeHtml(message)}</p>`;
  }

  function renderHomepageLoading() {
    dataSummary.textContent = "Завантажуємо тестові дані з листа Phones.";
    categoriesList.innerHTML = renderEmptyList("Завантажуємо категорії...");
    recommendedList.innerHTML = renderEmptyList("Завантажуємо рекомендації...");
    blacklistList.innerHTML = renderEmptyList("Завантажуємо black list...");
  }

  function renderHomepageError(error) {
    const message = error.message === "missing_sheet_url"
      ? "Потрібно додати CSV URL листа Phones у config.js."
      : "Не вдалося завантажити лист Phones.";

    dataSummary.textContent = message;
    categoriesList.innerHTML = renderEmptyList(message);
    recommendedList.innerHTML = renderEmptyList(message);
    blacklistList.innerHTML = renderEmptyList(message);
  }

  function pluralize(number, one, few, many) {
    const normalized = Math.abs(number) % 100;
    const lastDigit = normalized % 10;

    if (normalized > 10 && normalized < 20) {
      return many;
    }

    if (lastDigit === 1) {
      return one;
    }

    if (lastDigit >= 2 && lastDigit <= 4) {
      return few;
    }

    return many;
  }

  function getCategoryIcon(categoryName) {
    const normalized = String(categoryName || "").toLowerCase();
    const match = categoryIcons.find((item) => normalized.includes(item.match));
    return match ? match.icon : "◆";
  }

  function getWorkPhotoUrl(record, categoryName) {
    const configuredPhoto = getField(record, fieldAliases.workPhotoUrl);

    if (configuredPhoto) {
      return configuredPhoto;
    }

    const normalized = String(categoryName || "").toLowerCase();
    const match = categoryPhotos.find((item) => normalized.includes(item.match));

    return match ? match.src : "assets/work/default.svg";
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
    showResultPanel();
  }

  function renderNotFound(phone) {
    resultPanel.hidden = false;
    resultPanel.innerHTML = `
      <p class="result-eyebrow">Не знайдено</p>
      <h2 class="result-title">Майстра з таким номером поки немає в базі.</h2>
      <p class="result-message">Перевірений номер: ${escapeHtml(formatPhone(phone))}</p>
      <div class="result-actions">
        <a class="primary-result-action good-action" href="${escapeAttribute(buildLink("recommend", phone))}">✅ Залишити рекомендацію</a>
        <a class="warning-action" href="${escapeAttribute(buildLink("complaint", phone))}">⚠️ Залишити скаргу</a>
      </div>
    `;
    showResultPanel();
  }

  function renderFound(master, phone) {
    const view = getMasterView(master);
    const displayName = view.displayName;
    const categoryName = view.categories.join(" · ");
    const masterPhone = view.primaryPhone || phone;
    const telegram = view.telegramUsername || "Не вказано";
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
        ${renderField("Категорії", categoryName)}
        ${renderField("Телефон", formatPhone(masterPhone))}
        ${view.phones.length > 1 ? renderField("Інші номери", view.phones.slice(1).map(formatPhone).join(", ")) : ""}
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
    showResultPanel();
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
    showResultPanel();
  }

  function renderInvalidPhone() {
    resultPanel.hidden = false;
    resultPanel.innerHTML = `
      <p class="result-eyebrow">Перевір номер</p>
      <h2 class="result-title">Введи номер у форматі +380 XX XXX XX XX.</h2>
      <p class="result-message">Пробіли, дужки та дефіси можна залишити — ми очистимо їх автоматично.</p>
    `;
    showResultPanel();
  }

  function showResultPanel() {
    resultPanel.hidden = false;
    resultPanel.classList.add("result-panel--active");
    resultPanel.scrollIntoView({ block: "nearest", behavior: "smooth" });
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

  function closeMenu() {
    siteMenu.hidden = true;
    menuButton.setAttribute("aria-expanded", "false");
  }

  function toggleMenu() {
    const shouldOpen = siteMenu.hidden;
    siteMenu.hidden = !shouldOpen;
    menuButton.setAttribute("aria-expanded", String(shouldOpen));
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

  async function bootHomepage() {
    renderHomepageLoading();

    try {
      renderHomepageData(await loadPhones());
    } catch (error) {
      renderHomepageError(error);
    }
  }

  wireStaticLinks();
  form.addEventListener("submit", handleSearch);
  menuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMenu();
  });
  document.addEventListener("click", (event) => {
    if (!siteMenu.hidden && !siteMenu.contains(event.target) && event.target !== menuButton) {
      closeMenu();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenu();
    }
  });
  bootHomepage();
})();
