"use strict";

const BUTTON_STYLES = new Set(["primary", "success", "danger"]);

function escapeTelegramHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlText(value) {
  return escapeTelegramHtml(value);
}

function safeTelegramHref(value) {
  const href = String(value || "").trim();
  if (/^(?:https?:\/\/|tg:\/\/|tel:|mailto:)/i.test(href)) {
    return escapeTelegramHtml(href);
  }
  return "";
}

function htmlLink(label, href) {
  const safeHref = safeTelegramHref(href);
  return safeHref ? `<a href="${safeHref}">${htmlText(label)}</a>` : htmlText(label);
}

function telegramButton(text, action, style = "") {
  const button = { text: String(text || "").trim(), ...action };
  if (BUTTON_STYLES.has(style)) {
    button.style = style;
  }
  return button;
}

function normalizeList(value) {
  if (!Array.isArray(value)) {
    return value ? [value] : [];
  }
  return value.filter(Boolean);
}

function renderFieldValue(field) {
  const values = normalizeList(field.values || (field.value ? [{ value: field.value, href: field.href }] : []));
  return values
    .map((item) => typeof item === "string" ? htmlText(item) : htmlLink(item.value, item.href))
    .join(", ");
}

function telegramCard(options = {}) {
  const title = String(options.title || "").trim();
  const subtitle = String(options.subtitle || "").trim();
  const paragraphs = normalizeList(options.paragraphs);
  const items = normalizeList(options.items);
  const fields = normalizeList(options.fields).filter((field) => field?.label && (field.value || field.values?.length));
  const links = normalizeList(options.links).filter((item) => item?.label && item?.href);
  const sections = normalizeList(options.sections);
  const footer = normalizeList(options.footer);
  const rich = [];
  const fallback = [];

  if (title) {
    rich.push(`<h2>${htmlText(title)}</h2>`);
    fallback.push(`<b>${htmlText(title)}</b>`);
  }

  if (subtitle) {
    rich.push(`<p><b>${htmlText(subtitle)}</b></p>`);
    fallback.push(`<b>${htmlText(subtitle)}</b>`);
  }

  for (const paragraph of paragraphs) {
    rich.push(`<p>${htmlText(paragraph)}</p>`);
    fallback.push(htmlText(paragraph));
  }

  if (items.length) {
    rich.push(`<ul>${items.map((item) => `<li>${htmlText(item)}</li>`).join("")}</ul>`);
    fallback.push(items.map((item) => `• ${htmlText(item)}`).join("\n"));
  }

  if (fields.length) {
    rich.push("<hr/>");
    rich.push(`<ul>${fields.map((field) => (
      `<li><b>${htmlText(field.label)}:</b> ${renderFieldValue(field)}</li>`
    )).join("")}</ul>`);
    fallback.push(fields.map((field) => (
      `<b>${htmlText(field.label)}:</b> ${renderFieldValue(field)}`
    )).join("\n"));
  }

  if (options.quote?.text) {
    const credit = options.quote.credit
      ? `<cite>${htmlText(options.quote.credit)}</cite>`
      : "";
    rich.push(`<blockquote>${htmlText(options.quote.text)}${credit}</blockquote>`);
    fallback.push(`<blockquote>${htmlText(options.quote.text)}${options.quote.credit ? `\n— ${htmlText(options.quote.credit)}` : ""}</blockquote>`);
  }

  for (const section of sections) {
    const sectionTitle = String(section?.title || "").trim();
    const sectionParagraphs = normalizeList(section?.paragraphs);
    const sectionFields = normalizeList(section?.fields)
      .filter((field) => field?.label && (field.value || field.values?.length));
    const sectionQuote = section?.quote?.text ? section.quote : null;

    if (!sectionTitle && !sectionParagraphs.length && !sectionFields.length && !sectionQuote) {
      continue;
    }

    rich.push("<hr/>");
    if (sectionTitle) {
      rich.push(`<h3>${htmlText(sectionTitle)}</h3>`);
      fallback.push(`<b>${htmlText(sectionTitle)}</b>`);
    }
    for (const paragraph of sectionParagraphs) {
      rich.push(`<p>${htmlText(paragraph)}</p>`);
      fallback.push(htmlText(paragraph));
    }
    if (sectionFields.length) {
      rich.push(`<ul>${sectionFields.map((field) => (
        `<li><b>${htmlText(field.label)}:</b> ${renderFieldValue(field)}</li>`
      )).join("")}</ul>`);
      fallback.push(sectionFields.map((field) => (
        `<b>${htmlText(field.label)}:</b> ${renderFieldValue(field)}`
      )).join("\n"));
    }
    if (sectionQuote) {
      const credit = sectionQuote.credit
        ? `<cite>${htmlText(sectionQuote.credit)}</cite>`
        : "";
      rich.push(`<blockquote>${htmlText(sectionQuote.text)}${credit}</blockquote>`);
      fallback.push(`<blockquote>${htmlText(sectionQuote.text)}${sectionQuote.credit ? `\n— ${htmlText(sectionQuote.credit)}` : ""}</blockquote>`);
    }
  }

  if (links.length) {
    rich.push(links.map((item) => `<p>${htmlLink(item.label, item.href)}</p>`).join(""));
    fallback.push(links.map((item) => htmlLink(item.label, item.href)).join("\n"));
  }

  if (options.details?.summary && options.details?.lines?.length) {
    const detailsBody = options.details.lines.map((line) => `<p>${htmlText(line)}</p>`).join("");
    rich.push(`<details><summary>${htmlText(options.details.summary)}</summary>${detailsBody}</details>`);
    fallback.push(`<blockquote expandable><b>${htmlText(options.details.summary)}</b>\n${options.details.lines.map(htmlText).join("\n")}</blockquote>`);
  }

  for (const line of footer) {
    rich.push(`<footer>${htmlText(line)}</footer>`);
    fallback.push(`<i>${htmlText(line)}</i>`);
  }

  return {
    richHtml: rich.join("\n"),
    fallbackHtml: fallback.join("\n\n")
  };
}

function botPrompt(title, body = "", hint = "") {
  return [
    title ? `<b>${htmlText(title)}</b>` : "",
    body ? htmlText(body) : "",
    hint ? `<i>${htmlText(hint)}</i>` : ""
  ].filter(Boolean).join("\n\n");
}

function intakePrompt(step, title, body, hint = "", options = {}) {
  const total = Number(options.total) || 7;
  const current = Math.min(Math.max(Number(step) || 1, 1), total);
  const progress = `${"●".repeat(current)}${"○".repeat(Math.max(total - current, 0))}`;
  const summary = normalizeList(options.summary).map(htmlText).join("\n");

  return [
    options.kind ? `<b>${htmlText(options.kind)}</b>` : "",
    `<code>${progress}</code> <i>${current} із ${total}</i>`,
    summary ? `<blockquote>${summary}</blockquote>` : "",
    title ? `<b>${htmlText(title)}</b>` : "",
    body ? htmlText(body) : "",
    hint ? `<i>${htmlText(hint)}</i>` : ""
  ].filter(Boolean).join("\n\n");
}

function typeMeta(type) {
  if (type === "complaint") {
    return { icon: "⚠️", moderationTitle: "Нова скарга", publicTitle: "Є скарга" };
  }
  if (type === "add") {
    return { icon: "🧰", moderationTitle: "Нова анкета майстра", publicTitle: "Новий майстер" };
  }
  return { icon: "✅", moderationTitle: "Нова рекомендація", publicTitle: "Рекомендують" };
}

function telegramUsernameField(username) {
  const value = String(username || "").trim();
  if (!value) {
    return null;
  }
  return {
    label: "Telegram",
    value,
    href: `https://telegram.me/${value.replace(/^@/, "")}`
  };
}

function phoneField(phones = []) {
  const values = normalizeList(phones).filter((phone) => phone?.value);
  return values.length ? { label: "Телефон", values } : null;
}

function buildWelcomeCard() {
  return telegramCard({
    title: "Перевір майстра",
    subtitle: "Пошук за номером телефону",
    paragraphs: "Надішли номер майстра, бригади або підрядника — я покажу схвалені рекомендації та скарги мешканців.",
    quote: { text: "Усі публічні записи проходять модерацію." },
    footer: "Номер можна надсилати з пробілами, дужками або дефісами."
  });
}

function buildNotFoundCard({ phone, rawPhone }) {
  return telegramCard({
    title: "Майстра не знайдено",
    paragraphs: "У базі поки немає рекомендацій або скарг для цього номера.",
    fields: [phoneField([{ value: phone, href: `tel:${rawPhone}` }])],
    footer: "Можеш залишити рекомендацію або скаргу про власний досвід."
  });
}

function buildFoundCard(view) {
  const fields = [
    { label: "Послуги", value: view.services },
    phoneField(view.phones),
    telegramUsernameField(view.telegramUsername),
    { label: "Рекомендацій", value: String(view.positive) },
    { label: "Скарг", value: String(view.negative) },
    view.lastReviewAt ? { label: "Останній відгук", value: view.lastReviewAt } : null
  ].filter(Boolean);

  return telegramCard({
    title: "Знайдено майстра",
    subtitle: view.name,
    fields,
    quote: { text: view.status },
    links: [{ label: "Відкрити повний профіль", href: view.profileUrl }]
  });
}

function buildIntakeCompleteCard(view) {
  return telegramCard({
    title: "Заявку передано на модерацію",
    fields: [
      phoneField([{ value: view.phone, href: `tel:${view.rawPhone}` }]),
      { label: "Номер заявки", value: view.id }
    ].filter(Boolean),
    quote: { text: view.sent
      ? "Після перевірки запис зʼявиться у пошуку та публічному каналі."
      : "Заявку збережено, але модераційний чат тимчасово недоступний."
    },
    footer: "Дякуємо, що ділитеся досвідом із сусідами."
  });
}

function buildModerationCard(view) {
  const meta = typeMeta(view.type);
  const statusText = view.status === "approved"
    ? `Додано до бази${view.publicSent ? " та опубліковано в каналі" : ""}.`
    : view.status === "rejected"
      ? `Відхилено. Причина: ${view.rejectionReason || "не вказана"}.`
      : "";
  const serviceLines = [
    `Фото: ${view.photoCount || 0}`,
    view.submittedBy ? `Надіслав: ${view.submittedBy}` : "",
    view.source ? `Джерело: ${view.source}` : "",
    `Заявка: ${view.id}`
  ].filter(Boolean);

  return telegramCard({
    title: `${meta.icon} ${meta.moderationTitle}`,
    subtitle: statusText || (view.revisionOf ? "Оновлення відгуку очікує рішення" : "Очікує рішення модератора"),
    sections: [
      {
        title: "Майстер",
        fields: [
          { label: "Імʼя", value: view.name || "не вказано" },
          { label: "Послуги", value: view.services || "не вказано" },
          phoneField(view.phones),
          telegramUsernameField(view.telegramUsername)
        ].filter(Boolean)
      },
      {
        title: "Відгук",
        fields: [{ label: "Автор", value: view.author || "Анонімно" }],
        quote: view.review ? { text: view.review, credit: view.author || "Анонімно" } : null
      }
    ],
    links: [
      view.profileUrl ? { label: "Відкрити профіль", href: view.profileUrl } : null,
      view.sourceUrl ? { label: "Відкрити джерело", href: view.sourceUrl } : null
    ].filter(Boolean),
    details: { summary: "Службова інформація", lines: serviceLines },
    footer: view.status ? [] : "Перевір дані та обери рішення кнопками нижче."
  });
}

function buildSubmissionDecisionCard(view) {
  const approved = view.status === "approved";
  const meta = typeMeta(view.type);
  const title = approved ? "✅ Заявку схвалено" : "❌ Заявку не схвалено";

  return telegramCard({
    title,
    subtitle: view.name || "Майстер",
    paragraphs: approved
      ? "Запис уже доступний у пошуку."
      : "Запис не додано до публічної бази.",
    fields: [
      { label: "Тип", value: meta.publicTitle },
      phoneField(view.phones)
    ].filter(Boolean),
    quote: !approved && view.rejectionReason
      ? { text: view.rejectionReason, credit: "Причина модерації" }
      : null,
    links: approved && view.profileUrl
      ? [{ label: "Відкрити профіль", href: view.profileUrl }]
      : [],
    footer: approved
      ? "Дякуємо, що поділилися досвідом із сусідами."
      : "Відгук можна виправити й повторно надіслати на модерацію."
  });
}

function buildMySubmissionsCard(view) {
  const items = normalizeList(view.items);

  if (!items.length) {
    return telegramCard({
      title: "Мої заявки",
      paragraphs: "Тут поки немає рекомендацій або скарг, надісланих із цього Telegram-акаунта.",
      footer: "Нову заявку можна почати з головного меню."
    });
  }

  return telegramCard({
    title: "Мої заявки",
    subtitle: `Останні ${items.length}`,
    sections: items.map((item, index) => ({
      title: `${index + 1}. ${item.name || "Майстер"}`,
      fields: [
        { label: "Тип", value: item.typeLabel },
        { label: "Статус", value: item.statusLabel },
        item.date ? { label: "Дата", value: item.date } : null
      ].filter(Boolean),
      quote: item.review ? { text: item.review } : null
    })),
    footer: "Змінювати можна заявки, за якими модератор уже ухвалив рішення."
  });
}

function buildContactCard(view) {
  return telegramCard({
    title: "Звʼязатися з адміністрацією",
    paragraphs: "Напиши адміністратору, якщо маєш питання щодо модерації, профілю майстра або власної заявки.",
    links: [{ label: "Відкрити чат з адміністратором", href: view.adminUrl }],
    footer: "Для швидшої відповіді вкажи номер телефону майстра або номер заявки."
  });
}

function buildPublicCard(view) {
  const meta = typeMeta(view.type);
  return telegramCard({
    title: `${meta.icon} ${meta.publicTitle}`,
    subtitle: view.name || "Імʼя не вказано",
    fields: [
      { label: "Послуги", value: view.services || "не вказано" },
      phoneField(view.phones),
      telegramUsernameField(view.telegramUsername)
    ].filter(Boolean),
    quote: view.review ? { text: view.review, credit: view.author || "Анонімно" } : null,
    links: view.profileUrl ? [{ label: "Відкрити профіль майстра", href: view.profileUrl }] : [],
    footer: [view.disclaimer, view.source].filter(Boolean)
  });
}

function buildChannelIntroCard(view) {
  return telegramCard({
    title: "Black List Світло парк",
    subtitle: "Рекомендації та скарги мешканців",
    paragraphs: "Перевіряй майстрів за номером телефону та ділися власним досвідом після ремонту.",
    items: [
      "Перевірити номер через Telegram-бота",
      "Переглянути всі рекомендації",
      "Переглянути схвалені скарги"
    ],
    links: [
      { label: "Відкрити бота", href: view.botUrl },
      { label: "Усі рекомендації", href: view.recommendationsUrl },
      { label: "Black List", href: view.complaintsUrl }
    ],
    quote: { text: "Публікуємо лише записи, що пройшли модерацію." },
    footer: "Платформа фіксує користувацький досвід і не встановлює факт порушення."
  });
}

function buildModerationIntroCard(view) {
  return telegramCard({
    title: "Модерація Black List",
    subtitle: "Робочий чат адміністратора",
    items: [
      "Перевір імʼя, послуги та номер телефону.",
      "Звір опис відгуку й прикріплені матеріали.",
      "Схвали запис або обери конкретну причину відхилення."
    ],
    links: [{ label: "Відкрити сайт", href: view.siteUrl }],
    footer: "Службова інформація в нових картках прихована в блоці «Деталі»."
  });
}

function buildRelayCard(view) {
  return telegramCard({
    title: view.title,
    fields: [
      { label: "Від", value: view.sender || "не вказано" },
      view.submissionId ? { label: "Заявка", value: view.submissionId } : null
    ].filter(Boolean),
    quote: view.text ? { text: view.text } : null,
    footer: view.footer || ""
  });
}

module.exports = {
  botPrompt,
  buildChannelIntroCard,
  buildContactCard,
  buildFoundCard,
  buildIntakeCompleteCard,
  buildModerationCard,
  buildModerationIntroCard,
  buildMySubmissionsCard,
  buildNotFoundCard,
  buildPublicCard,
  buildRelayCard,
  buildSubmissionDecisionCard,
  buildWelcomeCard,
  escapeTelegramHtml,
  intakePrompt,
  telegramButton,
  telegramCard
};
