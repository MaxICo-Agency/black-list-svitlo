# ЧАЕС Світлопарк

Проста мобільна головна сторінка для перевірки майстра по номеру телефону.

## Google Sheets

Пошук читає публічний CSV листа `Phones`. URL вказується у `config.js`:

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
- `profile_url` або `master_id`

Додаткові кнопки також налаштовуються у `config.js` через блок `links`.
