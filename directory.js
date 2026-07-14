(function () {
  const config = window.CHSP_CONFIG || {};
  const complaintMode = window.location.pathname === "/complaints";
  const listRoot = document.querySelector("#directory-list");
  const searchInput = document.querySelector("#directory-search-input");
  const title = document.querySelector("#directory-title");
  const copy = document.querySelector("#directory-copy");
  const kicker = document.querySelector("#directory-kicker");
  const brandLabel = document.querySelector("#directory-brand-label");
  const action = document.querySelector("#directory-action");
  let masters = [];

  title.textContent = complaintMode ? "Усі скарги" : "Усі рекомендації";
  copy.textContent = complaintMode
    ? "Користувацький досвід, опублікований після модерації."
    : "Майстри, яких рекомендують мешканці ЖК SVITLO PARK.";
  kicker.textContent = complaintMode ? "Black List" : "Перевірений досвід мешканців";
  brandLabel.textContent = complaintMode ? "Скарги" : "Рекомендації";
  action.textContent = complaintMode ? "Залишити скаргу" : "Додати рекомендацію";
  action.href = complaintMode ? config.links?.complaint : config.links?.recommend;
  action.target = "_blank";
  action.rel = "noreferrer";
  document.title = `${complaintMode ? "Скарги" : "Рекомендації"} | Black List Світло парк`;

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

  function toMaster(record) {
    const phoneValues = split(field(record, ["phone_numbers", "primary_phone", "phone"])).map(normalizePhone).filter(Boolean);
    return {
      id: field(record, ["master_id", "id"]),
      name: field(record, ["display_name", "name", "master_name"]) || "Без назви",
      categories: split(field(record, ["category_names", "category_name", "categories"])),
      phone: phoneValues[0] || "",
      allPhones: phoneValues,
      positive: Number(field(record, ["positive_reviews_count", "recommendations_count"]) || 0),
      negative: Number(field(record, ["negative_reviews_count", "complaints_count"]) || 0),
      review: field(record, ["last_review_text", "review_text"]),
      date: field(record, ["last_review_at", "updated_at"]),
      pinned: /^(1|true|yes|так)$/i.test(field(record, ["is_pinned", "pinned"]))
    };
  }

  function profileLink(master) {
    const url = new URL("/profile", window.location.origin);
    if (master.id) url.searchParams.set("id", master.id);
    else url.searchParams.set("phone", master.phone);
    return `${url.pathname}${url.search}`;
  }

  function normalizeSearch(value) {
    return String(value || "").trim().toLowerCase().replace(/ґ/g, "г").replace(/\s+/g, " ");
  }

  function render() {
    const query = normalizeSearch(searchInput.value);
    const digits = String(searchInput.value || "").replace(/\D/g, "");
    const filtered = masters.filter((master) => {
      if (!query && !digits) return true;
      const text = normalizeSearch(`${master.name} ${master.categories.join(" ")}`);
      const phoneMatch = digits && master.allPhones.some((phone) => phone.replace(/\D/g, "").includes(digits));
      return text.includes(query) || Boolean(phoneMatch);
    });

    listRoot.innerHTML = filtered.length ? filtered.map((master) => `
      <a class="person-row person-row--${complaintMode ? "warning" : "good"}" href="${escapeAttribute(profileLink(master))}">
        <div class="person-row__body">
          <span class="person-row__status">${complaintMode ? "Є скарги" : "Рекомендують"}</span>
          <h3>${escapeHtml(master.name)}</h3>
          <p>${escapeHtml(master.categories.join(" · ") || "Послуги не вказані")}</p>
          ${master.review ? `<blockquote>${escapeHtml(master.review)}</blockquote>` : ""}
        </div>
        <div class="person-row__meta">
          <strong>${complaintMode ? `${master.negative} скарг` : `${master.positive} рекомендацій`}</strong>
          <span>${escapeHtml(formatPhone(master.phone))}</span>
        </div>
      </a>
    `).join("") : `<p class="empty-list">${query || digits ? "Нічого не знайдено." : complaintMode ? "Поки немає схвалених скарг." : "Поки немає схвалених рекомендацій."}</p>`;
  }

  function escapeHtml(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  searchInput.addEventListener("input", render);
  fetch(config.phonesCsvUrl, { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error("fetch_failed");
      return response.text();
    })
    .then((text) => {
      masters = parseCsv(text).map(toMaster)
        .filter((master) => master.phone && (complaintMode ? master.negative > 0 : master.positive > 0))
        .sort((left, right) => {
          if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
          return String(right.date).localeCompare(String(left.date));
        });
      render();
    })
    .catch(() => {
      listRoot.innerHTML = `<p class="empty-list">Не вдалося завантажити базу.</p>`;
    });
})();
