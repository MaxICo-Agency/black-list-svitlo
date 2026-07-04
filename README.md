# Black List Світло парк

Проста мобільна головна сторінка для перевірки майстра по номеру телефону.
На головній є пошук, категорії послуг, список рекомендованих майстрів і останні записи з black list.

## Google Sheets

Пошук і списки на головній читають CSV листа `Phones`. Зараз підключені тестові дані:

```js
phonesCsvUrl: "data/phones.csv"
```

Коли буде реальна Google Sheets таблиця, опублікуй лист `Phones` як CSV і заміни URL у `config.js`:

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
- `profile_url` або `master_id`

Додаткові кнопки також налаштовуються у `config.js` через блок `links`.
