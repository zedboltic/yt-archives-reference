const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const wanakana = require("wanakana");

const AUTOMATION_MARKER = /<!-- noun-review-automation:v1:([A-Za-z0-9_-]+) -->/u;
const NOUN_FILE_KINDS = new Map([
  ["noun_activity_event.yaml", "活動・イベント・企画"],
  ["noun_game.yaml", "ゲーム"],
  ["noun_organization_group.yaml", "組織・団体・グループ・ユニット"],
  ["noun_person_character.yaml", "人物・キャラクター"],
  ["noun_place_facility.yaml", "場所・施設・空間"],
  ["noun_product.yaml", "商品・コンテンツ・サービス"],
  ["noun_talent.yaml", "タレント"],
  ["noun_term_concept.yaml", "用語・概念・その他"],
]);

function normalizeComparableJapaneseText(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\s+/gu, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[：:／/]/gu, "")
    .replace(/[-‐‑–—―ー－]/gu, "")
    .replace(/[・･]/gu, "")
    .replace(/[~〜～]/gu, "")
    .replace(/[()（）\[\]{}【】「」『』<>＜＞]/gu, "")
    .replace(/[!"#$%'*=+?@^_`|\\.,;，、。！？“”‘’„‟‹›«»]/gu, "")
    .replace(/\s+/gu, "")
    .trim();
  return wanakana.toKatakana(normalized, { passRomaji: true });
}

function parseAutomationMetadata(body) {
  const match = String(body || "").match(AUTOMATION_MARKER);
  if (!match) throw new Error("PR本文にnoun-review automation metadataがありません");

  let metadata;
  try {
    metadata = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  } catch (error) {
    throw new Error(`automation metadataを解析できません: ${error.message}`);
  }
  if (metadata?.schemaVersion !== 1) throw new Error("automation metadataのschemaVersionが不正です");
  if (metadata?.action !== "pull_request") throw new Error("automation metadataのactionがpull_requestではありません");
  if (metadata?.autoApproveEligible !== true) throw new Error("autoApproveEligibleがtrueではありません");
  if (!metadata?.planKey || !metadata?.dictionaryUpdate?.kind || !metadata?.dictionaryUpdate?.canonicalName) {
    throw new Error("automation metadataの必須項目が不足しています");
  }
  return metadata;
}

function validatePullRequestEvent(event, expectedAuthor = "") {
  const pullRequest = event?.pull_request;
  if (!pullRequest) throw new Error("pull_request eventではありません");
  if (pullRequest.state !== "open") throw new Error("PRがopenではありません");
  if (pullRequest.draft) throw new Error("draft PRは自動マージしません");
  if (pullRequest.head?.repo?.full_name !== event.repository?.full_name) {
    throw new Error("fork由来のPRは自動マージしません");
  }
  if (!String(pullRequest.head?.ref || "").startsWith("noun-review/")) {
    throw new Error("noun-review/*以外のブランチは自動マージしません");
  }
  if (pullRequest.base?.ref !== event.repository?.default_branch) {
    throw new Error("default branch宛てではないPRは自動マージしません");
  }
  if (expectedAuthor && pullRequest.user?.login !== expectedAuthor) {
    throw new Error(`PR作成者が指定のGitHub Appではありません: ${pullRequest.user?.login || "unknown"}`);
  }
  return parseAutomationMetadata(pullRequest.body);
}

function validateChangedFiles(fileNames) {
  if (!Array.isArray(fileNames) || fileNames.length === 0) {
    throw new Error("変更ファイルがありません");
  }
  const invalid = fileNames.filter((fileName) => !NOUN_FILE_KINDS.has(fileName));
  if (invalid.length > 0) {
    throw new Error(`noun_*.yaml以外の変更を含んでいます: ${invalid.join(", ")}`);
  }
}

function assertStringArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label}は文字列配列である必要があります`);
  }
  return value;
}

function validateNounDirectory(directory) {
  const aliasesByKind = new Map();
  let entryCount = 0;

  for (const [fileName, expectedKind] of NOUN_FILE_KINDS) {
    const filePath = path.join(directory, fileName);
    if (!fs.existsSync(filePath)) throw new Error(`${fileName}がありません`);

    let document;
    try {
      document = YAML.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new Error(`${fileName}をYAMLとして解析できません: ${error.message}`);
    }
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      throw new Error(`${fileName}のルートはオブジェクトである必要があります`);
    }
    if (document.version !== 1) throw new Error(`${fileName}のversionは1である必要があります`);
    if (document.kind !== expectedKind) {
      throw new Error(`${fileName}のkindは「${expectedKind}」である必要があります`);
    }
    if (!Array.isArray(document.entries)) throw new Error(`${fileName}のentriesは配列である必要があります`);
    if (document.comment !== undefined) assertStringArray(document.comment, `${fileName}.comment`);

    for (const [index, entry] of document.entries.entries()) {
      const label = `${fileName} entry ${index + 1}`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`${label}はオブジェクトである必要があります`);
      }
      const canonicalName = typeof entry.canonicalName === "string" ? entry.canonicalName.trim() : "";
      if (!canonicalName) throw new Error(`${label}にcanonicalNameが必要です`);
      const aliases = assertStringArray(entry.aliases, `${label}.aliases`);
      const hypernyms = assertStringArray(entry.hypernyms, `${label}.hypernyms`);
      if (aliases.some((alias) => !alias.trim())) throw new Error(`${label}.aliasesに空文字列があります`);
      if (hypernyms.some((hypernym) => !hypernym.trim())) throw new Error(`${label}.hypernymsに空文字列があります`);

      for (const text of [canonicalName, ...aliases]) {
        const normalized = normalizeComparableJapaneseText(text);
        if (!normalized) throw new Error(`${label}に正規化後空になる名称があります`);
        const key = `${expectedKind}\t${normalized}`;
        const existing = aliasesByKind.get(key);
        if (existing && existing.canonicalName !== canonicalName) {
          throw new Error(
            `正規化後の名称が同一kind内で衝突しています: kind=${expectedKind} name=${text} canonicalName=${canonicalName} conflictsWith=${existing.canonicalName}`,
          );
        }
        if (!existing) aliasesByKind.set(key, { canonicalName, fileName, index });
      }
      entryCount += 1;
    }
  }

  return { files: NOUN_FILE_KINDS.size, entries: entryCount, normalizedNames: aliasesByKind.size };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function main(argv = process.argv.slice(2)) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) options.set(argv[index], argv[index + 1]);
  const directory = path.resolve(options.get("--directory") || process.cwd());
  const eventPath = options.get("--event");
  const changedFilesPath = options.get("--changed-files");

  if (eventPath) validatePullRequestEvent(readJson(eventPath), options.get("--expected-author") || "");
  if (changedFilesPath) validateChangedFiles(readJson(changedFilesPath));
  const summary = validateNounDirectory(directory);
  process.stdout.write(`noun dictionary validation succeeded: files=${summary.files} entries=${summary.entries} normalizedNames=${summary.normalizedNames}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`noun dictionary validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  NOUN_FILE_KINDS,
  normalizeComparableJapaneseText,
  parseAutomationMetadata,
  validateChangedFiles,
  validateNounDirectory,
  validatePullRequestEvent,
};
