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
  const categorySearch = document.querySelector("#category-search-input");
  const recommendedList = document.querySelector("#recommended-list");
  const blacklistList = document.querySelector("#blacklist-list");
  const complaintTicker = document.querySelector("#complaint-ticker");
  const complaintPreview = document.querySelector("#latest-complaints");
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

  const aliases = {
    displayName: ["display_name", "name", "master_name", "team_name"],
    categoryName: ["category_name", "category", "service_category"],
    categoryNames: ["category_names", "categories", "service_categories"],
    telegram: ["telegram_username", "telegram", "tg", "username"],
    positive: ["positive_reviews_count", "recommendations_count", "positive_count"],
    negative: ["negative_reviews_count", "complaints_count", "negative_count"],
    lastReviewAt: ["last_review_at", "last_review", "updated_at"],
    lastReviewText: ["last_review_text", "last_review_summary", "review_text", "comment"],
    masterId: ["master_id", "id"],
    pinned: ["is_pinned", "pinned"]
  };

  let recordsCache = null;

  function normalizePhone(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 9) return `+380${digits}`;
    if (digits.length === 10 && digits.startsWith("0")) return `+38${digits}`;
    if (digits.length === 11 && digits.startsWith("80")) return `+3${digits}`;
    if (digits.length === 12 && digits.startsWith("380")) return `+${digits}`;
    return digits ? `+${digits}` : "";
  }

  function isValidPhone(value) {
    return /^\+380\d{9}$/.test(value);
  }

  function formatPhone(value) {
    const phone = normalizePhone(value);
    const match = phone.match(/^\+380(\d{2})(\d{3})(\d{2})(\d{2})$/);
    return match ? `+380 ${match[1]} ${match[2]} ${match[3]} ${match[4]}` : value || "Не вказано";
  }

  function normalizeKey(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];
      if (char === '"' && quoted && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === "," && !quoted) {
        row.push(cell);
        cell = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && next === "\n") index += 1;
        row.push(cell);
        if (row.some((value) => value.trim())) rows.push(row);
        row = [];
        cell = "";
      } else {
        cell += char;
      }
    }

    row.push(cell);
    if (row.some((value) => value.trim())) rows.push(row);
    if (rows.length < 2) return [];
    const headers = rows.shift().map(normalizeKey);
    return rows.map((cells) => Object.fromEntries(headers.map((header, index) => [header, (cells[index] || "").trim()])));
  }

  function field(record, names) {
    for (const name of names) {
      const value = record[normalizeKey(name)];
      if (value !== undefined && value !== "") return value;
    }
    return "";
  }

  function splitList(value) {
    return String(value || "").split(/[;,|\n]+/).map((item) => item.trim()).filter(Boolean);
  }

  function phones(record) {
    const list = phoneFields.flatMap((name) => splitList(field(record, [name])))
      .map(normalizePhone)
      .filter(isValidPhone);
    return Array.from(new Set(list));
  }

  function categories(record) {
    const list = [
      ...splitList(field(record, aliases.categoryNames)),
      ...splitList(field(record, aliases.categoryName))
    ];
    return Array.from(new Set(list)).filter(Boolean);
  }

  function numberValue(value) {
    const parsed = Number.parseInt(String(value || "0").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function view(record) {
    const recordPhones = phones(record);
    return {
      record,
      id: field(record, aliases.masterId),
      name: field(record, aliases.displayName) || "Без назви",
      categories: categories(record),
      phones: recordPhones,
      primaryPhone: recordPhones[0] || "",
      telegram: field(record, aliases.telegram),
      positive: numberValue(field(record, aliases.positive)),
      negative: numberValue(field(record, aliases.negative)),
      lastReviewAt: field(record, aliases.lastReviewAt),
      lastReviewText: field(record, aliases.lastReviewText),
      pinned: /^(1|true|yes|так)$/i.test(field(record, aliases.pinned))
    };
  }

  async function loadRecords() {
    if (recordsCache) return recordsCache;
    if (!config.phonesCsvUrl) throw new Error("missing_data_url");
    const response = await fetch(config.phonesCsvUrl, { cache: "no-store" });
    if (!response.ok) throw new Error("data_fetch_failed");
    recordsCache = parseCsv(await response.text());
    return recordsCache;
  }

  function telegramAction(kind, phone = "") {
    const configured = links[kind] || links.telegramBot || "https://telegram.me/bl_svitlopark_bot";
    const url = new URL(configured, window.location.origin);
    const action = { recommend: "recommend", complaint: "complaint", addMaster: "add" }[kind];
    if (action) {
      const digits = String(phone || "").replace(/\D/g, "");
      url.searchParams.set("start", digits ? `${action}_${digits}` : action);
    }
    return url.toString();
  }

  function profileLink(master) {
    const url = new URL("/profile", window.location.origin);
    if (master.id) url.searchParams.set("id", master.id);
    else if (master.primaryPhone) url.searchParams.set("phone", master.primaryPhone);
    return `${url.pathname}${url.search}`;
  }

  function applyLinks() {
    document.querySelectorAll("[data-link]").forEach((element) => {
      const key = element.dataset.link;
      const href = ["recommend", "complaint", "addMaster"].includes(key)
        ? telegramAction(key)
        : links[key];
      if (href) element.href = href;
      if (/^https:\/\/telegram\.me\//.test(element.href)) {
        element.target = "_blank";
        element.rel = "noreferrer";
      }
    });
  }

  function seededScore(master) {
    const date = new Date().toISOString().slice(0, 10);
    const value = `${date}:${master.id || master.primaryPhone}`;
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function sortRecommendations(items) {
    return [...items].sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return seededScore(left) - seededScore(right);
    });
  }

  function renderPerson(master, tone) {
    const status = tone === "warning" ? "Є скарги" : "Рекомендують";
    const count = tone === "warning" ? master.negative : master.positive;
    const countLabel = tone === "warning" ? "скарг" : "рекомендацій";
    return `
      <a class="person-row person-row--${tone}" href="${escapeAttribute(profileLink(master))}">
        <div class="person-row__body">
          <span class="person-row__status">${escapeHtml(status)}</span>
          <h3>${escapeHtml(master.name)}</h3>
          <p>${escapeHtml(master.categories.join(" · ") || "Послуги не вказані")}</p>
          ${master.lastReviewText ? `<blockquote>${escapeHtml(master.lastReviewText)}</blockquote>` : ""}
        </div>
        <div class="person-row__meta">
          <strong>${count} ${escapeHtml(countLabel)}</strong>
          <span>${escapeHtml(formatPhone(master.primaryPhone))}</span>
        </div>
      </a>
    `;
  }

  function renderCategories(masters) {
    const counts = new Map();
    masters.forEach((master) => master.categories.forEach((category) => {
      counts.set(category, (counts.get(category) || 0) + 1);
    }));

    const items = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], "uk"));
    if (!items.length) {
      categoriesList.innerHTML = empty("Поки немає послуг у базі.");
      return;
    }

    categoriesList.innerHTML = items.map(([name, count]) => `
      <a class="service-item" href="/services?service=${encodeURIComponent(name)}" data-service-search="${escapeAttribute(normalizeSearch(name))}">
        <strong>${escapeHtml(name)}</strong>
        <span>${count}</span>
      </a>
    `).join("");
  }

  function renderHomepage(records) {
    const masters = records.map(view).filter((master) => master.primaryPhone);
    const recommended = sortRecommendations(masters.filter((master) => master.positive > 0));
    const complaints = [...masters]
      .filter((master) => master.negative > 0)
      .sort((a, b) => String(b.lastReviewAt).localeCompare(String(a.lastReviewAt)));

    renderCategories(masters);
    recommendedList.innerHTML = recommended.length
      ? recommended.slice(0, 6).map((master) => renderPerson(master, "good")).join("")
      : empty("Поки немає схвалених рекомендацій.");
    blacklistList.innerHTML = complaints.length
      ? complaints.slice(0, 6).map((master) => renderPerson(master, "warning")).join("")
      : empty("Поки немає схвалених скарг.");

    if (complaints.length) {
      complaintPreview.hidden = false;
      complaintTicker.innerHTML = complaints.slice(0, 4).map((master) => `
        <a href="${escapeAttribute(profileLink(master))}">
          <strong>${escapeHtml(master.name)}</strong>
          <span>${escapeHtml(formatPhone(master.primaryPhone))}</span>
          <small>${escapeHtml(master.lastReviewText || "Є скарга від мешканця.")}</small>
        </a>
      `).join("");
    } else {
      complaintPreview.hidden = true;
    }

    const servicesCount = new Set(masters.flatMap((master) => master.categories)).size;
    dataSummary.textContent = `${masters.length} ${plural(masters.length, "майстер", "майстри", "майстрів")} · ${servicesCount} ${plural(servicesCount, "послуга", "послуги", "послуг")}`;
  }

  function renderSearchState(kind, phone, master = null) {
    resultPanel.hidden = false;
    if (kind === "loading") {
      resultPanel.innerHTML = `<p class="result-eyebrow">Перевіряємо</p><h2>Шукаємо ${escapeHtml(formatPhone(phone))}</h2>`;
      return;
    }

    if (kind === "invalid") {
      resultPanel.innerHTML = `
        <p class="result-eyebrow result-eyebrow--warning">Перевір номер</p>
        <h2>Введи номер у форматі +380 XX XXX XX XX.</h2>
        <p>Пробіли, дужки та дефіси можна залишити.</p>
      `;
      return;
    }

    if (kind === "not-found") {
      resultPanel.innerHTML = `
        <p class="result-eyebrow">Не знайдено</p>
        <h2>Майстра з таким номером поки немає в базі.</h2>
        <p>Перевірений номер: ${escapeHtml(formatPhone(phone))}</p>
        <div class="result-actions">
          <a class="primary-result-action" href="${escapeAttribute(telegramAction("recommend", phone))}">Залишити рекомендацію</a>
          <a class="warning-action" href="${escapeAttribute(telegramAction("complaint", phone))}">Залишити скаргу</a>
          <a href="${escapeAttribute(telegramAction("addMaster", phone))}">Стати майстром</a>
        </div>
      `;
      return;
    }

    if (kind === "found" && master) {
      const status = master.negative > 0
        ? "Є скарги"
        : master.positive > 0
          ? "Є позитивні відгуки"
          : "Мало інформації";
      resultPanel.innerHTML = `
        <p class="result-eyebrow">Знайдено майстра</p>
        <div class="result-found-head">
          <h2>${escapeHtml(master.name)}</h2>
          <span class="status-pill ${master.negative > 0 ? "status-pill--warning" : "status-pill--good"}">${escapeHtml(status)}</span>
        </div>
        <dl class="result-details">
          <div><dt>Послуги</dt><dd>${escapeHtml(master.categories.join(" · ") || "Не вказано")}</dd></div>
          <div><dt>Телефони</dt><dd>${escapeHtml(master.phones.map(formatPhone).join(", "))}</dd></div>
          ${master.telegram ? `<div><dt>Telegram</dt><dd>${escapeHtml(master.telegram)}</dd></div>` : ""}
          <div><dt>Відгуки</dt><dd>${master.positive} рекомендацій · ${master.negative} скарг</dd></div>
        </dl>
        <div class="result-actions">
          <a class="primary-result-action" href="${escapeAttribute(profileLink(master))}">Відкрити профіль</a>
          <a href="${escapeAttribute(telegramAction("recommend", phone))}">Додати рекомендацію</a>
          <a class="warning-action" href="${escapeAttribute(telegramAction("complaint", phone))}">Залишити скаргу</a>
        </div>
      `;
      return;
    }

    resultPanel.innerHTML = `<p class="result-eyebrow result-eyebrow--warning">Помилка</p><h2>Не вдалося завантажити базу.</h2><p>Спробуй ще раз трохи пізніше.</p>`;
  }

  async function search(phone) {
    const scrollPosition = { x: window.scrollX, y: window.scrollY };
    renderSearchState("loading", phone);
    searchButton.disabled = true;
    try {
      const records = await loadRecords();
      const record = records.find((item) => phones(item).includes(phone));
      renderSearchState(record ? "found" : "not-found", phone, record ? view(record) : null);
    } catch (error) {
      renderSearchState("error", phone);
    } finally {
      searchButton.disabled = false;
      window.requestAnimationFrame(() => {
        window.scrollTo(scrollPosition.x, scrollPosition.y);
      });
    }
  }

  function normalizeSearch(value) {
    return String(value || "").trim().toLowerCase().replace(/ґ/g, "г").replace(/\s+/g, " ");
  }

  function empty(message) {
    return `<p class="empty-list">${escapeHtml(message)}</p>`;
  }

  function plural(number, one, few, many) {
    const value = Math.abs(number) % 100;
    const last = value % 10;
    if (value > 10 && value < 20) return many;
    if (last === 1) return one;
    if (last >= 2 && last <= 4) return few;
    return many;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const phone = normalizePhone(input.value);
    if (!isValidPhone(phone)) {
      renderSearchState("invalid", phone);
      input.focus();
      return;
    }
    input.value = formatPhone(phone);
    search(phone);
  });

  input?.addEventListener("blur", () => {
    const phone = normalizePhone(input.value);
    if (isValidPhone(phone)) input.value = formatPhone(phone);
  });

  categorySearch?.addEventListener("input", () => {
    const query = normalizeSearch(categorySearch.value);
    categoriesList.querySelectorAll(".service-item").forEach((item) => {
      item.hidden = Boolean(query) && !item.dataset.serviceSearch.includes(query);
    });
  });

  menuButton?.addEventListener("click", () => {
    const open = siteMenu.hidden;
    siteMenu.hidden = !open;
    menuButton.setAttribute("aria-expanded", String(open));
  });

  document.addEventListener("click", (event) => {
    if (!siteMenu || siteMenu.hidden || siteMenu.contains(event.target) || menuButton.contains(event.target)) return;
    siteMenu.hidden = true;
    menuButton.setAttribute("aria-expanded", "false");
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && siteMenu && !siteMenu.hidden) {
      siteMenu.hidden = true;
      menuButton.setAttribute("aria-expanded", "false");
    }
  });

  async function boot() {
    applyLinks();
    try {
      const records = await loadRecords();
      renderHomepage(records);
    } catch (error) {
      categoriesList.innerHTML = empty("Не вдалося завантажити послуги.");
      recommendedList.innerHTML = empty("Не вдалося завантажити рекомендації.");
      blacklistList.innerHTML = empty("Не вдалося завантажити скарги.");
      dataSummary.textContent = "База тимчасово недоступна.";
    }

    const queryPhone = normalizePhone(new URLSearchParams(window.location.search).get("phone"));
    if (isValidPhone(queryPhone)) {
      input.value = formatPhone(queryPhone);
      search(queryPhone);
    }
  }

  boot();
})();
