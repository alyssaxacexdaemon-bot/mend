// main.ts is mend, the CLI SPEC.md specifies. It does sections 1 to 10 of SPEC.md: the command line, the
// output and exit codes, safe paths, format detection, matching lines at three tiers (section 5),
// unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits
// (section 9) and the all-or-nothing write (section 10). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
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
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** Record a move: the old path is deleted, the new path holds the content. */
  move(oldPath: string, newPath: string, content: string): void {
    this.now.set(oldPath, null);
    this.now.set(newPath, content);
    this.moves.push({ old: oldPath, new: newPath });
  }
}

type Edit = (tree: Tree) => void;

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  ended: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', ended: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ended = text.endsWith(br);
  if (ended) parts.pop();
  return { lines: parts, br, ended };
}

function renderFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.ended ? s.br : '');
}

/** The leading spaces and tabs of a line. */
function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

type Tier = 0 | 1 | 2;

/** One line normalised at a matching tier (SPEC.md section 5). */
function tierNorm(s: string, tier: Tier): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in F at one tier; occurrences may overlap. */
function occurrences(O: string[], F: string[], tier: Tier): number[] {
  const pos: number[] = [];
  if (O.length === 0 || O.length > F.length) return pos;
  const on = O.map((l) => tierNorm(l, tier));
  for (let i = 0; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (tierNorm(F[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** The first tier at which O occurs in F at least once, with every occurrence there. */
function findMatch(O: string[], F: string[], strict: boolean): { tier: Tier; positions: number[] } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const p = occurrences(O, F, t);
    if (p.length > 0) return { tier: t, positions: p };
  }
  return null;
}

/** The first occurrence of O at or after `from`, at the first tier with one there. */
function findMatchFrom(O: string[], F: string[], from: number, strict: boolean): { tier: Tier; positions: number[] } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const p = occurrences(O, F, t).filter((i) => i >= from);
    if (p.length > 0) return { tier: t, positions: p };
  }
  return null;
}

/** The first line at or after `from` equal to a single line, at the first tier where one is. */
function findSingleLine(anchor: string, F: string[], from: number, strict: boolean): number | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const a = tierNorm(anchor, t);
    for (let i = from; i < F.length; i++) {
      if (tierNorm(F[i]!, t) === a) return i;
    }
  }
  return null;
}

/** A body item of a hunk or chunk: a context line, an old line or a new line. */
interface BodyItem {
  kind: ' ' | '-' | '+';
  text: string;
  /** A `\` line follows this item at once (no newline at end of file for it). */
  noEol: boolean;
}

function bodyO(items: BodyItem[]): string[] {
  return items.filter((i) => i.kind === ' ' || i.kind === '-').map((i) => i.text);
}

function bodyN(items: BodyItem[]): string[] {
  return items.filter((i) => i.kind === ' ' || i.kind === '+').map((i) => i.text);
}

/** For each line of N, the index into O of the context line it is, or null for a new line. */
function contextMap(items: BodyItem[]): Map<number, number> {
  const map = new Map<number, number>();
  let oIdx = 0;
  let nIdx = 0;
  for (const item of items) {
    if (item.kind === ' ') {
      map.set(nIdx, oIdx);
      oIdx += 1;
      nIdx += 1;
    } else if (item.kind === '-') {
      oIdx += 1;
    } else {
      nIdx += 1;
    }
  }
  return map;
}

/**
 * The lines N writes in place of the matched lines at `pos`. A context line is written as the file's own
 * matched line, never the patch's. At tier 2 every other line of N is re-indented: P, the leading spaces
 * and tabs of O's first line, is replaced by F, those of the file's first matched line.
 */
function buildReplacement(fileLines: string[], pos: number, O: string[], N: string[], nCtx: Map<number, number>, tier: Tier): string[] {
  const F = leadingWS(fileLines[pos] ?? '');
  const P = leadingWS(O[0] ?? '');
  const out: string[] = [];
  for (let k = 0; k < N.length; k++) {
    const oi = nCtx.get(k);
    if (oi !== undefined) {
      out.push(fileLines[pos + oi]!);
    } else {
      const line = N[k]!;
      if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(P)) out.push(F + line.slice(P.length));
      else out.push(line);
    }
  }
  return out;
}

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

/** A path from a `--- ` or `+++ ` line: the text after the four characters, up to the first tab, trimmed, with a leading a/ or b/ removed; /dev/null is no file. */
function headerPath(text: string): string | null {
  const p = text.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

interface UnifiedHunk {
  a: number;
  items: BodyItem[];
}

interface UnifiedSection {
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  diffOld: string;
  diffNew: string;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UnifiedHunk[];
}

/** Parse a unified diff into its sections (SPEC.md section 6). */
function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let hunk: UnifiedHunk | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;

  const endHunk = (): void => {
    if (hunk !== null && cur !== null) {
      while (hunk.items.length > 0) {
        const last = hunk.items[hunk.items.length - 1]!;
        if (last.kind === ' ' && last.text === '') hunk.items.pop();
        else break;
      }
      cur.hunks.push(hunk);
      hunk = null;
    }
  };

  const startFromDiff = (line: string, lineNo: number): void => {
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (m === null) throw new Exit2(`error: parse ${lineNo}`);
    cur = { dashOld: undefined, dashNew: undefined, renameOld: undefined, renameNew: undefined, diffOld: m[1]!, diffNew: m[2]!, isCreate: false, isDelete: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
  };

  const startFromHeaders = (dashLine: string, plusLine: string): void => {
    cur = { dashOld: headerPath(dashLine.slice(4)), dashNew: headerPath(plusLine.slice(4)), renameOld: undefined, renameNew: undefined, diffOld: '', diffNew: '', isCreate: false, isDelete: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
  };

  while (i < n) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (hunk !== null) {
      if (line.startsWith('diff --git ')) {
        endHunk();
        startFromDiff(line, lineNo);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        endHunk();
        startFromHeaders(line, lines[i + 1]!);
        i += 2;
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        if (line[0] === '\\') {
          const prev = hunk.items[hunk.items.length - 1];
          if (prev !== undefined) prev.noEol = true;
        } else if (line === '') {
          hunk.items.push({ kind: ' ', text: '', noEol: false });
        } else {
          hunk.items.push({ kind: line[0] as ' ' | '-' | '+', text: line.slice(1), noEol: false });
        }
        i += 1;
        continue;
      }
      endHunk();
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${lineNo}`);
      hunk = { a: parseInt(m[1]!, 10), items: [] };
      inHeader = false;
      i += 1;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      startFromDiff(line, lineNo);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (inHeader && cur !== null) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.dashOld = headerPath(line.slice(4));
          cur.dashNew = headerPath(lines[i + 1]!.slice(4));
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${lineNo + 1}`);
      }
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        startFromHeaders(line, lines[i + 1]!);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inHeader && cur !== null) {
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  endHunk();
  return sections;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkEndsNoEol(hunk: UnifiedHunk): boolean {
  for (let k = hunk.items.length - 1; k >= 0; k--) {
    const item = hunk.items[k]!;
    if (item.kind === ' ' || item.kind === '+') return item.noEol;
  }
  return false;
}

/** Apply one section's hunks in order to a file's lines (SPEC.md section 6). */
function applyHunks(state: FileState, hunks: UnifiedHunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const hunk of hunks) {
    const O = bodyO(hunk.items);
    const N = bodyN(hunk.items);
    const nCtx = contextMap(hunk.items);
    const oldLen = state.lines.length;
    if (O.length > 0) {
      const match = findMatch(O, state.lines, strict);
      if (match === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let pos = match.positions[0]!;
      let best = Math.abs(pos - target);
      for (const p of match.positions) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          best = dist;
          pos = p;
        }
      }
      const toEnd = pos + O.length === oldLen;
      const replacement = buildReplacement(state.lines, pos, O, N, nCtx, match.tier);
      state.lines.splice(pos, O.length, ...replacement);
      if (toEnd) state.ended = !hunkEndsNoEol(hunk);
      d += N.length - O.length;
    } else {
      const idx = Math.min(hunk.a + d, oldLen);
      const atEnd = idx === oldLen;
      state.lines.splice(idx, 0, ...N);
      if (atEnd && N.length > 0) state.ended = !hunkEndsNoEol(hunk);
      d += N.length;
    }
  }
}

/** One unified section as an edit (SPEC.md section 6). */
function unifiedSectionEdit(section: UnifiedSection, strict: boolean): Edit {
  const oldPath = section.dashOld !== undefined ? section.dashOld : section.renameOld !== undefined ? section.renameOld : section.diffOld;
  const newPath = section.dashNew !== undefined ? section.dashNew : section.renameNew !== undefined ? section.renameNew : section.diffNew;
  const isCreate = oldPath === null || section.isCreate;
  const isDelete = !isCreate && (newPath === null || section.isDelete);
  if (isCreate) {
    const path = newPath!;
    const plusLines: string[] = [];
    let endsNoEol = false;
    for (const hunk of section.hunks) {
      for (const item of hunk.items) if (item.kind === '+') plusLines.push(item.text);
    }
    for (let h = section.hunks.length - 1; h >= 0; h--) {
      const hunk = section.hunks[h]!;
      for (let k = hunk.items.length - 1; k >= 0; k--) {
        if (hunk.items[k]!.kind === '+') {
          endsNoEol = hunk.items[k]!.noEol;
          break;
        }
      }
      if (plusLines.length > 0) break;
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, plusLines.length === 0 ? '' : plusLines.join('\n') + (endsNoEol ? '' : '\n'));
    };
  }
  if (isDelete) {
    const path = oldPath!;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  if (oldPath !== newPath) {
    const oldP = oldPath!;
    const newP = newPath!;
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const content = tree.get(oldP);
      if (content === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const state = parseFile(content);
      applyHunks(state, section.hunks, strict, oldP);
      tree.move(oldP, newP, renderFile(state));
    };
  }
  const path = oldPath!;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const content = tree.get(path);
    if (content === null) throw new Fail('missing', path);
    const state = parseFile(content);
    applyHunks(state, section.hunks, strict, path);
    tree.now.set(path, renderFile(state));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => unifiedSectionEdit(s, strict));
}

/** One SEARCH/REPLACE block as an edit (SPEC.md section 7). */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const content = tree.get(path);
    if (content === null) throw new Fail('missing', path);
    const state = parseFile(content);
    const match = findMatch(oldLines, state.lines, strict);
    if (match === null) throw new Fail('no-match', path);
    if (match.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = match.positions[0]!;
    const replacement = buildReplacement(state.lines, pos, oldLines, newLines, new Map(), match.tier);
    state.lines.splice(pos, oldLines.length, ...replacement);
    tree.now.set(path, renderFile(state));
  };
}

/** Parse SEARCH/REPLACE blocks into edits (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let sep = -1;
    let rep = -1;
    for (let j = i + 1; j < n; j++) {
      const l = lines[j]!;
      if (l.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (l.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (sep === -1) throw new Exit2(`error: parse ${searchLine}`);
    for (let j = sep + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

interface V4ASection {
  type: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  lines: { text: string; lineNo: number }[];
}

/** Parse a V4A patch into its sections (SPEC.md section 8). */
function parseV4A(lines: string[]): V4ASection[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let type: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      type = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      type = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      type = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    i += 1;
    const secLines: { text: string; lineNo: number }[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      secLines.push({ text: l, lineNo: i + 1 });
      i += 1;
    }
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
    sections.push({ type, path, lineNo: startLine, lines: secLines });
  }
  return sections;
}

/** Parse one Update File section's lines into its chunks (SPEC.md section 8). */
function v4aChunks(section: V4ASection): { moveTo: string | null; chunks: V4AChunk[] } {
  let moveTo: string | null = null;
  let rest = section.lines;
  if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
    moveTo = rest[0]!.text.slice('*** Move to: '.length).trim();
    rest = rest.slice(1);
  }
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  let firstChunk = true;
  for (const { text, lineNo } of rest) {
    if (text.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchorText = text.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, eof: false, items: [] };
      firstChunk = false;
      continue;
    }
    if (text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      firstChunk = false;
      continue;
    }
    if (text.startsWith('*** ')) throw new Exit2(`error: parse ${lineNo}`);
    if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (cur === null) {
        if (!firstChunk) throw new Exit2(`error: parse ${lineNo}`);
        cur = { anchor: null, eof: false, items: [] };
        firstChunk = false;
      }
      if (text === '') cur.items.push({ kind: ' ', text: '', noEol: false });
      else cur.items.push({ kind: text[0] as ' ' | '-' | '+', text: text.slice(1), noEol: false });
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${section.lineNo}`);
  return { moveTo, chunks };
}

/** One V4A section as an edit (SPEC.md section 8). */
function v4aSectionEdit(section: V4ASection, strict: boolean): Edit {
  if (section.type === 'add') {
    const fileLines: string[] = [];
    for (const { text, lineNo } of section.lines) {
      if (text === '') fileLines.push('');
      else if (text.startsWith('+')) fileLines.push(text.slice(1));
      else throw new Exit2(`error: parse ${lineNo}`);
    }
    const path = section.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (section.type === 'delete') {
    for (const { text, lineNo } of section.lines) {
      if (!blank(text)) throw new Exit2(`error: parse ${lineNo}`);
    }
    const path = section.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  const { moveTo, chunks } = v4aChunks(section);
  const path = section.path;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const content = tree.get(path);
    if (content === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const state = parseFile(content);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findSingleLine(chunk.anchor, state.lines, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const O = bodyO(chunk.items);
      const N = bodyN(chunk.items);
      const nCtx = contextMap(chunk.items);
      if (O.length > 0) {
        const match = findMatchFrom(O, state.lines, cursor, strict);
        if (match === null) throw new Fail('no-match', path);
        let pos = match.positions[0]!;
        if (chunk.eof) {
          const endPos = state.lines.length - O.length;
          if (!match.positions.includes(endPos)) throw new Fail('no-match', path);
          pos = endPos;
        }
        const replacement = buildReplacement(state.lines, pos, O, N, nCtx, match.tier);
        state.lines.splice(pos, O.length, ...replacement);
        cursor = pos + replacement.length;
      } else {
        const idx = chunk.eof ? state.lines.length : cursor;
        state.lines.splice(idx, 0, ...N);
        cursor = idx + N.length;
      }
    }
    const result = renderFile(state);
    if (moveTo !== null) tree.move(path, moveTo, result);
    else tree.now.set(path, result);
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4A(lines).map((s) => v4aSectionEdit(s, strict));
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
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
    let e: Edit | null = null;
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

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
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
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const moveByNew = new Map<string, { old: string; new: string }>();
  for (const m of tree.moves) {
    const oldWas = tree.original(m.old);
    const oldNow = tree.get(m.old);
    const newWas = tree.original(m.new);
    const newNow = tree.get(m.new);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) moveByNew.set(m.new, m);
  }
  const moveOlds = new Set<string>();
  for (const m of moveByNew.values()) moveOlds.add(m.old);
  for (const p of tree.now.keys()) {
    if (moveOlds.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const m = moveByNew.get(p);
    if (m !== undefined) rows.push({ key: p, text: `R ${m.old} -> ${m.new}` });
    else rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outRows = rows.map((r) => r.text);
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
