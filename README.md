# Black List Світло парк

Мобільний сервіс для пошуку майстрів за номером телефону, перегляду
рекомендацій і скарг мешканців ЖК Svitlo Park.

- сайт: `https://bl-svitlopark.maxicolabs.com/`;
- бот: `https://telegram.me/bl_svitlopark_bot`;
- канал: `https://telegram.me/blacklist_svitlopark`.

## Потік даних

Сайт читає єдиний каталог через `GET /api/phones`. Каталог складається зі
схвалених записів у `runtime/submissions.jsonl` та рішень у
`runtime/moderation-events.jsonl`. Локальний `data/phones.csv` містить тільки
заголовки й використовується як технічна основа, а не як демо-база.

Приватна Google Sheet:
`https://docs.google.com/spreadsheets/d/1gjqPYDe6IUTdhFgLhLWTD-hkgyHZ0RMjVNVBpqXyfxo/edit`.

Нормалізовані вкладки зберігають окремо майстрів, номери, послуги, зв'язки,
відгуки й фото. Вкладка `LiveDirectory` імпортує поточний CSV безпосередньо з
`https://bl-svitlopark.maxicolabs.com/api/phones`, тому таблиця залишається
дзеркалом опублікованого каталогу. Сервер не потребує публічного Google CSV.

## Telegram-first заявки

Форм на сайті немає. Рекомендація, скарга або анкета майстра відкриває бота з
відповідним deep-link. Бот послідовно збирає:

- до 10 телефонів;
- ім'я майстра або назву бригади;
- Telegram username, якщо він відомий;
- одну або кілька послуг;
- текст досвіду й ім'я автора або анонімний режим;
- до 10 фотографій.

Заявка приходить у приватну Telegram-групу. Модератор може схвалити її або
відхилити з причиною: недостатньо доказів, бракує деталей/фото, дублікат,
спам, некоректний контакт чи інша причина. Тільки схвалений запис потрапляє у
пошук і публічний канал. Фотографії залишаються в Telegram та відображаються
лише у відповідному відгуку через захищений media proxy.

Веб-ендпоінт `POST /api/submissions` навмисно повертає `410 telegram_only`.

## Чисті маршрути

- `/` - пошук і головна;
- `/profile?phone=...` - профіль майстра;
- `/services?service=...` - послуга;
- `/recommendations` - усі рекомендації;
- `/complaints` - усі схвалені скарги;
- `/rules` і `/privacy` - правила та приватність.

Старі URL із `.html` перенаправляються на чисті маршрути з кодом `301`.

## Конфігурація

```bash
PUBLIC_SITE_URL=https://bl-svitlopark.maxicolabs.com
PHONES_CSV_URL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=bl_svitlopark_bot
TELEGRAM_CHAT_ID=
TELEGRAM_WEBHOOK_SECRET=
TELEGRAM_ADMIN_USER_ID=
TELEGRAM_PUBLIC_CHAT_ID=
TELEGRAM_PUBLIC_URL=https://telegram.me/blacklist_svitlopark
```

## Перевірка та деплой

```bash
npm run check
docker compose up -d --build
```

Docker-контейнер працює за Traefik на домені
`https://bl-svitlopark.maxicolabs.com/`.
