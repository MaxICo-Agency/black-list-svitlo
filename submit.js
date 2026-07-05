(function () {
  const config = window.CHSP_CONFIG || {};
  const params = new URLSearchParams(window.location.search);
  const form = document.querySelector("#submission-form");
  const typeSelect = document.querySelector("#submission-type");
  const title = document.querySelector("#submit-title");
  const kicker = document.querySelector("#submit-kicker");
  const copy = document.querySelector("#submit-copy");
  const phoneInput = document.querySelector("#master-phone");
  const textInput = document.querySelector("#submission-text");
  const submitButton = document.querySelector("#submission-button");
  const status = document.querySelector("#submission-status");

  const pageByType = {
    recommend: {
      kicker: "Рекомендація",
      title: "Порекомендувати майстра",
      copy: "Напиши, за що можна рекомендувати майстра. Запис піде на модерацію.",
      button: "Надіслати рекомендацію"
    },
    complaint: {
      kicker: "Скарга",
      title: "Залишити скаргу",
      copy: "Опиши свій досвід без зайвих приватних даних. Запис піде на модерацію.",
      button: "Надіслати скаргу"
    },
    add: {
      kicker: "Додавання",
      title: "Додати майстра",
      copy: "Додай контакт майстра або бригади, щоб мешканці могли перевіряти номер.",
      button: "Додати майстра"
    },
    bot: {
      kicker: "Telegram",
      title: "Telegram-бот",
      copy: "Поки бот підключається, заявки можна залишати тут. Вони зберігаються на сервері.",
      button: "Надіслати заявку"
    },
    channel: {
      kicker: "Telegram",
      title: "Telegram-канал",
      copy: "Поки канал підключається, важливі заявки можна залишати через цю форму.",
      button: "Надіслати заявку"
    }
  };

  const requestedType = params.get("type") || "recommend";
  const initialType = pageByType[requestedType] ? requestedType : "recommend";

  typeSelect.value = initialType;
  phoneInput.value = params.get("phone") || "";
  updatePage(initialType);

  typeSelect.addEventListener("change", () => updatePage(typeSelect.value));
  form.addEventListener("submit", handleSubmit);

  function updatePage(type) {
    const page = pageByType[type] || pageByType.recommend;
    kicker.textContent = page.kicker;
    title.textContent = page.title;
    copy.textContent = page.copy;
    submitButton.textContent = page.button;
    document.title = `${page.title} | Black List Світло парк`;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    clearStatus();

    const payload = collectPayload();
    const validationError = validatePayload(payload);

    if (validationError) {
      showStatus(validationError, "error");
      return;
    }

    submitButton.disabled = true;
    showStatus("Відправляємо заявку...", "loading");

    try {
      const response = await fetch(config.submissionApiUrl || "/api/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || "submission_failed");
      }

      form.reset();
      typeSelect.value = payload.type;
      updatePage(payload.type);
      showStatus(
        result.telegramSent
          ? "Готово. Заявку прийнято і відправлено в Telegram."
          : "Готово. Заявку прийнято на сервері, Telegram-відправка ще не підключена.",
        "success"
      );
    } catch (error) {
      showStatus(
        "Не вдалося відправити заявку. Якщо сайт відкритий не з основного домену, спробуй після деплою на сервер.",
        "error"
      );
    } finally {
      submitButton.disabled = false;
    }
  }

  function collectPayload() {
    const data = new FormData(form);
    return {
      type: clean(data.get("type")),
      phone: normalizePhone(data.get("phone")),
      rawPhone: clean(data.get("phone")),
      masterName: clean(data.get("masterName")),
      category: clean(data.get("category")),
      text: clean(data.get("text")),
      authorName: clean(data.get("authorName")) || "Анонімно",
      authorContact: clean(data.get("authorContact")),
      photoUrl: clean(data.get("photoUrl")),
      sourceUrl: window.location.href,
      userAgent: navigator.userAgent
    };
  }

  function validatePayload(payload) {
    if (!pageByType[payload.type]) {
      return "Обери тип заявки.";
    }

    if (!payload.phone && !payload.masterName) {
      return "Вкажи телефон або імʼя майстра.";
    }

    if (payload.phone && !/^\+380\d{9}$/.test(payload.phone)) {
      return "Телефон має бути у форматі +380XXXXXXXXX.";
    }

    if (payload.text.length < 8) {
      return "Додай хоча б кілька слів у текст заявки.";
    }

    return "";
  }

  function normalizePhone(value) {
    const cleaned = clean(value).replace(/[^\d+]/g, "");
    const digits = cleaned.replace(/\D/g, "");

    if (!digits) {
      return "";
    }

    if (digits.length === 9) {
      return `+380${digits}`;
    }

    if (digits.length === 10 && digits.startsWith("0")) {
      return `+38${digits}`;
    }

    if (digits.length === 12 && digits.startsWith("380")) {
      return `+${digits}`;
    }

    return cleaned.startsWith("+") ? cleaned : `+${digits}`;
  }

  function clean(value) {
    return String(value || "").trim().slice(0, 2000);
  }

  function clearStatus() {
    status.textContent = "";
    status.className = "form-status";
  }

  function showStatus(message, tone) {
    status.textContent = message;
    status.className = `form-status form-status--${tone}`;
  }
})();
