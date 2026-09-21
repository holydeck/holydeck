// The repository-split scan RELS-01 needs before a release: this public repository must never carry a
// planning, prompt, audit, task-brief, task-report or review artifact from the AI tooling this project is
// built with — that material lives in a private companion docs repository, by convention, and always has
// — and no line of tracked source or documentation may credit an AI coding assistant as this work's
// author. Two different things get swept for two different reasons: a file's own path can be forbidden
// outright (a CLAUDE.md, a `.claude/` directory, a file named like a plan or an audit), independent of
// what it says; a file's content can claim authorship no source or documentation may make, independent of
// what the file happens to be named. Neither reads git history — only the tracked working tree a release
// actually ships — because a full-history scan is explicitly not what this gate does.

import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readRepo as readShippedRepo } from '../workspace/exposure-scan.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// The exact filenames an AI coding assistant's own instructions live under. Never legitimate anywhere in
// this repository, whatever they contain.
const INSTRUCTION_FILES = new Set(['claude.md', 'agents.md', 'gemini.md']);

// A directory an AI coding assistant or its tooling owns outright.
const TOOLING_DIRECTORIES = new Set(['.claude', '.codex', '.cursor', '.superpowers']);

// A document — never source; apps/app/src/audit.ts, apps/cli/src/prompt.ts and their neighbors are real
// shipped features with nothing to do with this — named like the kind of artifact this project's private
// docs repository holds instead: a plan, a spec, a prompt, research notes, an audit, a task brief or
// report, or a review. Restricted to document extensions so a Playwright `*.spec.ts` file or a real
// `audit.ts`/`prompt.ts` module is never in scope to begin with.
const DOCUMENT_EXTENSIONS = new Set(['.md', '.txt']);
const NAMED_LIKE_AN_ARTIFACT = /\b(?:plans?|specs?|prompts?|research|audits?|briefs?|reports?|reviews?)\b/iu;

/** Every tracked path this scan refuses outright, whatever it contains. `paths` are repository-relative. */
export function pathProblemsIn(paths) {
  const problems = [];
  for (const path of [...paths].sort()) {
    const parts = path.split('/');
    const base = parts[parts.length - 1];
    const baseLower = base.toLowerCase();

    if (INSTRUCTION_FILES.has(baseLower)) {
      problems.push(`${path}: an AI coding assistant's own instruction file has no place in this public repository`);
      continue;
    }
    const toolingDir = parts.slice(0, -1).find((segment) => TOOLING_DIRECTORIES.has(segment));
    if (toolingDir !== undefined) {
      problems.push(`${path}: sits inside ${toolingDir}, which belongs in this project's private docs repository, not here`);
      continue;
    }
    const dot = base.lastIndexOf('.');
    const extension = dot === -1 ? '' : baseLower.slice(dot);
    if (DOCUMENT_EXTENSIONS.has(extension) && NAMED_LIKE_AN_ARTIFACT.test(base)) {
      problems.push(
        `${path}: named like a planning, prompt, audit, brief, report or review artifact, which belongs in this project's private docs repository, not here`,
      );
    }
  }
  return problems;
}

// Names an AI coding assistant as having authored this work: a git trailer, a session link, a
// "generated/written/built/created/drafted/co-authored with|by|using <tool>" credit, or the tool's own
// branded name. Deliberately never a bare vendor name — packages/core/src/anthropic.ts's own integration
// with the Anthropic Messages API, and the audit trail's "anthropic claude-3-haiku" fixture, name a real
// product dependency this project ships, not a credit for having written it.
const AI_TOOL_NAME = String.raw`(?:claude(?:\s*code)?|chatgpt|codex|copilot|gemini)`;
const CREDIT_TRAILER = /\b(?:co-authored-by|claude-session):\s*\S/giu;
const SESSION_LINK = /claude\.ai\/code\b/giu;
const CREDIT_PHRASE = new RegExp(
  String.raw`\b(?:generated|written|built|created|drafted|co[- ]?authored|implemented)\s+(?:with|by|using)\s+${AI_TOOL_NAME}\b`,
  'giu',
);
const NAMED_TOOL_BRAND = /\b(?:claude\s*code|github\s*copilot|openai\s*codex)\b/giu;
const AUTHORSHIP_PATTERNS = [CREDIT_TRAILER, SESSION_LINK, CREDIT_PHRASE, NAMED_TOOL_BRAND];

/** Every place a piece of text credits an AI coding assistant as this work's author, with where it says it. */
export function authorshipClaimsIn(text) {
  const found = [];
  const lines = text.split('\n');
  for (const [at, line] of lines.entries()) {
    for (const pattern of AUTHORSHIP_PATTERNS) {
      for (const match of line.matchAll(pattern)) {
        found.push({ line: at + 1, column: match.index + 1, said: match[0] });
      }
    }
  }
  return found;
}

/** Grades the scan. `paths` is every tracked file; `documents` and `sources` are keyed as exposure-scan.mjs keys them. */
export function verifyDocsSplit({ paths, documents, sources }) {
  const problems = [...pathProblemsIn(paths)];
  for (const file of Object.keys(documents).sort()) {
    for (const found of authorshipClaimsIn(documents[file])) {
      problems.push(`${file}:${found.line}:${found.column}: credits "${found.said}" as this work's author, which this public repository must never do`);
    }
  }
  for (const file of Object.keys(sources).sort()) {
    for (const found of authorshipClaimsIn(sources[file])) {
      problems.push(`${file}:${found.line}:${found.column}: credits "${found.said}" as this work's author, which this public repository must never do`);
    }
  }
  return problems;
}

// Reuses exposure-scan.mjs's own document/source sweep for the content half rather than keeping a second
// list of what "shipped" means — the same files that must not name real infrastructure must not credit an
// AI coding assistant either. That sweep never reaches scripts/, which is exactly where this scan's own
// test fixtures have to write the literal phrases above to prove they are caught; reusing it is what keeps
// this scan from flagging itself.
export function readRepo() {
  const paths = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter((path) => path.length > 0);
  const { documents, sources } = readShippedRepo();
  return { paths, documents, sources };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = verifyDocsSplit(readRepo());
  for (const problem of problems) console.error(problem);
  process.exit(problems.length === 0 ? 0 : 1);
}
