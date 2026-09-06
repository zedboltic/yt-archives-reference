const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { NOUN_FILE_KINDS, normalizeComparableJapaneseText } = require("./validator");

function readYaml(text, label) {
  const document = YAML.parseDocument(text, { prettyErrors: true });
  if (document.errors.length > 0) {
    throw new Error(`${label}をYAMLとして解析できません: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  const value = document.toJSON();
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.entries)) {
    throw new Error(`${label}のentriesが不正です`);
  }
  return { document, value };
}

function entriesByCanonicalName(entries, label) {
  const result = new Map();
  for (const entry of entries) {
    const canonicalName = typeof entry?.canonicalName === "string" ? entry.canonicalName.trim() : "";
    if (!canonicalName) throw new Error(`${label}にcanonicalNameのないentryがあります`);
    const group = result.get(canonicalName) || [];
    group.push(entry);
    result.set(canonicalName, group);
  }
  return result;
}

function strings(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label}は文字列配列である必要があります`);
  }
  return value;
}

function staticEntry(entry) {
  const result = { ...entry };
  delete result.aliases;
  delete result.hypernyms;
  return result;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function consolidateEntryGroup(entries, label) {
  if (entries.length === 0) throw new Error(`${label}にentryがありません`);
  const first = entries[0];
  const firstStatic = staticEntry(first);
  if (entries.some((entry) => !sameJson(staticEntry(entry), firstStatic))) {
    throw new Error(`${label}の重複canonicalNameに異なる属性があります`);
  }
  return {
    entryCount: entries.length,
    static: firstStatic,
    aliases: [...new Set(entries.flatMap((entry) => strings(entry.aliases, `${label}.aliases`)))],
    hypernyms: [...new Set(entries.flatMap((entry) => strings(entry.hypernyms, `${label}.hypernyms`)))],
  };
}

function addedValues(baseValues, headValues, label) {
  const base = strings(baseValues, `${label}.base`);
  const head = strings(headValues, `${label}.head`);
  const baseSet = new Set(base);
  if (base.some((value) => !head.includes(value))) {
    throw new Error(`${label}に削除または変更があります`);
  }
  return head.filter((value) => !baseSet.has(value));
}

function deriveFileOperations(baseText, headText, fileName) {
  const expectedKind = NOUN_FILE_KINDS.get(fileName);
  if (!expectedKind) throw new Error(`許可されていない辞書ファイルです: ${fileName}`);
  const base = readYaml(baseText, `${fileName} base`).value;
  const head = readYaml(headText, `${fileName} PR head`).value;
  if (base.version !== head.version || base.kind !== head.kind || base.kind !== expectedKind || !sameJson(base.comment, head.comment)) {
    throw new Error(`${fileName}のroot metadata変更は自動rebaseできません`);
  }

  const baseEntries = entriesByCanonicalName(base.entries, `${fileName} base`);
  const headEntries = entriesByCanonicalName(head.entries, `${fileName} PR head`);
  const operations = [];
  for (const [canonicalName, baseGroup] of baseEntries) {
    const headGroup = headEntries.get(canonicalName);
    if (!headGroup) throw new Error(`${fileName}からentryが削除されています: ${canonicalName}`);
    const baseEntry = consolidateEntryGroup(baseGroup, `${fileName} base ${canonicalName}`);
    const headEntry = consolidateEntryGroup(headGroup, `${fileName} PR head ${canonicalName}`);
    if (baseEntry.entryCount !== headEntry.entryCount) {
      throw new Error(`${fileName}の重複entry数変更は自動rebaseできません: ${canonicalName}`);
    }
    if (!sameJson(baseEntry.static, headEntry.static)) {
      throw new Error(`${fileName}のentry属性変更は自動rebaseできません: ${canonicalName}`);
    }
    const aliases = addedValues(baseEntry.aliases, headEntry.aliases, `${fileName}.${canonicalName}.aliases`);
    const hypernyms = addedValues(baseEntry.hypernyms, headEntry.hypernyms, `${fileName}.${canonicalName}.hypernyms`);
    if (aliases.length || hypernyms.length) operations.push({ canonicalName, aliases, hypernyms, entry: null });
  }
  for (const [canonicalName, entryGroup] of headEntries) {
    if (!baseEntries.has(canonicalName)) {
      if (entryGroup.length !== 1) throw new Error(`${fileName}の新規canonicalNameが重複しています: ${canonicalName}`);
      const [entry] = entryGroup;
      strings(entry.aliases, `${fileName}.${canonicalName}.aliases`);
      strings(entry.hypernyms, `${fileName}.${canonicalName}.hypernyms`);
      operations.push({ canonicalName, aliases: entry.aliases || [], hypernyms: entry.hypernyms || [], entry });
    }
  }
  return operations;
}

function findEntryNode(entries, canonicalName) {
  return entries.items.find((item) => String(item.get("canonicalName") || "").trim() === canonicalName) || null;
}

function appendUnique(node, values, canonicalName, fieldName) {
  const existing = new Set((node.toJSON() || []).map((value) => normalizeComparableJapaneseText(value)));
  for (const value of values) {
    const text = String(value || "").trim();
    const normalized = normalizeComparableJapaneseText(text);
    if (!normalized || existing.has(normalized) || (fieldName === "hypernyms" && text === canonicalName)) continue;
    node.add(text);
    existing.add(normalized);
  }
}

function ensureSequence(document, entryNode, fieldName) {
  let node = entryNode.get(fieldName, true);
  if (!node) {
    node = document.createNode([]);
    entryNode.set(fieldName, node);
  }
  if (!Array.isArray(node.items)) throw new Error(`${fieldName}は配列である必要があります`);
  return node;
}

function applyFileOperations(targetText, fileName, operations) {
  const expectedKind = NOUN_FILE_KINDS.get(fileName);
  const { document, value } = readYaml(targetText, `${fileName} latest default branch`);
  if (value.version !== 1 || value.kind !== expectedKind) throw new Error(`${fileName}のroot metadataが不正です`);
  const entries = document.get("entries", true);
  if (!entries || !Array.isArray(entries.items)) throw new Error(`${fileName}のentriesが不正です`);

  let changed = false;
  for (const operation of operations) {
    let target = findEntryNode(entries, operation.canonicalName);
    if (!target) {
      if (!operation.entry) throw new Error(`${fileName}の既存entryがlatest default branchにありません: ${operation.canonicalName}`);
      entries.add(document.createNode(operation.entry));
      changed = true;
      continue;
    }
    if (operation.entry) {
      const targetValue = target.toJSON();
      if (!sameJson(staticEntry(targetValue), staticEntry(operation.entry))) {
        throw new Error(`${fileName}の新規entryがlatest default branchの既存entryと競合します: ${operation.canonicalName}`);
      }
    }
    const aliases = ensureSequence(document, target, "aliases");
    const hypernyms = ensureSequence(document, target, "hypernyms");
    const beforeAliases = aliases.items.length;
    const beforeHypernyms = hypernyms.items.length;
    appendUnique(aliases, operation.aliases, operation.canonicalName, "aliases");
    appendUnique(hypernyms, operation.hypernyms, operation.canonicalName, "hypernyms");
    changed ||= aliases.items.length !== beforeAliases || hypernyms.items.length !== beforeHypernyms;
  }
  return { changed, text: document.toString(), operationCount: operations.length };
}

function gitShow(repository, ref, fileName) {
  return execFileSync("git", ["show", `${ref}:${fileName}`], { cwd: repository, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function main(argv = process.argv.slice(2)) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) options.set(argv[index], argv[index + 1]);
  const repository = path.resolve(options.get("--repository") || "");
  const baseRef = options.get("--base-ref");
  const headRef = options.get("--head-ref");
  const changedFilesPath = options.get("--changed-files");
  if (!repository || !baseRef || !headRef) throw new Error("--repository, --base-ref, --head-refが必要です");

  const changedFiles = changedFilesPath
    ? JSON.parse(fs.readFileSync(changedFilesPath, "utf8"))
    : execFileSync("git", ["diff", "--name-only", `${baseRef}...${headRef}`], { cwd: repository, encoding: "utf8" })
      .split(/\r?\n/u)
      .filter(Boolean);
  if (!Array.isArray(changedFiles) || changedFiles.some((fileName) => !NOUN_FILE_KINDS.has(fileName))) {
    throw new Error("変更ファイルは許可されたnoun_*.yamlだけである必要があります");
  }

  const summary = [];
  for (const fileName of changedFiles) {
    const operations = deriveFileOperations(gitShow(repository, baseRef, fileName), gitShow(repository, headRef, fileName), fileName);
    const targetPath = path.join(repository, fileName);
    const applied = applyFileOperations(fs.readFileSync(targetPath, "utf8"), fileName, operations);
    if (applied.changed) fs.writeFileSync(targetPath, applied.text, "utf8");
    summary.push({ fileName, operations: applied.operationCount, changed: applied.changed });
  }
  process.stdout.write(`${JSON.stringify({ files: summary }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`logical noun rebase failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { applyFileOperations, deriveFileOperations };
