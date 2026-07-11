(function () {
  const config = window.CHSP_CONFIG || {};
  const links = config.links || {};
  const root = document.querySelector("#profile-root");

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
    masterId: ["master_id", "id"],
    displayName: ["display_name", "name", "master_name", "team_name"],
    categoryName: ["category_name", "category", "service_category"],
    categoryNames: ["category_names", "categories", "service_categories"],
    telegramUsername: ["telegram_username", "telegram", "tg", "username"],
    positiveReviewsCount: ["positive_reviews_count", "recommendations_count", "positive_count"],
    negativeReviewsCount: ["negative_reviews_count", "complaints_count", "negative_count"],
    lastReviewAt: ["last_review_at", "last_review", "updated_at"],
    lastReviewText: ["last_review_text", "last_review_summary", "review_text", "comment"],
    masterPhotoUrl: ["master_photo_url", "telegram_photo_url", "avatar_url", "photo_url"],
    workPhotoUrl: ["work_photo_url", "image_url", "portfolio_photo_url"],
    workPhotoUrls: ["work_photo_urls", "portfolio_photo_urls", "photo_urls"]
  };

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
    return match ? `+380 ${match[1]} ${match[2]} ${match[3]} ${match[4]}` : phone || "Не вказано";
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
    return String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
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
      .split(/[\n;|]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function toNumber(value) {
    const number = Number.parseInt(String(value || "0").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(number) ? number : 0;
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

    const unique = Array.from(new Set(values));
    return unique.length ? unique : ["Категорія не вказана"];
  }

  function getWorkPhotos(record, categories) {
    const configured = [
      ...splitList(getField(record, fieldAliases.workPhotoUrls)),
      ...splitList(getField(record, fieldAliases.workPhotoUrl))
    ];

    if (configured.length) {
      return Array.from(new Set(configured));
    }

    const generated = categories.map((category) => getFallbackPhoto(category));
    return Array.from(new Set(generated)).slice(0, 4);
  }

  function getFallbackPhoto(categoryName) {
    const normalized = String(categoryName || "").toLowerCase();
    const match = categoryPhotos.find((item) => normalized.includes(item.match));
    return match ? match.src : "assets/work/default.svg";
  }

  function getStatus(record) {
    const positive = toNumber(getField(record, fieldAliases.positiveReviewsCount));
    const negative = toNumber(getField(record, fieldAliases.negativeReviewsCount));

    if (negative > 0) {
      return { label: "⚠️ Є скарги", className: "status-pill--warning" };
    }

    if (positive > 0) {
      return { label: "✅ Є позитивні відгуки", className: "status-pill--good" };
    }

    return { label: "ℹ️ Мало інформації", className: "status-pill--info" };
  }

  function getReviews(record) {
    const reviews = [];

    for (let index = 1; index <= 5; index += 1) {
      const text = getField(record, [`review_${index}_text`]);
      const author = getField(record, [`review_${index}_author`]);
      const type = getField(record, [`review_${index}_type`]);
      const date = getField(record, [`review_${index}_date`]);
      const photoUrl = getField(record, [`review_${index}_photo_url`]);

      if (text) {
        reviews.push({
          author: author || "Анонімно",
          type: type || "review",
          date: date || getField(record, fieldAliases.lastReviewAt) || "Дата не вказана",
          text,
          photoUrl
        });
      }
    }

    if (!reviews.length && getField(record, fieldAliases.lastReviewText)) {
      reviews.push({
        author: "Анонімно",
        type: toNumber(getField(record, fieldAliases.negativeReviewsCount)) > 0 ? "complaint" : "recommendation",
        date: getField(record, fieldAliases.lastReviewAt) || "Дата не вказана",
        text: getField(record, fieldAliases.lastReviewText),
        photoUrl: ""
      });
    }

    return reviews;
  }

  async function loadRecords() {
    if (!config.phonesCsvUrl) {
      throw new Error("missing_sheet_url");
    }

    const response = await fetch(config.phonesCsvUrl, { cache: "no-store" });

    if (!response.ok) {
      throw new Error("sheet_fetch_failed");
    }

    return csvToObjects(await response.text());
  }

  function buildActionLink(kind, phone) {
    const configuredLink = links[kind];

    if (configuredLink && configuredLink !== "#") {
      const url = new URL(configuredLink, window.location.href);
      if (phone) {
        url.searchParams.set("phone", phone);
      }
      return url.toString();
    }

    return "#";
  }

  function findProfile(records) {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    const phone = normalizePhone(params.get("phone"));

    if (id) {
      const byId = records.find((record) => getField(record, fieldAliases.masterId) === id);
      if (byId) {
        return byId;
      }
    }

    if (phone) {
      return records.find((record) => getPhones(record).includes(phone));
    }

    return null;
  }

  function renderProfile(record) {
    const name = getField(record, fieldAliases.displayName) || "Без назви";
    const categories = getCategories(record);
    const phones = getPhones(record);
    const primaryPhone = phones[0] || "";
    const telegram = getField(record, fieldAliases.telegramUsername);
    const positive = toNumber(getField(record, fieldAliases.positiveReviewsCount));
    const negative = toNumber(getField(record, fieldAliases.negativeReviewsCount));
    const status = getStatus(record);
    const masterPhoto = getField(record, fieldAliases.masterPhotoUrl);
    const workPhotos = getWorkPhotos(record, categories);
    const reviews = getReviews(record);

    document.title = `${name} | Black List Світло парк`;

    root.innerHTML = `
      <section class="profile-hero">
        <div class="profile-avatar">
          ${masterPhoto ? `<img src="${escapeAttribute(masterPhoto)}" alt="${escapeAttribute(name)}" />` : `<span>${escapeHtml(getInitials(name))}</span>`}
        </div>
        <div class="profile-main">
          <p class="result-eyebrow">Профіль майстра</p>
          <h1>${escapeHtml(name)}</h1>
          <div class="profile-tags">
            ${categories.map((category) => `<a href="category.html?service=${encodeURIComponent(category)}">${escapeHtml(category)}</a>`).join("")}
          </div>
          <strong class="status-pill ${status.className}">${escapeHtml(status.label)}</strong>
        </div>
      </section>

      <section class="profile-grid">
        <article class="profile-card">
          <h2>Контакти</h2>
          <div class="profile-list">
            ${phones.map((phone) => `<a href="tel:${escapeAttribute(phone)}">${escapeHtml(formatPhone(phone))}</a>`).join("") || "<p>Телефон не вказано</p>"}
            ${telegram ? `<a href="https://t.me/${escapeAttribute(telegram.replace("@", ""))}">${escapeHtml(telegram)}</a>` : "<p>Telegram не вказано</p>"}
          </div>
        </article>

        <article class="profile-card">
          <h2>Статистика</h2>
          <div class="profile-stats">
            <span><strong>${positive}</strong> рекомендацій</span>
            <span><strong>${negative}</strong> скарг</span>
            <span><strong>${reviews.length}</strong> відгуків у профілі</span>
          </div>
        </article>
      </section>

      <section class="profile-section">
        <div class="section-heading section-heading--row">
          <div>
            <p class="section-kicker">Фото</p>
            <h2>Фото робіт</h2>
          </div>
        </div>
        <div class="photo-grid">
          ${workPhotos.map((photo) => `<img src="${escapeAttribute(photo)}" alt="${escapeAttribute(`Фото роботи ${name}`)}" loading="lazy" />`).join("")}
        </div>
      </section>

      <section class="profile-section">
        <div class="section-heading section-heading--row">
          <div>
            <p class="section-kicker">Відгуки</p>
            <h2>Що пишуть мешканці</h2>
          </div>
          <a class="section-link" href="${escapeAttribute(buildActionLink("recommend", primaryPhone))}">Додати відгук</a>
        </div>
        <div class="review-list">
          ${reviews.map(renderReview).join("") || renderEmpty("Поки немає детальних відгуків.")}
        </div>
      </section>

      <section class="profile-actions">
        <a class="primary-result-action" href="${escapeAttribute(buildActionLink("recommend", primaryPhone))}">Залишити рекомендацію</a>
        <a class="warning-action" href="${escapeAttribute(buildActionLink("complaint", primaryPhone))}">Залишити скаргу</a>
        <a href="index.html">Назад до пошуку</a>
      </section>
    `;
  }

  function renderReview(review) {
    const isComplaint = review.type.toLowerCase().includes("complaint") || review.type.toLowerCase().includes("скар");
    return `
      <article class="review-card ${isComplaint ? "review-card--warning" : "review-card--good"}">
        <div>
          <strong>${escapeHtml(review.author)}</strong>
          <span>${escapeHtml(review.date)}</span>
        </div>
        <p>${escapeHtml(review.text)}</p>
        ${review.photoUrl ? `<img src="${escapeAttribute(review.photoUrl)}" alt="Фото до відгуку" loading="lazy" />` : ""}
      </article>
    `;
  }

  function renderNotFound() {
    root.innerHTML = `
      <section class="profile-loading">
        <p class="result-eyebrow">Не знайдено</p>
        <h1>Майстра не знайдено</h1>
        <p>Перевір посилання або повернись на головну і знайди майстра за номером телефону.</p>
        <a class="primary-result-action" href="index.html">На головну</a>
      </section>
    `;
  }

  function renderError() {
    root.innerHTML = `
      <section class="profile-loading">
        <p class="result-eyebrow">Помилка</p>
        <h1>Не вдалося завантажити профіль</h1>
        <p>Не вдалося завантажити базу. Спробуй пізніше.</p>
      </section>
    `;
  }

  function renderEmpty(message) {
    return `<p class="empty-list">${escapeHtml(message)}</p>`;
  }

  function getInitials(name) {
    return String(name || "?")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
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

  async function boot() {
    try {
      const records = await loadRecords();
      const profile = findProfile(records);

      if (!profile) {
        renderNotFound();
        return;
      }

      renderProfile(profile);
    } catch (error) {
      renderError();
    }
  }

  boot();
})();
