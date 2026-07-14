(function () {
  const config = window.CHSP_CONFIG || {};
  const params = new URLSearchParams(window.location.search);
  const type = ["recommend", "complaint", "add"].includes(params.get("type")) ? params.get("type") : "recommend";
  const digits = String(params.get("phone") || "").replace(/\D/g, "");
  const actionKey = type === "add" ? "addMaster" : type;
  const fallback = `https://telegram.me/bl_svitlopark_bot?start=${type}`;
  const url = new URL(config.links?.[actionKey] || fallback);
  url.searchParams.set("start", digits ? `${type}_${digits}` : type);
  const target = url.toString();
  const link = document.querySelector("#telegram-submit-link");
  const title = document.querySelector("#submit-title");
  const labels = {
    recommend: "Рекомендація у Telegram",
    complaint: "Скарга у Telegram",
    add: "Анкета майстра у Telegram"
  };
  title.textContent = labels[type];
  link.href = target;
  window.setTimeout(() => window.location.replace(target), 500);
})();
