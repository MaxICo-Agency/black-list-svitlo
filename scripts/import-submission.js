"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { saveSubmission, sendTelegram } = require("../server");

const runtimeDir = process.env.RUNTIME_DIR || path.join(__dirname, "..", "runtime");
const submissionsFile = path.join(runtimeDir, "submissions.jsonl");

async function main() {
  const encoded = process.argv[2] || "";
  if (!encoded) {
    throw new Error("Pass a base64-encoded JSON submission as the first argument.");
  }

  const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const existing = await readJsonLines(submissionsFile);
  const duplicate = existing.find((submission) => (
    payload.sourceUrl &&
    submission.sourceUrl === payload.sourceUrl &&
    submission.type === payload.type &&
    digits(submission.phone) === digits(payload.phone)
  ));

  if (duplicate) {
    console.log(JSON.stringify({ imported: false, duplicate: true, id: duplicate.id }));
    return;
  }

  const saved = await saveSubmission(payload);
  const telegram = await sendTelegram(saved);
  console.log(JSON.stringify({
    imported: true,
    id: saved.id,
    moderationSent: telegram.sent,
    moderationMessageId: telegram.messageId || ""
  }));
}

async function readJsonLines(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
