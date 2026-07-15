"use strict";

const token = process.env.TELEGRAM_BOT_TOKEN || "";
const siteUrl = process.env.PUBLIC_SITE_URL || "https://bl-svitlopark.maxicolabs.com";

const commands = [
  { command: "start", description: "Головне меню" },
  { command: "search", description: "Перевірити номер" },
  { command: "recommend", description: "Порекомендувати майстра" },
  { command: "complaint", description: "Залишити скаргу" },
  { command: "my", description: "Мої заявки" },
  { command: "contact", description: "Звʼязатися з адміністрацією" },
  { command: "help", description: "Допомога" }
];

async function main() {
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required.");
  }

  await request("setMyCommands", { commands });
  await request("setMyDescription", {
    description: "Перевіряй майстрів за номером телефону, залишай рекомендації та скарги мешканців ЖК Світло парк. Усі записи проходять модерацію."
  });
  await request("setMyShortDescription", {
    short_description: "Пошук рекомендацій і скарг на майстрів за номером телефону."
  });
  await request("setChatMenuButton", {
    menu_button: {
      type: "web_app",
      text: "Відкрити пошук",
      web_app: { url: siteUrl }
    }
  });

  console.log(JSON.stringify({ configured: true, commands: commands.map((item) => item.command) }));
}

async function request(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(`${method}: ${body.description || response.status}`);
  }
  return body.result;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
