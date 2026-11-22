// mend: one patch tool for every AI edit format.
//
// An AI model writes an edit as a unified diff (often with wrong line
// numbers), a SEARCH/REPLACE block, a V4A patch, or a JSON tool call.
// mend reads the patch in any of the four, finds the lines each edit
// names at the first of three matching tiers, and writes every change
// or none, printing what it changed or why it failed.
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// Node 22 and its standard library alone. SPEC.md is the whole contract:
// every sentence of it is a requirement, and this file follows it.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** An exit-2 answer: one line, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed: its code and the path it concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

/** A line that is empty or only whitespace. */
const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: its text split at `\n`, each with one trailing `\r`
 * removed, and without the empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no
 * `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The leading spaces and tabs of a line. */
function leadWs(s: string): string {
  const m = s.match(/^[ \t]*/);
  return m === null ? '' : m[0];
}

/** A line with its trailing spaces and tabs removed. */
function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

/** A line with its leading and trailing spaces and tabs removed. */
function trimBothWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** A line that is empty or only spaces and tabs. */
function isWsOnly(s: string): boolean {
  return /^[ \t]*$/.test(s);
}

/** Whether a text's first line feed follows a carriage return. */
function isCrlf(text: string): boolean {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r';
}

/** A file as lines: its line break, its lines, and whether it ends with
 * a line break. An empty file has no lines and no final break. */
interface FileData {
  lines: string[];
  br: string;
  eol: boolean;
}

function splitFile(text: string): FileData {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const br = isCrlf(text) ? '\r\n' : '\n';
  const parts = text.split(br);
  const eol = text.endsWith(br);
  if (eol) parts.pop();
  return { lines: parts, br, eol };
}

function joinFile(f: FileData): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.eol ? f.br : '');
}

/** Two lines equal at a matching tier: 0 exact, 1 trailing spaces and
 * tabs removed from both, 2 leading and trailing removed from both. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** Every position where O's lines match the file's lines at a tier.
 * Occurrences may overlap; positions are 0-based and in order. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(o[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs in the lines, with its positions,
 * or null when it occurs at no tier. With --strict only tier 0 is tried. */
function firstTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrences(lines, o, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One line of N: a context line, written as the file's own matched line
 * (its index into O), or an added line, written from the patch. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** The lines N becomes at a matched position. A context line is the
 * file's own matched line, never the patch's. At tier 2 every other line
 * is re-indented: let F be the leading spaces and tabs of the file's
 * first matched line and P those of O's first line; a line that is not
 * empty and not only whitespace, and starts with P, has that P replaced
 * by F. At tiers 0 and 1 the added lines are written as they are. */
function buildNew(n: NewLine[], o: string[], fileLines: string[], pos: number, tier: number): string[] {
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const f = pos < fileLines.length ? leadWs(fileLines[pos]!) : '';
  return n.map((e) => {
    if (e.ctx !== null) return fileLines[pos + e.ctx]!;
    if (tier !== 2) return e.text;
    if (isWsOnly(e.text)) return e.text;
    if (!e.text.startsWith(p)) return e.text;
    return f + e.text.slice(p.length);
  });
}

/** One line of a hunk or chunk body, with the patch line it came from. */
interface BodyEntry {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  raw: string;
}

/** A body line as an entry: ` ` and an empty line are context, `-` old,
 * `+` new, and `\` a marker that refers to the body line before it. */
function bodyEntry(l: string): BodyEntry {
  if (l === '') return { kind: 'ctx', text: '', raw: l };
  const c = l[0]!;
  if (c === ' ') return { kind: 'ctx', text: l.slice(1), raw: l };
  if (c === '-') return { kind: 'del', text: l.slice(1), raw: l };
  if (c === '+') return { kind: 'add', text: l.slice(1), raw: l };
  return { kind: 'bs', text: l, raw: l };
}

/** O, the lines a hunk or chunk replaces: its context and `-` lines. */
function oLines(body: BodyEntry[]): string[] {
  return body.filter((e) => e.kind === 'ctx' || e.kind === 'del').map((e) => e.text);
}

/** N, the lines a hunk or chunk writes: its context and `+` lines, each
 * context line carrying its index into O. */
function nLines(body: BodyEntry[]): NewLine[] {
  const out: NewLine[] = [];
  let oi = 0;
  for (const e of body) {
    if (e.kind === 'ctx') {
      out.push({ text: e.text, ctx: oi });
      oi++;
    } else if (e.kind === 'del') {
      oi++;
    } else if (e.kind === 'add') {
      out.push({ text: e.text, ctx: null });
    }
  }
  return out;
}

/** Whether a `\` line follows the hunk's last context or `+` line: the
 * result then ends without a line break. With no such line there is
 * nothing for a `\` to follow. */
function noEolAfter(body: BodyEntry[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'add') last = k;
  }
  if (last < 0) return false;
  return body[last + 1]?.kind === 'bs';
}

/** The tree as the edits leave it: paths changed in `now` (null means
 * deleted), everything else read from disk when first needed. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p) as string | null;
  }

  get(p: string): string | null {
    return this.now.has(p) ? (this.now.get(p) as string | null) : this.original(p);
  }
}

/** One edit: it changes the tree or throws a Fail. */
type EditFn = (tree: Tree) => void;

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Detect the format of a patch, or null when none of the rules holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object, or null when the value is not one. */
function jsonEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const crlf = isCrlf(before);
      const plain = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const t = plain(before);
      const old = plain(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + plain(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.split('\n').join('\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const file = splitFile(before);
      if (lineNo < 0 || lineNo > file.lines.length) throw new Fail('no-match', p);
      file.lines.splice(lineNo, 0, ...add);
      tree.now.set(p, joinFile(file));
    };
  }
  return null;
}

/** The edits of a JSON patch: one JSON array of edit objects, or JSON
 * Lines with one edit object a line and blank lines ignored. */
function jsonEdits(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One hunk of a unified diff, or one chunk of a V4A update. */
interface Hunk {
  a: number;
  anchor: string | null;
  eof: boolean;
  body: BodyEntry[];
}

/** One section of a unified diff. */
interface UniSection {
  diffOld: string | null;
  diffNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path of a `--- ` or `+++ ` header line: the text after the four
 * characters, up to the first tab, with surrounding spaces removed and
 * a leading `a/` or `b/` removed. */
function headerPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Apply a section's hunks, in order, each to the result of the ones
 * before it. A hunk takes the occurrence of its old lines nearest to
 * where its line numbers say, or inserts after the first A + d lines
 * when it has no old lines. */
function applyUnifiedHunks(file: FileData, hunks: Hunk[], strict: boolean, failPath: string): FileData {
  const lines = [...file.lines];
  let eol = file.eol;
  let d = 0;
  for (const h of hunks) {
    const o = oLines(h.body);
    const n = nLines(h.body);
    if (o.length === 0) {
      const oldLen = lines.length;
      let p = h.a + d;
      if (p < 0) p = 0;
      if (p > oldLen) p = oldLen;
      lines.splice(p, 0, ...buildNew(n, o, lines, p, 0));
      if (p === oldLen) eol = !noEolAfter(h.body);
      d += n.length;
      continue;
    }
    const found = firstTier(lines, o, strict);
    if (found === null) throw new Fail('no-match', failPath);
    const target = h.a - 1 + d;
    let best = found.at[0]!;
    let bestDist = Math.abs(best - target);
    for (const pos of found.at) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const pos = best;
    const toEnd = pos + o.length === lines.length;
    lines.splice(pos, o.length, ...buildNew(n, o, lines, pos, found.tier));
    if (toEnd) eol = !noEolAfter(h.body);
    d += n.length - o.length;
  }
  return { lines, br: file.br, eol };
}

/** One unified section as one edit. */
function unifiedEdit(sec: UniSection, strict: boolean): EditFn {
  const oldRaw = sec.dashOld ?? sec.renameFrom ?? sec.diffOld;
  const newRaw = sec.dashNew ?? sec.renameTo ?? sec.diffNew;
  const oldP = oldRaw === '/dev/null' ? null : oldRaw;
  const newP = newRaw === '/dev/null' ? null : newRaw;
  const isCreation = sec.newFile || oldRaw === '/dev/null';
  const isDeletion = sec.deletedFile || newRaw === '/dev/null';
  if (isCreation) {
    const target = newP ?? '';
    return (tree) => {
      if (!safePath(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: string[] = [];
      let hasAdd = false;
      let noEol = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          if (h.body[k]!.kind === 'add') {
            plus.push(h.body[k]!.text);
            hasAdd = true;
            noEol = h.body[k + 1]?.kind === 'bs';
          }
        }
      }
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (hasAdd && noEol ? '' : '\n'));
    };
  }
  if (isDeletion) {
    const target = oldP ?? '';
    return (tree) => {
      if (!safePath(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
    };
  }
  if (oldP !== null && newP !== null && oldP !== newP) {
    return (tree) => {
      if (!safePath(oldP)) throw new Fail('unsafe', oldP);
      if (!safePath(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const after = applyUnifiedHunks(splitFile(before), sec.hunks, strict, oldP);
      tree.now.set(newP, joinFile(after));
      tree.now.set(oldP, null);
      tree.moves.push({ old: oldP, new: newP });
    };
  }
  const target = oldP ?? newP ?? '';
  return (tree) => {
    if (!safePath(target)) throw new Fail('unsafe', target);
    const before = tree.get(target);
    if (before === null) throw new Fail('missing', target);
    const after = applyUnifiedHunks(splitFile(before), sec.hunks, strict, target);
    tree.now.set(target, joinFile(after));
  };
}

/** Read a unified diff patch into its sections, each one edit. */
function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const sections: UniSection[] = [];
  let sec: UniSection | null = null;
  let inHeader = false;
  let hunk: Hunk | null = null;
  const finishHunk = (): void => {
    if (hunk !== null && sec !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.raw === '') hunk.body.pop();
      sec.hunks.push(hunk);
    }
    hunk = null;
  };
  const finishSection = (): void => {
    finishHunk();
    if (sec !== null) sections.push(sec);
    sec = null;
    inHeader = false;
  };
  const startSection = (diffOld: string | null, diffNew: string | null): void => {
    finishSection();
    sec = { diffOld, diffNew, dashOld: null, dashNew: null, renameFrom: null, renameTo: null, newFile: false, deletedFile: false, hunks: [] };
    inHeader = true;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      continue;
    }
    if (l.startsWith('--- ')) {
      const nextIsPlus = (lines[i + 1] ?? '').startsWith('+++ ');
      if (inHeader && sec !== null && sec.dashOld === null) {
        if (!nextIsPlus) throw new Exit2(`error: parse ${i + 2}`);
        sec.dashOld = headerPath(l);
        sec.dashNew = headerPath(lines[i + 1]!);
        i++;
        continue;
      }
      if (inHeader && sec !== null) {
        if (!nextIsPlus) throw new Exit2(`error: parse ${i + 2}`);
        startSection(null, null);
        sec!.dashOld = headerPath(l);
        sec!.dashNew = headerPath(lines[i + 1]!);
        i++;
        continue;
      }
      if (nextIsPlus) {
        startSection(null, null);
        sec!.dashOld = headerPath(l);
        sec!.dashNew = headerPath(lines[i + 1]!);
        i++;
        continue;
      }
      if (hunk === null) continue;
    }
    if (l.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      finishHunk();
      hunk = { a: parseInt(m[1]!, 10), anchor: null, eof: false, body: [] };
      inHeader = false;
      continue;
    }
    if (hunk !== null) {
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
        hunk.body.push(bodyEntry(l));
        continue;
      }
      finishHunk();
      continue;
    }
    if (inHeader && sec !== null) {
      if (l.startsWith('rename from ')) sec.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) sec.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) sec.newFile = true;
      else if (l.startsWith('deleted file mode')) sec.deletedFile = true;
      continue;
    }
  }
  finishSection();
  return sections.map((s) => unifiedEdit(s, strict));
}

/** One SEARCH/REPLACE block as one edit. */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): EditFn {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const file = splitFile(before);
    const found = firstTier(file.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length !== 1) throw new Fail('ambiguous', path);
    const pos = found.at[0]!;
    const repl = buildNew(
      newLines.map((t) => ({ text: t, ctx: null })),
      oldLines,
      file.lines,
      pos,
      found.tier,
    );
    file.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, joinFile(file));
  };
}

/** Read SEARCH/REPLACE blocks into their edits, in order. */
function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

/** One section of a V4A patch. */
interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: Hunk[];
}

/** Apply an Update section's chunks, in order, with a cursor that starts
 * at line 0. A chunk with an anchor first finds the first line at or
 * after the cursor equal to the anchor; the chunk then takes the first
 * occurrence of its old lines at or after the cursor. */
function applyV4aChunks(file: FileData, chunks: Hunk[], strict: boolean, failPath: string): FileData {
  const lines = [...file.lines];
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let found = -1;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        for (let k = cursor; k < lines.length; k++) {
          if (lineEq(ch.anchor, lines[k]!, t)) {
            found = k;
            break;
          }
        }
        if (found >= 0) break;
      }
      if (found < 0) throw new Fail('no-match', failPath);
      cursor = found + 1;
    }
    const o = oLines(ch.body);
    const n = nLines(ch.body);
    if (o.length === 0) {
      const p = ch.eof ? lines.length : cursor;
      const repl = buildNew(n, o, lines, p, 0);
      lines.splice(p, 0, ...repl);
      cursor = p + repl.length;
      continue;
    }
    let foundTier = -1;
    let foundPos = -1;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const t of tiers) {
      const at = occurrences(lines, o, t, cursor);
      const ok = ch.eof ? at.filter((p) => p + o.length === lines.length) : at;
      if (ok.length > 0) {
        foundTier = t;
        foundPos = ok[0]!;
        break;
      }
    }
    if (foundPos < 0) throw new Fail('no-match', failPath);
    const repl = buildNew(n, o, lines, foundPos, foundTier);
    lines.splice(foundPos, o.length, ...repl);
    cursor = foundPos + repl.length;
  }
  return { lines, br: file.br, eol: file.eol };
}

/** One V4A section as one edit. */
function v4aEdit(sec: V4aSection, strict: boolean): EditFn {
  if (sec.kind === 'add') {
    return (tree) => {
      if (!safePath(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    return (tree) => {
      if (!safePath(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
    };
  }
  return (tree) => {
    if (!safePath(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safePath(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const after = applyV4aChunks(splitFile(before), sec.chunks, strict, sec.path);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, joinFile(after));
      tree.now.set(sec.path, null);
      tree.moves.push({ old: sec.path, new: sec.moveTo });
    } else {
      tree.now.set(sec.path, joinFile(after));
    }
  };
}

/** Read a V4A patch into its sections, each one edit. */
function parseV4a(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: EditFn[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const addLines: string[] = [];
      const fromBlank: boolean[] = [];
      i++;
      while (i < last) {
        const m = lines[i]!;
        if (m.startsWith('*** Add File: ') || m.startsWith('*** Delete File: ') || m.startsWith('*** Update File: ')) break;
        if (m.startsWith('+')) {
          addLines.push(m.slice(1));
          fromBlank.push(false);
          i++;
        } else if (m === '') {
          addLines.push('');
          fromBlank.push(true);
          i++;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      while (addLines.length > 0 && fromBlank[fromBlank.length - 1]) {
        addLines.pop();
        fromBlank.pop();
      }
      edits.push(v4aEdit({ kind: 'add', path, moveTo: null, addLines, chunks: [] }, strict));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      edits.push(v4aEdit({ kind: 'delete', path, moveTo: null, addLines: [], chunks: [] }, strict));
      i++;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: Hunk[] = [];
      let cur: Hunk | null = null;
      let started = false;
      while (i < last) {
        const m = lines[i]!;
        if (m.startsWith('*** Add File: ') || m.startsWith('*** Delete File: ') || m.startsWith('*** Update File: ')) break;
        if (m.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchorText = m.slice(2).trim();
          cur = { a: 0, anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          started = true;
          i++;
          continue;
        }
        if (!m.startsWith(' ') && m.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          i++;
          continue;
        }
        if (blank(m) && cur === null && started) {
          i++;
          continue;
        }
        if (m.startsWith(' ') || m.startsWith('-') || m.startsWith('+') || m === '') {
          if (cur === null) {
            if (started) throw new Exit2(`error: parse ${i + 1}`);
            cur = { a: 0, anchor: null, eof: false, body: [] };
            started = true;
          }
          cur.body.push(bodyEntry(m));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length > 0) {
        const tail = chunks[chunks.length - 1]!;
        while (tail.body.length > 0 && blank(tail.body[tail.body.length - 1]!.raw)) tail.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(v4aEdit({ kind: 'update', path, moveTo, addLines: [], chunks }, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/** Run the CLI on its arguments. Returns the exit code and the lines
 * for standard output. */
function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const changed = new Map<string, string | null>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p) as string | null;
    if (was !== now) changed.set(p, now);
  }
  const rows: { key: string; line: string }[] = [];
  for (const m of tree.moves) {
    const oldWas = tree.original(m.old);
    const oldNow = tree.get(m.old);
    const newWas = tree.original(m.new);
    const newNow = tree.get(m.new);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      changed.delete(m.old);
      changed.delete(m.new);
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
    }
  }
  for (const [p, now] of changed) {
    const was = tree.original(p);
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p) as string | null;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
