# Black List Світло парк

Проста мобільна головна сторінка для перевірки майстра по номеру телефону.
На головній є пошук, категорії послуг, список рекомендованих майстрів і останні записи з black list.
Клік по майстру відкриває `profile.html` з телефонами, категоріями, фото робіт і відгуками.

Детальний аналіз поточної моделі та наступного кроку: `SYSTEM_ANALYSIS.md`.

## Google Sheets

Пошук і списки на головній читають публічний CSV листа `Phones` у Google Sheets:

```js
phonesCsvUrl: "https://docs.google.com/spreadsheets/d/1nUh-orSW5NA7F0_sCdcNm3folUEhQeZWS72RoD8nvDE/export?format=csv&gid=0"
```

Локальний файл `data/phones.csv` залишено як резервну тестову копію з такою самою структурою. Якщо буде інша Google Sheets таблиця, опублікуй лист `Phones` як CSV і заміни URL у `config.js`:

```js
phonesCsvUrl: "https://docs.google.com/spreadsheets/d/<SHEET_ID>/export?format=csv&gid=<PHONES_GID>"
```

Очікувані колонки листа:

- `primary_phone`
- `display_name`
- `category_name`
- `telegram_username`
- `positive_reviews_count`
- `negative_reviews_count`
- `last_review_at`
- `last_review_text`
- `master_photo_url`
- `work_photo_urls`
- `review_1_author`, `review_1_type`, `review_1_date`, `review_1_text`, `review_1_photo_url`
- `profile_url` або `master_id`

Додаткові кнопки також налаштовуються у `config.js` через блок `links`.

## Заявки

Кнопки рекомендації, скарги й додавання майстра ведуть на `submit.html`.
На серверному деплої форма відправляє JSON у `POST /api/submissions`.
Сервер зберігає заявки у `runtime/submissions.jsonl`.

Telegram-відправка вмикається через env:

```bash
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=bl_svitlopark_bot
TELEGRAM_CHAT_ID=
TELEGRAM_WEBHOOK_SECRET=
```

Якщо ці значення порожні, заявка все одно зберігається на сервері, але не
відправляється в Telegram.

Бот: `@bl_svitlopark_bot`.
Webhook endpoint: `POST /api/telegram/webhook`.
Бот відповідає на `/start`, `/help` і номер телефону у форматі `+380...` або `067...`.

## Деплой

Проєкт готовий для VPS із Docker + Traefik:

```bash
docker compose up -d --build
```

Основний домен після DNS: `http://bl-svitlopark.maxicolabs.com/`.
Тестовий домен до налаштування DNS: `https://bl-svitlopark.13.140.186.201.sslip.io/`.

Для фінального домену потрібен DNS A-запис:

```text
bl-svitlopark.maxicolabs.com -> 13.140.186.201
```
