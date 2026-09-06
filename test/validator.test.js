const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  parseAutomationMetadata,
  validateChangedFiles,
  validateNounDirectory,
  validatePullRequestEvent,
} = require("../validator");

function metadataComment(overrides = {}) {
  const metadata = {
    schemaVersion: 1,
    planKey: "test-plan",
    action: "pull_request",
    autoApproveEligible: true,
    dictionaryUpdate: { kind: "ゲーム", canonicalName: "テスト" },
    ...overrides,
  };
  return `<!-- noun-review-automation:v1:${Buffer.from(JSON.stringify(metadata)).toString("base64url")} -->`;
}

test("automation metadataを解析する", () => {
  assert.equal(parseAutomationMetadata(metadataComment()).planKey, "test-plan");
  assert.throws(() => parseAutomationMetadata(metadataComment({ autoApproveEligible: false })), /autoApproveEligible/u);
});

test("PRは同一repositoryのnoun-review branchだけを許可する", () => {
  const event = {
    repository: { full_name: "owner/reference", default_branch: "master" },
    pull_request: {
      state: "open",
      draft: false,
      body: metadataComment(),
      user: { login: "archive-app[bot]" },
      head: { ref: "noun-review/test", repo: { full_name: "owner/reference" } },
      base: { ref: "master" },
    },
  };
  assert.equal(validatePullRequestEvent(event, "archive-app[bot]").planKey, "test-plan");
  assert.throws(() => validatePullRequestEvent(event, "other-app[bot]"), /PR作成者/u);
  event.pull_request.head.repo.full_name = "attacker/fork";
  assert.throws(() => validatePullRequestEvent(event), /fork/u);
});

test("変更ファイルは既知のnoun YAMLだけを許可する", () => {
  validateChangedFiles(["noun_game.yaml"]);
  assert.throws(() => validateChangedFiles(["validator.js"]), /以外/u);
});

test("現在の辞書を検証できる", () => {
  const summary = validateNounDirectory(path.resolve(__dirname, ".."));
  assert.equal(summary.files, 8);
  assert.ok(summary.entries > 0);
});

test("同一kind内の正規化後衝突を拒否する", () => {
  const source = path.resolve(__dirname, "..");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "noun-validator-"));
  try {
    for (const fileName of fs.readdirSync(source).filter((name) => /^noun_.*\.yaml$/u.test(name))) {
      fs.copyFileSync(path.join(source, fileName), path.join(temporary, fileName));
    }
    fs.appendFileSync(path.join(temporary, "noun_game.yaml"), [
      "  - canonicalName: 衝突A",
      "    aliases:",
      "      - validator collision",
      "  - canonicalName: 衝突B",
      "    aliases:",
      "      - validator-collision",
      "",
    ].join("\n"));
    assert.throws(() => validateNounDirectory(temporary), /衝突/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
