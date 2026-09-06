const assert = require("node:assert/strict");
const test = require("node:test");
const YAML = require("yaml");
const { applyFileOperations, deriveFileOperations } = require("../rebase_noun_review_pr");

const base = `version: 1
kind: ゲーム
comment:
  - test
entries:
  - canonicalName: 既存作品
    aliases:
      - old
`;

test("追加だけを最新辞書へ論理的に適用する", () => {
  const head = `${base}  - canonicalName: 新規作品
    aliases:
      - new
`;
  const latest = `${base}  - canonicalName: 別の新規作品
`;
  const operations = deriveFileOperations(base, head, "noun_game.yaml");
  const result = applyFileOperations(latest, "noun_game.yaml", operations);
  const entries = YAML.parse(result.text).entries;
  assert.equal(result.changed, true);
  assert.deepEqual(entries.map((entry) => entry.canonicalName), ["既存作品", "別の新規作品", "新規作品"]);
});

test("削除を含むPRは論理的rebaseの対象外にする", () => {
  const head = base.replace("    aliases:\n      - old\n", "    aliases: []\n");
  assert.throws(() => deriveFileOperations(base, head, "noun_game.yaml"), /削除/u);
});
