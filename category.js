(function () {
  const config = window.CHSP_CONFIG || {};
  const title = document.querySelector("#category-title");
  const copy = document.querySelector("#category-copy");
  const peopleRoot = document.querySelector("#category-people");
  const servicesRoot = document.querySelector("#category-services");
  const search = document.querySelector("#category-page-search");
  const selectedService = new URLSearchParams(window.location.search).get("service") || "";

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

  function normalizePhone(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 10 && digits.startsWith("0")) return `+38${digits}`;
    if (digits.length === 12 && digits.startsWith("380")) return `+${digits}`;
    return "";
  }

  function formatPhone(value) {
    const match = normalizePhone(value).match(/^\+380(\d{2})(\d{3})(\d{2})(\d{2})$/);
    return match ? `+380 ${match[1]} ${match[2]} ${match[3]} ${match[4]}` : value || "";
  }

  function recordView(record) {
    const phoneValues = split(field(record, ["phone_numbers", "phones", "primary_phone", "phone"]))
      .map(normalizePhone).filter(Boolean);
    return {
      id: field(record, ["master_id", "id"]),
      name: field(record, ["display_name", "name", "master_name"]) || "Без назви",
      categories: Array.from(new Set(split(field(record, ["category_names", "categories", "category_name", "category"])))),
      phone: phoneValues[0] || "",
      positive: Number(field(record, ["positive_reviews_count", "recommendations_count"]) || 0),
      negative: Number(field(record, ["negative_reviews_count", "complaints_count"]) || 0),
      review: field(record, ["last_review_text", "review_text"])
    };
  }

  function profileLink(master) {
    const url = new URL("/profile", window.location.origin);
    if (master.id) url.searchParams.set("id", master.id);
    else url.searchParams.set("phone", master.phone);
    return `${url.pathname}${url.search}`;
  }

  function renderPerson(master) {
    const warning = master.negative > 0;
    return `
      <a class="person-row person-row--${warning ? "warning" : "good"}" href="${escapeAttribute(profileLink(master))}">
        <div class="person-row__body">
          <span class="person-row__status">${warning ? "Є скарги" : "Рекомендують"}</span>
          <h3>${escapeHtml(master.name)}</h3>
          <p>${escapeHtml(master.categories.join(" · ") || "Послуги не вказані")}</p>
          ${master.review ? `<blockquote>${escapeHtml(master.review)}</blockquote>` : ""}
        </div>
        <div class="person-row__meta">
          <strong>${master.positive} рекомендацій · ${master.negative} скарг</strong>
          <span>${escapeHtml(formatPhone(master.phone))}</span>
        </div>
      </a>
    `;
  }

  function normalizeSearch(value) {
    return String(value || "").trim().toLowerCase().replace(/ґ/g, "г").replace(/\s+/g, " ");
  }

  function render(records) {
    const masters = records.map(recordView).filter((master) => master.phone);
    const categoryCounts = new Map();
    masters.forEach((master) => master.categories.forEach((category) => categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1)));
    const serviceNames = [...categoryCounts.keys()].sort((a, b) => a.localeCompare(b, "uk"));

    servicesRoot.innerHTML = serviceNames.length ? serviceNames.map((service) => `
      <a class="service-item ${normalizeSearch(service) === normalizeSearch(selectedService) ? "service-item--active" : ""}" href="/services?service=${encodeURIComponent(service)}" data-service-search="${escapeAttribute(normalizeSearch(service))}">
        <strong>${escapeHtml(service)}</strong><span>${categoryCounts.get(service)}</span>
      </a>
    `).join("") : `<p class="empty-list">Поки немає послуг у базі.</p>`;

    const filtered = selectedService
      ? masters.filter((master) => master.categories.some((category) => normalizeSearch(category) === normalizeSearch(selectedService)))
      : masters;
    title.textContent = selectedService || "Усі послуги";
    copy.textContent = selectedService
      ? `${filtered.length} ${filtered.length === 1 ? "майстер" : "майстрів"} у цій послузі.`
      : "Обери послугу або переглянь усіх майстрів.";
    peopleRoot.innerHTML = filtered.length
      ? filtered.map(renderPerson).join("")
      : `<p class="empty-list">У цій послузі поки немає схвалених майстрів.</p>`;
    document.title = `${selectedService || "Послуги"} | Black List Світло парк`;
  }

  function escapeHtml(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  document.querySelectorAll("[data-link='recommend']").forEach((link) => {
    link.href = config.links?.recommend || "https://telegram.me/bl_svitlopark_bot?start=recommend";
    link.target = "_blank";
    link.rel = "noreferrer";
  });

  search?.addEventListener("input", () => {
    const query = normalizeSearch(search.value);
    servicesRoot.querySelectorAll(".service-item").forEach((item) => {
      item.hidden = Boolean(query) && !item.dataset.serviceSearch.includes(query);
    });
  });

  fetch(config.phonesCsvUrl, { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error("fetch_failed");
      return response.text();
    })
    .then((text) => render(parseCsv(text)))
    .catch(() => {
      peopleRoot.innerHTML = `<p class="empty-list">Не вдалося завантажити базу.</p>`;
      servicesRoot.innerHTML = `<p class="empty-list">Не вдалося завантажити послуги.</p>`;
    });
})();
