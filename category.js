(function () {
  const config = window.CHSP_CONFIG || {};
  const links = config.links || {};
  const title = document.querySelector("#category-title");
  const copy = document.querySelector("#category-copy");
  const peopleRoot = document.querySelector("#category-people");
  const servicesRoot = document.querySelector("#category-services");

  const aliases = {
    masterId: ["master_id", "id"],
    displayName: ["display_name", "name", "master_name", "team_name"],
    categoryName: ["category_name", "category", "service_category"],
    categoryNames: ["category_names", "categories", "service_categories"],
    primaryPhone: ["primary_phone", "phone", "phone_number", "phone_numbers", "phones"],
    positive: ["positive_reviews_count", "recommendations_count", "positive_count"],
    negative: ["negative_reviews_count", "complaints_count", "negative_count"],
    lastReviewText: ["last_review_text", "last_review_summary", "review_text", "comment"],
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
    { match: "кондиц", src: "assets/work/climate.svg" },
    { match: "приби", src: "assets/work/cleaning.svg" },
    { match: "дизайн", src: "assets/work/design.svg" },
    { match: "двер", src: "assets/work/doors.svg" },
    { match: "звуко", src: "assets/work/acoustic.svg" }
  ];

  function parseCsv(csvText) {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;

    for (let index = 0; index < csvText.length; index += 1) {
      const char = csvText[index];
      const next = csvText[index + 1];

      if (char === '"' && quoted && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === "," && !quoted) {
        row.push(cell);
        cell = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && next === "\n") {
          index += 1;
        }
        row.push(cell);
        if (row.some((value) => value.trim())) {
          rows.push(row);
        }
        row = [];
        cell = "";
      } else {
        cell += char;
      }
    }

    row.push(cell);
    if (row.some((value) => value.trim())) {
      rows.push(row);
    }

    const headers = (rows.shift() || []).map(normalizeKey);
    return rows.map((cells) => Object.fromEntries(
      headers.map((header, index) => [header, (cells[index] || "").trim()])
    ));
  }

  function normalizeKey(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
  }

  function normalizeText(value) {
    return String(value || "").trim().toLowerCase().replace(/ё/g, "е").replace(/ґ/g, "г");
  }

  function getField(record, fields) {
    for (const field of fields) {
      const value = record[normalizeKey(field)];
      if (value !== undefined && value !== "") {
        return value;
      }
    }
    return "";
  }

  function splitList(value) {
    return String(value || "").split(/[\n;|,]+/).map((item) => item.trim()).filter(Boolean);
  }

  function getCategories(record) {
    const categories = [
      ...splitList(getField(record, aliases.categoryNames)),
      ...splitList(getField(record, aliases.categoryName))
    ];
    return Array.from(new Set(categories));
  }

  function normalizePhone(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 10 && digits.startsWith("0")) {
      return `+38${digits}`;
    }
    if (digits.length === 12 && digits.startsWith("380")) {
      return `+${digits}`;
    }
    if (digits.length === 9) {
      return `+380${digits}`;
    }
    return digits ? `+${digits}` : "";
  }

  function formatPhone(value) {
    const phone = normalizePhone(value);
    const match = phone.match(/^\+380(\d{2})(\d{3})(\d{2})(\d{2})$/);
    return match ? `+380 ${match[1]} ${match[2]} ${match[3]} ${match[4]}` : value || "Телефон не вказано";
  }

  function numberValue(value) {
    const number = Number.parseInt(String(value || "0").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(number) ? number : 0;
  }

  function getPhotoUrls(record, categoryName) {
    const configured = [
      ...splitList(getField(record, aliases.workPhotoUrls)),
      ...splitList(getField(record, aliases.workPhotoUrl))
    ];

    if (configured.length) {
      return Array.from(new Set(configured));
    }

    const normalized = normalizeText(categoryName);
    const fallback = categoryPhotos.find((item) => normalized.includes(item.match));
    return [fallback ? fallback.src : "assets/work/default.svg"];
  }

  function profileLink(record, phone) {
    const id = getField(record, aliases.masterId);
    return id
      ? `profile.html?id=${encodeURIComponent(id)}`
      : `profile.html?phone=${encodeURIComponent(phone)}`;
  }

  function renderMaster(record) {
    const name = getField(record, aliases.displayName) || "Без назви";
    const categories = getCategories(record);
    const categoryName = categories[0] || "Послуга не вказана";
    const phone = normalizePhone(getField(record, aliases.primaryPhone));
    const positive = numberValue(getField(record, aliases.positive));
    const negative = numberValue(getField(record, aliases.negative));
    const warning = negative > 0;
    const photos = getPhotoUrls(record, categoryName);
    const review = getField(record, aliases.lastReviewText)
      || (warning ? "Є скарги від мешканців." : "Є позитивні відгуки від мешканців.");

    return `
      <a class="person-card person-card--clickable person-card--${warning ? "warning" : "good"}" href="${escapeAttribute(profileLink(record, phone))}">
        <div class="person-gallery" aria-label="Фото робіт">
          ${photos.slice(0, 4).map((photo) => `
            <img src="${escapeAttribute(photo)}" alt="${escapeAttribute(`Робота: ${categoryName}`)}" loading="lazy" />
          `).join("")}
        </div>
        <div class="person-card-body">
          <div>
            <h3>${escapeHtml(name)}</h3>
            <p>${escapeHtml(categories.join(" · "))}</p>
          </div>
          <div class="person-score">
            <span>${positive} ${pluralize(positive, "рекомендація", "рекомендації", "рекомендацій")}</span>
            <span>${negative} ${pluralize(negative, "скарга", "скарги", "скарг")}</span>
          </div>
          <small>${escapeHtml(review)}</small>
          <span class="person-card-link">Відкрити профіль · ${escapeHtml(formatPhone(phone))}</span>
        </div>
      </a>
    `;
  }

  function renderServices(categories, activeService) {
    servicesRoot.innerHTML = categories.map((category, index) => `
      <a class="category-card ${normalizeText(category) === normalizeText(activeService) ? "category-card--active" : ""}" href="category.html?service=${encodeURIComponent(category)}">
        <span class="category-icon" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>
        <strong>${escapeHtml(category)}</strong>
        <small>Відкрити майстрів</small>
      </a>
    `).join("");
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
    return lastDigit >= 2 && lastDigit <= 4 ? few : many;
  }

  function wireLinks() {
    document.querySelectorAll("[data-link]").forEach((element) => {
      const key = element.getAttribute("data-link");
      if (links[key]) {
        element.setAttribute("href", links[key]);
      }
    });
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
    wireLinks();

    try {
      const response = await fetch(config.phonesCsvUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error("sheet_fetch_failed");
      }

      const records = parseCsv(await response.text());
      const service = new URLSearchParams(window.location.search).get("service") || "";
      const categories = Array.from(new Set(records.flatMap(getCategories))).sort((a, b) => a.localeCompare(b, "uk"));
      const matches = service
        ? records.filter((record) => getCategories(record).some((category) => normalizeText(category) === normalizeText(service)))
        : records;
      const pageTitle = service || "Усі послуги";

      title.textContent = pageTitle;
      copy.textContent = matches.length
        ? `${matches.length} ${pluralize(matches.length, "майстер", "майстри", "майстрів")} у базі.`
        : "У цій послузі поки немає майстрів.";
      document.title = `${pageTitle} | Black List Світло парк`;
      peopleRoot.innerHTML = matches.length
        ? matches.map(renderMaster).join("")
        : '<p class="empty-list">Поки немає записів. Можна додати рекомендацію або скаргу через форму.</p>';
      renderServices(categories, service);
    } catch (error) {
      title.textContent = "Не вдалося завантажити послугу";
      copy.textContent = "Перевір доступ до Google Sheets або спробуй пізніше.";
      peopleRoot.innerHTML = '<p class="empty-list">Дані тимчасово недоступні.</p>';
    }
  }

  boot();
})();
