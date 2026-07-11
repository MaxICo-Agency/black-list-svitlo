# Black List Світло парк

Проста мобільна головна сторінка для перевірки майстра по номеру телефону.
На головній є пошук, категорії послуг, список рекомендованих майстрів і останні записи з black list.
Клік по майстру відкриває `profile.html` з телефонами, категоріями, фото робіт і відгуками.

Детальний аналіз поточної моделі та наступного кроку: `SYSTEM_ANALYSIS.md`.

## Дані

Браузер читає `GET /api/phones`. Сервер об'єднує базовий Google Sheets CSV із
заявками, які адміністратор підтвердив у Telegram-групі. Тому схвалений запис
одразу з'являється в пошуку, профілях, послугах і списках на головній.

Локальний `data/phones.csv` залишається резервною копією, якщо Google Sheets
тимчасово недоступний. Базовий URL задається лише на сервері через
`PHONES_CSV_URL`; у клієнтському `config.js` він не публікується.

Приватна нормалізована база:
`https://docs.google.com/spreadsheets/d/1gjqPYDe6IUTdhFgLhLWTD-hkgyHZ0RMjVNVBpqXyfxo`.
Вона належить підключеному Drive-акаунту `all@maxico.agency` і має вкладки:

- `Masters` - одна картка майстра або бригади;
- `PhoneNumbers` - багато номерів для одного `master_id`;
- `Categories` - довідник послуг;
- `MasterCategories` - багато послуг для одного майстра;
- `Reviews` - кожен відгук окремим рядком;
- `Photos` - фото робіт і відгуків;
- `Directory` - сумісний матеріалізований каталог;
- `ModerationQueue` і `Settings` - черга та системні параметри.

Станом на 2026-07-11 продакшн повертає 20 записів: 12 базових і 8
унікальних рекомендацій, які були перевірені в Telegram-чатах, схвалені
у приватній групі модерації та опубліковані в `@blacklist_svitlopark`. Ці ж
дані синхронізовано в приватну таблицю: 20 майстрів, 26 номерів і 44 окремих
відгуки.

Поточний продакшн поки читає старий публічний CSV. Для переходу на приватну
базу VPS потрібен Google service account із read-доступом.

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
Сервер зберігає заявки у `runtime/submissions.jsonl`, а рішення модератора - у
`runtime/moderation-events.jsonl`.
Фото робіт або скарг не завантажуються в Google Drive: користувач надсилає їх
окремо в Telegram-бот, а бот копіює фото в модераційний Telegram-чат.

Telegram-відправка вмикається через env:

```bash
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=bl_svitlopark_bot
TELEGRAM_CHAT_ID=
TELEGRAM_WEBHOOK_SECRET=
TELEGRAM_ADMIN_USER_ID=
TELEGRAM_PUBLIC_CHAT_ID=
TELEGRAM_PUBLIC_URL=https://t.me/blacklist_svitlopark
```

Якщо ці значення порожні, заявка все одно зберігається на сервері, але не
відправляється в Telegram.

Бот: `@bl_svitlopark_bot`.
Публічний канал: `@blacklist_svitlopark`.
Webhook endpoint: `POST /api/telegram/webhook`.
Бот відповідає на `/start`, `/search`, `/categories`, `/blacklist`,
`/recommend`, `/complaint`, `/channel`, `/help` і номер телефону у форматі
`+380...` або `067...`.

У приватній групі модератор натискає `Додати до бази` або `Відхилити`.
Підтверджена заявка одразу потрапляє в API сайту та публічний канал. Фото з
deep-link `photo_<submission_id>` копіюються в модераційну групу з ID заявки.

## Деплой

Проєкт готовий для VPS із Docker + Traefik:

```bash
docker compose up -d --build
```

Основний домен: `https://bl-svitlopark.maxicolabs.com/`.
Тестовий домен до налаштування DNS: `https://bl-svitlopark.13.140.186.201.sslip.io/`.

Для фінального домену потрібен DNS A-запис:

```text
bl-svitlopark.maxicolabs.com -> 13.140.186.201
```
