import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  authorshipClaimsIn,
  commitMessageProblemsIn,
  pathProblemsIn,
  readCommitMessages,
  readRepo,
  verifyDocsSplit,
} from './docs-split.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const cleanPaths = ['README.md', 'apps/app/src/audit.ts', 'apps/cli/src/prompt.ts', 'tests/harness/e2e/shell.spec.ts'];

const clean = () => ({
  paths: [...cleanPaths],
  documents: { 'README.md': '# HolyDeck\n' },
  sources: { 'apps/app/src/main.ts': "export const port = 3000;\n" },
});

test('a repository with nothing forbidden has nothing to report', () => {
  assert.deepEqual(verifyDocsSplit(clean()), []);
});

test('flags an exact AI instruction filename, case-insensitively', () => {
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'claude.md']) {
    assert.deepEqual(pathProblemsIn([name]), [
      `${name}: an AI coding assistant's own instruction file has no place in this public repository`,
    ]);
  }
});

test('leaves an unrelated markdown file with a similar name alone', () => {
  assert.deepEqual(pathProblemsIn(['CLAUDELIKE.md', 'docs/agents-overview.md']), []);
});

test('flags a file inside an AI tooling directory, wherever it sits', () => {
  assert.deepEqual(pathProblemsIn(['.claude/settings.json']), [
    '.claude/settings.json: sits inside .claude, which belongs in this project\'s private docs repository, not here',
  ]);
  assert.deepEqual(pathProblemsIn(['apps/app/.codex/notes.md']), [
    'apps/app/.codex/notes.md: sits inside .codex, which belongs in this project\'s private docs repository, not here',
  ]);
  assert.deepEqual(pathProblemsIn(['.cursor/rules.md']), [
    '.cursor/rules.md: sits inside .cursor, which belongs in this project\'s private docs repository, not here',
  ]);
  assert.deepEqual(pathProblemsIn(['.superpowers/sdd/task-1-brief.md']), [
    '.superpowers/sdd/task-1-brief.md: sits inside .superpowers, which belongs in this project\'s private docs repository, not here',
  ]);
});

test('flags a document named like a planning, prompt, audit, brief, report or review artifact', () => {
  for (const name of ['launch-plan.md', 'design-spec.md', 'session-prompt.txt', 'research-notes.md', 'security-audit.md', 'task-9-brief.md', 'task-9-report.md', 'code-review.md']) {
    assert.deepEqual(pathProblemsIn([name]), [
      `${name}: named like a planning, prompt, audit, brief, report or review artifact, which belongs in this project's private docs repository, not here`,
    ]);
  }
});

test('leaves a real shipped module named the same way alone, because it is not a document', () => {
  assert.deepEqual(
    pathProblemsIn([
      'apps/app/src/audit.ts',
      'apps/app/src/pptx-review.ts',
      'apps/app/src/run-review.ts',
      'apps/cli/src/prompt.ts',
      'apps/cli/src/prompt.test.ts',
      'tests/harness/e2e/accessibility.spec.ts',
      '.github/workflows/dependency-review.yml',
    ]),
    [],
  );
});

test('leaves README.md, CHANGELOG.md and the rest of the real docs alone', () => {
  assert.deepEqual(
    pathProblemsIn(['README.md', 'CHANGELOG.md', 'RELEASING.md', 'SECURITY.md', 'MAINTENANCE.md', 'apps/cli/README.md']),
    [],
  );
});

test('finds every forbidden path, not only the first', () => {
  assert.deepEqual(pathProblemsIn(['CLAUDE.md', 'plan.md']), [
    "CLAUDE.md: an AI coding assistant's own instruction file has no place in this public repository",
    "plan.md: named like a planning, prompt, audit, brief, report or review artifact, which belongs in this project's private docs repository, not here",
  ]);
});

test('flags a co-authored-by trailer wherever it appears, and where', () => {
  const problems = authorshipClaimsIn('first line\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
  assert.deepEqual(problems, [{ line: 2, column: 1, said: 'Co-Authored-By: C' }]);
});

test('flags a claude-session trailer', () => {
  const problems = authorshipClaimsIn('Claude-Session: https://claude.ai/code/session_01\n');
  assert.deepEqual(problems.map((found) => found.said), ['Claude-Session: h', 'claude.ai/code']);
});

test('flags a session link on its own', () => {
  assert.deepEqual(authorshipClaimsIn('See https://claude.ai/code/session_01 for details.\n'), [
    { line: 1, column: 13, said: 'claude.ai/code' },
  ]);
});

test('flags a credit phrase for each way it can be written', () => {
  const phrases = [
    'Generated with Claude Code',
    'written by ChatGPT',
    'built using Codex',
    'co-authored by Copilot',
    'implemented with Claude',
  ];
  for (const phrase of phrases) {
    assert.ok(authorshipClaimsIn(`${phrase}.\n`).length > 0, `expected a match for: ${phrase}`);
  }
});

test('flags a named tool brand even with no credit verb nearby', () => {
  assert.deepEqual(authorshipClaimsIn('Built with GitHub Copilot enabled in the editor.\n').map((found) => found.said), [
    'GitHub Copilot',
  ]);
});

test('leaves a bare vendor or model-id mention alone, because it is a product reference, not a credit', () => {
  const text =
    "This is the one place this package talks to the Anthropic Messages API, using model 'claude-haiku-4-5-20251001'.\n";
  assert.deepEqual(authorshipClaimsIn(text), []);
});

test('leaves the audit trail\'s integration-call fixture alone', () => {
  assert.deepEqual(authorshipClaimsIn("subject: 'anthropic claude-3-haiku'\n"), []);
});

test('leaves prose that happens to say "written by" a non-tool actor alone', () => {
  const text = 'Written by `snapshots.ts` itself — no routes touch it directly.\n';
  assert.deepEqual(authorshipClaimsIn(text), []);
});

test('a document that credits an AI coding assistant fails the scan, by file, line and column', () => {
  // "Claude Code" alone is also a named tool brand, so this one line earns two findings — both
  // true, and a scan erring toward over-reporting a real leak is the safe direction to err in.
  const input = { paths: cleanPaths, documents: { 'README.md': 'Generated with Claude Code.\n' }, sources: {} };
  assert.deepEqual(verifyDocsSplit(input), [
    'README.md:1:1: credits "Generated with Claude Code" as this work\'s author, which this public repository must never do',
    'README.md:1:16: credits "Claude Code" as this work\'s author, which this public repository must never do',
  ]);
});

test('shipped source that credits an AI coding assistant fails the scan too', () => {
  const input = { paths: cleanPaths, documents: {}, sources: { 'apps/app/src/main.ts': '// written by Codex\n' } };
  assert.deepEqual(verifyDocsSplit(input), [
    'apps/app/src/main.ts:1:4: credits "written by Codex" as this work\'s author, which this public repository must never do',
  ]);
});

test('a forbidden path and a content credit are both reported together', () => {
  const input = {
    paths: ['CLAUDE.md'],
    documents: { 'README.md': 'Written with ChatGPT throughout.\n' },
    sources: {},
  };
  assert.deepEqual(verifyDocsSplit(input), [
    "CLAUDE.md: an AI coding assistant's own instruction file has no place in this public repository",
    'README.md:1:1: credits "Written with ChatGPT" as this work\'s author, which this public repository must never do',
  ]);
});

test('reads content beyond exposure-scan.mjs\'s own sweep: .github/, scripts/, tests/harness/ and root-level files', () => {
  const { sources } = readRepo();
  for (const path of ['.github/workflows/release.yml', 'scripts/verify/gate.mjs', 'tests/harness/build.mjs', 'package.json']) {
    assert.ok(path in sources, `expected ${path} to be read`);
  }
});

test('excludes its own test file from that additional sweep, the same way exposure-scan.mjs excludes tests', () => {
  const { sources } = readRepo();
  assert.equal('scripts/verify/docs-split.test.mjs' in sources, false);
});

test('flags a commit message that credits an AI coding assistant, by commit and where', () => {
  const problems = commitMessageProblemsIn({
    aaaa1111bbbb2222cccc3333dddd4444eeee5555: 'Add feature\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
  });
  assert.deepEqual(problems, [
    'commit aaaa1111bbbb:2:1: credits "Co-Authored-By: C" as this work\'s author, which this public repository must never do',
  ]);
});

test('finds a credit in every commit, not only the first, in sorted sha order', () => {
  const problems = commitMessageProblemsIn({
    bbbb2222cccc3333dddd4444eeee5555aaaa1111: 'Generated with Claude Code.\n',
    aaaa1111bbbb2222cccc3333dddd4444eeee5555: 'written by ChatGPT\n',
  });
  assert.deepEqual(problems, [
    'commit aaaa1111bbbb:1:1: credits "written by ChatGPT" as this work\'s author, which this public repository must never do',
    'commit bbbb2222cccc:1:1: credits "Generated with Claude Code" as this work\'s author, which this public repository must never do',
    'commit bbbb2222cccc:1:16: credits "Claude Code" as this work\'s author, which this public repository must never do',
  ]);
});

test('an ordinary commit message has nothing to report', () => {
  assert.deepEqual(
    commitMessageProblemsIn({ aaaa1111bbbb2222cccc3333dddd4444eeee5555: 'fix(app): keep the notification watermark once every page is full\n' }),
    [],
  );
});

test('verifyDocsSplit includes commit-message problems alongside path and content problems', () => {
  const input = {
    paths: cleanPaths,
    documents: {},
    sources: {},
    commitMessages: { aaaa1111bbbb2222cccc3333dddd4444eeee5555: 'Claude-Session: https://claude.ai/code/session_01\n' },
  };
  assert.deepEqual(verifyDocsSplit(input), [
    'commit aaaa1111bbbb:1:1: credits "Claude-Session: h" as this work\'s author, which this public repository must never do',
    'commit aaaa1111bbbb:1:25: credits "claude.ai/code" as this work\'s author, which this public repository must never do',
  ]);
});

test('verifyDocsSplit defaults to no commit messages when none are given', () => {
  assert.deepEqual(verifyDocsSplit({ paths: cleanPaths, documents: {}, sources: {} }), []);
});

test('readRepo reads every commit message this repository\'s history holds, keyed by full sha', () => {
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const headSubject = execFileSync('git', ['log', '-1', '--format=%s', headSha], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const { commitMessages } = readRepo();
  assert.ok(headSha in commitMessages, 'expected the current HEAD commit to be present');
  assert.ok(commitMessages[headSha].startsWith(headSubject), 'expected the stored message to start with its own subject line');
});

test('this repository has no forbidden artifact and credits no AI coding assistant', () => {
  assert.deepEqual(verifyDocsSplit(readRepo()), []);
});

test('readCommitMessages keys every commit by its full sha, never a mangled or partial one', () => {
  const commitMessages = readCommitMessages();
  const shas = Object.keys(commitMessages);
  assert.ok(shas.length > 0, 'expected at least one commit');
  for (const sha of shas) {
    assert.match(sha, /^[0-9a-f]{40}$/, `expected a full 40-character sha, got ${JSON.stringify(sha)}`);
  }
});
