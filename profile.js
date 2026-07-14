(function () {
  const config = window.CHSP_CONFIG || {};
  const links = config.links || {};
  const root = document.querySelector("#profile-root");
  const phoneFields = ["primary_phone", "phone", "phone_numbers", "phones", "alternate_phones"];
  const aliases = {
    id: ["master_id", "id"],
    name: ["display_name", "name", "master_name", "team_name"],
    categories: ["category_names", "categories", "category_name", "category"],
    telegram: ["telegram_username", "telegram", "tg", "username"],
    masterPhoto: ["master_photo_url", "avatar_url"],
    positive: ["positive_reviews_count", "recommendations_count"],
    negative: ["negative_reviews_count", "complaints_count"],
    lastReviewAt: ["last_review_at", "updated_at"],
    lastReviewText: ["last_review_text", "review_text"]
  };

  function normalizePhone(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 9) return `+380${digits}`;
    if (digits.length === 10 && digits.startsWith("0")) return `+38${digits}`;
    if (digits.length === 11 && digits.startsWith("80")) return `+3${digits}`;
    if (digits.length === 12 && digits.startsWith("380")) return `+${digits}`;
    return digits ? `+${digits}` : "";
  }

  function validPhone(value) {
    return /^\+380\d{9}$/.test(value);
  }

  function formatPhone(value) {
    const match = normalizePhone(value).match(/^\+380(\d{2})(\d{3})(\d{2})(\d{2})$/);
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
      } else if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) {
        row.push(cell);
        cell = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && next === "\n") index += 1;
        row.push(cell);
        if (row.some((value) => value.trim())) rows.push(row);
        row = [];
        cell = "";
      } else cell += char;
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

  function split(value) {
    return String(value || "").split(/[;,|\n]+/).map((item) => item.trim()).filter(Boolean);
  }

  function phones(record) {
    return Array.from(new Set(phoneFields.flatMap((name) => split(field(record, [name])))
      .map(normalizePhone).filter(validPhone)));
  }

  function categories(record) {
    return Array.from(new Set(split(field(record, aliases.categories))));
  }

  function numberValue(value) {
    const parsed = Number.parseInt(String(value || "0").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function actionLink(kind, phone) {
    const url = new URL(links[kind] || links.telegramBot || "https://telegram.me/bl_svitlopark_bot", window.location.origin);
    const action = kind === "recommend" ? "recommend" : "complaint";
    const digits = String(phone || "").replace(/\D/g, "");
    url.searchParams.set("start", digits ? `${action}_${digits}` : action);
    return url.toString();
  }

  function reviews(record) {
    const result = [];
    for (let index = 1; index <= 10; index += 1) {
      const text = field(record, [`review_${index}_text`]);
      if (!text) continue;
      const photoUrls = Array.from(new Set([
        ...split(field(record, [`review_${index}_photo_urls`])),
        ...split(field(record, [`review_${index}_photo_url`]))
      ])).filter(Boolean);
      result.push({
        author: field(record, [`review_${index}_author`]) || "Анонімно",
        type: field(record, [`review_${index}_type`]) || "recommendation",
        date: field(record, [`review_${index}_date`]) || field(record, aliases.lastReviewAt),
        text,
        photoUrls,
        sourceNote: field(record, [`review_${index}_source_note`])
      });
    }

    if (!result.length && field(record, aliases.lastReviewText)) {
      result.push({
        author: "Анонімно",
        type: numberValue(field(record, aliases.negative)) > 0 ? "complaint" : "recommendation",
        date: field(record, aliases.lastReviewAt),
        text: field(record, aliases.lastReviewText),
        photoUrls: [],
        sourceNote: ""
      });
    }
    return result;
  }

  function findRecord(records) {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    const phone = normalizePhone(params.get("phone"));
    if (id) {
      const record = records.find((item) => field(item, aliases.id) === id);
      if (record) return record;
    }
    return validPhone(phone) ? records.find((item) => phones(item).includes(phone)) : null;
  }

  function renderReview(review) {
    const complaint = /complaint|скар/i.test(review.type);
    return `
      <article class="review-card ${complaint ? "review-card--warning" : "review-card--good"}">
        <header>
          <div><strong>${escapeHtml(review.author)}</strong><span>${complaint ? "Скарга" : "Рекомендація"}</span></div>
          <time>${escapeHtml(review.date || "Дата не вказана")}</time>
        </header>
        <p>${escapeHtml(review.text)}</p>
        ${review.photoUrls.length ? `
          <div class="review-photos">
            ${review.photoUrls.map((url) => `<a href="${escapeAttribute(url)}" target="_blank" rel="noreferrer"><img src="${escapeAttribute(url)}" alt="Фото до відгуку" loading="lazy" /></a>`).join("")}
          </div>
        ` : ""}
        ${review.sourceNote ? `<small class="source-note">${escapeHtml(review.sourceNote)}</small>` : ""}
      </article>
    `;
  }

  function render(record) {
    const name = field(record, aliases.name) || "Без назви";
    const masterPhones = phones(record);
    const primaryPhone = masterPhones[0] || "";
    const masterCategories = categories(record);
    const telegram = field(record, aliases.telegram);
    const positive = numberValue(field(record, aliases.positive));
    const negative = numberValue(field(record, aliases.negative));
    const masterReviews = reviews(record);
    const masterPhoto = field(record, aliases.masterPhoto);
    const status = negative > 0 ? "Є скарги" : positive > 0 ? "Є позитивні відгуки" : "Мало інформації";

    document.title = `${name} | Black List Світло парк`;
    root.innerHTML = `
      <section class="profile-head">
        ${masterPhoto ? `<img class="profile-photo" src="${escapeAttribute(masterPhoto)}" alt="${escapeAttribute(name)}" />` : ""}
        <div>
          <p class="section-kicker">Профіль майстра</p>
          <h1>${escapeHtml(name)}</h1>
          <div class="profile-tags">
            ${masterCategories.map((category) => `<a href="/services?service=${encodeURIComponent(category)}">${escapeHtml(category)}</a>`).join("")}
          </div>
          <span class="status-pill ${negative > 0 ? "status-pill--warning" : positive > 0 ? "status-pill--good" : ""}">${escapeHtml(status)}</span>
        </div>
      </section>

      <section class="profile-overview">
        <div>
          <p class="section-kicker">Контакти</p>
          <div class="contact-list">
            ${masterPhones.map((phone) => `<a href="tel:${escapeAttribute(phone)}">${escapeHtml(formatPhone(phone))}</a>`).join("") || "<span>Телефон не вказано</span>"}
            ${telegram ? `<a href="https://telegram.me/${escapeAttribute(telegram.replace("@", ""))}" target="_blank" rel="noreferrer">${escapeHtml(telegram)}</a>` : ""}
          </div>
        </div>
        <div>
          <p class="section-kicker">Відгуки</p>
          <div class="profile-counts">
            <span><strong>${positive}</strong> рекомендацій</span>
            <span><strong>${negative}</strong> скарг</span>
          </div>
        </div>
      </section>

      <section class="profile-reviews">
        <div class="section-heading section-heading--row">
          <div><p class="section-kicker">Досвід мешканців</p><h2>Відгуки</h2></div>
          <a class="section-link section-link--primary" href="${escapeAttribute(actionLink("recommend", primaryPhone))}">Додати відгук</a>
        </div>
        <div class="review-list">${masterReviews.length ? masterReviews.map(renderReview).join("") : `<p class="empty-list">Поки немає детальних відгуків.</p>`}</div>
      </section>

      <section class="profile-actions">
        <a class="primary-result-action" href="${escapeAttribute(actionLink("recommend", primaryPhone))}">Залишити рекомендацію</a>
        <a class="warning-action" href="${escapeAttribute(actionLink("complaint", primaryPhone))}">Залишити скаргу</a>
        <a href="/">Назад до пошуку</a>
      </section>
    `;
  }

  function escapeHtml(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  async function boot() {
    try {
      const response = await fetch(config.phonesCsvUrl, { cache: "no-store" });
      if (!response.ok) throw new Error("fetch_failed");
      const record = findRecord(parseCsv(await response.text()));
      if (!record) {
        root.innerHTML = `<section class="profile-loading"><p class="section-kicker">Не знайдено</p><h1>Майстра не знайдено</h1><p>Повернись до пошуку й перевір номер.</p><a class="primary-result-action" href="/">До пошуку</a></section>`;
        return;
      }
      render(record);
    } catch (error) {
      root.innerHTML = `<section class="profile-loading"><p class="section-kicker">Помилка</p><h1>Не вдалося завантажити профіль</h1><p>Спробуй ще раз трохи пізніше.</p></section>`;
    }
  }

  boot();
})();
