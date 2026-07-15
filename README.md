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
відповідним deep-link. Бот тримає форму в одному повідомленні, оновлює його на
кожному кроці й послідовно збирає:

- до 10 телефонів;
- ім'я майстра або назву бригади;
- Telegram username, якщо він відомий;
- одну або кілька послуг;
- текст досвіду й ім'я автора або анонімний режим;
- до 10 фотографій.

Заявка приходить у приватну Telegram-групу. Модератор може схвалити її або
відхилити з причиною: недостатньо доказів, бракує деталей/фото, дублікат,
спам, некоректний контакт чи власна текстова причина. Тільки схвалений запис
потрапляє у пошук і публічний канал. Після рішення бот повідомляє автора про
схвалення або відхилення, показує причину й дає прямий контакт адміністратора.
Для причини `спам або реклама` окремо пропонується анкета майстра. Фотографії
залишаються в Telegram та відображаються лише у відповідному відгуку через
захищений media proxy.

У головному меню бота лишилися пошук, рекомендація, скарга, `Мої заявки` та
контакт адміністрації. `Стати майстром` відкривається із сайту, а не дублюється
на кожному екрані бота. У `Моїх заявках` автор може змінити текст уже
розглянутого відгуку або переключити рекомендацію на скаргу. На модерацію
надходить нова версія, а попередня залишається активною до її схвалення.

Структуровані результати, картки модерації та публікації каналу використовують
Telegram Bot API 10.2 Rich Messages: нативні заголовки, списки, цитати,
роздільники й приховану службову інформацію. Короткі кроки діалогу залишаються
regular HTML-повідомленнями. Для Rich Messages передбачено автоматичний
fallback на regular HTML. Кнопки використовують нативні стилі `primary`,
`success` і `danger`.

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
TELEGRAM_ADMIN_USERNAME=max_shapoval
TELEGRAM_PUBLIC_CHAT_ID=
TELEGRAM_PUBLIC_URL=https://telegram.me/blacklist_svitlopark
```

## Перевірка та деплой

```bash
npm run check
npm test
npm run telegram:configure     # команди, опис і кнопка Mini App
npm run telegram:refresh       # dry-run оновлення існуючих Telegram-карток
npm run telegram:refresh -- --apply
docker compose up -d --build
```

Для оновлення ще не розглянутих старих заявок можна тимчасово передати
відповідність `submission_id -> message_id` через змінну
`TELEGRAM_PENDING_MESSAGES`. Refresh-скрипт не створює нових публікацій: він
редагує повідомлення на місці та зберігає їхні ID і закріплення.

Docker-контейнер працює за Traefik на домені
`https://bl-svitlopark.maxicolabs.com/`.
