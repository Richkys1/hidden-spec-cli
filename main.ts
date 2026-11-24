// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It does all of SPEC.md: the command line, the output and exit codes, safe paths, format detection, JSON edits,
// unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), line matching at three
// tiers (section 5), and the all-or-nothing write (section 10).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileText {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, for the `R` output lines. */
  moves: [string, string][] = [];
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
}

type Edit = (tree: Tree) => void;

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

// ---- Section 5: matching lines ----

function normTier(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** 0-based positions where O occurs in the file's lines at a tier; occurrences may overlap. */
function occurrences(fileLines: string[], o: string[], tier: number): number[] {
  const res: number[] = [];
  if (o.length === 0) return res;
  const on = o.map((l) => normTier(l, tier));
  for (let i = 0; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normTier(fileLines[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs at least once. */
function findTier(fileLines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(fileLines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

const leadOf = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

/** At tier 2 a non-context line of N that starts with P has that P replaced by F. */
function reindentLine(t: string, p: string, f: string): string {
  if (t === '' || /^[ \t]+$/.test(t)) return t;
  if (t.startsWith(p)) return f + t.slice(p.length);
  return t;
}

/** One line of N: `ctx` is its index in O when it is a context line, else null for a new line. */
interface NItem {
  text: string;
  ctx: number | null;
}

/** Replace the k matched lines at pos with the N lines. Context lines come from the file; at tier 2 the
 *  other lines are re-indented from O's first line's leading whitespace to the file's. */
function replaceLines(fileLines: string[], pos: number, oLen: number, n: NItem[], tier: number, o: string[]): string[] {
  const out = fileLines.slice(0, pos);
  const p = o.length > 0 ? leadOf(o[0]!) : '';
  const f = fileLines[pos] !== undefined ? leadOf(fileLines[pos]!) : '';
  for (const it of n) {
    if (it.ctx !== null) out.push(fileLines[pos + it.ctx]!);
    else out.push(tier === 2 ? reindentLine(it.text, p, f) : it.text);
  }
  out.push(...fileLines.slice(pos + oLen));
  return out;
}

/** One body line of a hunk or chunk: context, old or new. A `\` line sets `nonl` on the line before it. */
interface BodyItem {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  nonl?: boolean;
}

/** Split body items into O (context and old lines) and N (context and new lines, with their O index). */
function splitItems(items: BodyItem[]): { o: string[]; n: NItem[] } {
  const o: string[] = [];
  const n: NItem[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      o.push(it.text);
      n.push({ text: it.text, ctx: o.length - 1 });
    } else if (it.kind === 'del') {
      o.push(it.text);
    } else {
      n.push({ text: it.text, ctx: null });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function lastCtxOrAddNonl(items: BodyItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'ctx' || it.kind === 'add') return it.nonl === true;
  }
  return false;
}

// ---- Section 6: unified diffs ----

interface Hunk {
  a: number;
  items: BodyItem[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, spaces removed. */
function headerPath(line: string): string {
  const t = line.slice(4);
  const tab = t.indexOf('\t');
  return (tab >= 0 ? t.slice(0, tab) : t).trim();
}

/** A leading `a/` or `b/` is removed from either path; `/dev/null` means no file. */
function stripPrefix(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Apply one hunk to a file's lines. `d` is the sum over this section's earlier hunks of N minus O lengths. */
function applyHunk(file: FileText, hunk: Hunk, d: number, strict: boolean, path: string): FileText {
  const { o, n } = splitItems(hunk.items);
  if (o.length > 0) {
    const found = findTier(file.lines, o, strict);
    if (!found) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let pos = found.occ[0]!;
    for (const q of found.occ) {
      if (Math.abs(q - target) < Math.abs(pos - target)) pos = q;
    }
    const newLines = replaceLines(file.lines, pos, o.length, n, found.tier, o);
    let fin = file.final;
    if (pos + o.length === file.lines.length) fin = !lastCtxOrAddNonl(hunk.items);
    return { br: file.br, lines: newLines, final: fin };
  }
  const ins = Math.max(0, Math.min(hunk.a + d, file.lines.length));
  const newLines = [...file.lines.slice(0, ins), ...n.map((it) => it.text), ...file.lines.slice(ins)];
  let fin = file.final;
  if (ins === file.lines.length) fin = !lastCtxOrAddNonl(hunk.items);
  return { br: file.br, lines: newLines, final: fin };
}

function makeUnifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = sec.isCreate || oldP === null;
    const isDelete = !isCreate && (sec.isDelete || newP === null);
    if (isCreate) {
      if (newP === null) throw new Fail('missing', oldP ?? '');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: BodyItem[] = [];
      for (const h of sec.hunks) for (const it of h.items) if (it.kind === 'add') plus.push(it);
      const lines = plus.map((it) => it.text);
      const noFinal = plus.length > 0 && plus[plus.length - 1]!.nonl === true;
      tree.now.set(newP, lines.length === 0 ? '' : lines.join('\n') + (noFinal ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('missing', newP ?? '');
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) throw new Fail('missing', oldP ?? newP ?? '');
    const isMove = oldP !== newP;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (isMove && !safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    let file = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const { o, n } = splitItems(h.items);
      file = applyHunk(file, h, d, strict, oldP);
      d += n.length - o.length;
    }
    const text = joinFile(file);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, text);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, text);
    }
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  const n = lines.length;
  let i = 0;
  /** Start a section; returns its index in `sections`. */
  const startSection = (oldP: string | null, newP: string | null): Section => {
    const sec: Section = { oldPath: oldP, newPath: newP, isCreate: false, isDelete: false, hunks: [] };
    sections.push(sec);
    return sec;
  };
  let sec: Section | null = null;
  /** Whether the current section's header already took a `---`/`+++` pair. */
  let pairSeen = false;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let gitOld: string | null = null;
  let gitNew: string | null = null;
  /** Finish the current section's paths: ---/+++ wins, then rename, then diff --git. */
  const finishPaths = (): void => {
    if (sec === null) return;
    if (!pairSeen) {
      if (renameFrom !== null) sec.oldPath = renameFrom;
      if (renameTo !== null) sec.newPath = renameTo;
    }
    if (sec.oldPath === null && gitOld !== null) sec.oldPath = gitOld;
    if (sec.newPath === null && gitNew !== null) sec.newPath = gitNew;
  };
  const beginSection = (oldP: string | null, newP: string | null): void => {
    finishPaths();
    sec = startSection(oldP, newP);
    pairSeen = false;
    renameFrom = null;
    renameTo = null;
    gitOld = null;
    gitNew = null;
  };
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      beginSection(null, null);
      gitOld = m[1]!;
      gitNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec === null || sec.hunks.length > 0 || pairSeen) {
        // A pair after hunks, or a second pair, starts a new section.
        beginSection(stripPrefix(headerPath(line)), stripPrefix(headerPath(lines[i + 1]!)));
        pairSeen = true;
        i += 2;
        continue;
      }
      sec.oldPath = stripPrefix(headerPath(line));
      sec.newPath = stripPrefix(headerPath(lines[i + 1]!));
      pairSeen = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (sec !== null && sec.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), items: [] };
      sec.hunks.push(hunk);
      i++;
      // The hunk's body: lines starting with ' ', '-', '+', '\', or empty.
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          hunk.items.push({ kind: 'ctx', text: '' });
          i++;
          continue;
        }
        const c = b[0]!;
        if (c === ' ') {
          hunk.items.push({ kind: 'ctx', text: b.slice(1) });
          i++;
        } else if (c === '-') {
          hunk.items.push({ kind: 'del', text: b.slice(1) });
          i++;
        } else if (c === '+') {
          hunk.items.push({ kind: 'add', text: b.slice(1) });
          i++;
        } else if (c === '\\') {
          const prev = hunk.items[hunk.items.length - 1];
          if (prev !== undefined) prev.nonl = true;
          i++;
        } else break;
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.items.length > 0) {
        const last = hunk.items[hunk.items.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.items.pop();
        else break;
      }
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      // Section header metadata.
      if (line.startsWith('rename from ')) renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.isCreate = true;
      else if (line.startsWith('deleted file mode')) sec.isDelete = true;
    }
    i++;
  }
  finishPaths();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => makeUnifiedEdit(s, strict));
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const file = splitFile(before);
    const found = findTier(file.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const nItems: NItem[] = newLines.map((t) => ({ text: t, ctx: null }));
    const newLinesOut = replaceLines(file.lines, pos, oldLines.length, nItems, found.tier, oldLines);
    tree.now.set(path, joinFile({ br: file.br, lines: newLinesOut, final: file.final }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevPath: string | null = null;
  let searchFrom = 0;
  while (searchFrom < n) {
    let s = -1;
    for (let j = searchFrom; j < n; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s === -1) break;
    // The path is the nearest line before the SEARCH line, and after the previous block's REPLACE line,
    // that is not blank and does not start with three backticks; the path is that line, trimmed.
    let path: string | null = null;
    for (let j = s - 1; j >= searchFrom; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(makeSearchReplaceEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    searchFrom = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- Section 8: V4A patches ----

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function makeV4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function makeV4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** Apply one V4A chunk; returns the file and the cursor just after the lines written. */
function applyV4aChunk(
  file: FileText,
  chunk: V4aChunk,
  cursor: number,
  strict: boolean,
  path: string,
): { file: FileText; cursor: number } {
  let cur = cursor;
  if (chunk.anchor !== null && chunk.anchor !== '') {
    let foundAt = -1;
    const max = strict ? 0 : 2;
    for (let t = 0; t <= max && foundAt < 0; t++) {
      for (let j = cur; j < file.lines.length; j++) {
        if (normTier(file.lines[j]!, t) === normTier(chunk.anchor, t)) {
          foundAt = j;
          break;
        }
      }
    }
    if (foundAt < 0) throw new Fail('no-match', path);
    cur = foundAt + 1;
  }
  const { o, n } = splitItems(chunk.items);
  if (o.length > 0) {
    let found: { tier: number; pos: number } | null = null;
    const max = strict ? 0 : 2;
    for (let t = 0; t <= max && found === null; t++) {
      const occ = occurrences(file.lines, o, t).filter((p) => p >= cur);
      if (chunk.eof) {
        const end = occ.find((p) => p + o.length === file.lines.length);
        if (end !== undefined) found = { tier: t, pos: end };
      } else if (occ.length > 0) {
        found = { tier: t, pos: occ[0]! };
      }
    }
    if (!found) throw new Fail('no-match', path);
    const newLines = replaceLines(file.lines, found.pos, o.length, n, found.tier, o);
    return { file: { br: file.br, lines: newLines, final: file.final }, cursor: found.pos + n.length };
  }
  const ins = chunk.eof ? file.lines.length : cur;
  const newLines = [...file.lines.slice(0, ins), ...n.map((it) => it.text), ...file.lines.slice(ins)];
  return { file: { br: file.br, lines: newLines, final: file.final }, cursor: ins + n.length };
}

function makeV4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let file = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      const r = applyV4aChunk(file, chunk, cursor, strict, path);
      file = r.file;
      cursor = r.cursor;
    }
    const text = joinFile(file);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = n - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      // Collect the section's lines, up to the next section or End Patch.
      let end = last;
      for (let j = i + 1; j < last; j++) {
        if (isV4aSectionStart(lines[j]!)) {
          end = j;
          break;
        }
      }
      const raw = lines.slice(i + 1, end);
      // Blank lines at the end of a section are not part of it.
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (blank(l)) fileLines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(makeV4aAddEdit(path, fileLines));
      i = end;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      let end = last;
      for (let j = i + 1; j < last; j++) {
        if (isV4aSectionStart(lines[j]!)) {
          end = j;
          break;
        }
      }
      for (let j = i + 1; j < end; j++) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push(makeV4aDeleteEdit(path));
      i = end;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i;
      let end = last;
      for (let j = i + 1; j < last; j++) {
        if (isV4aSectionStart(lines[j]!)) {
          end = j;
          break;
        }
      }
      const raw = lines.slice(i + 1, end);
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let started = false;
      for (; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: l.slice(2).trim(), eof: false, items: [] };
          started = true;
        } else if (l.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 2 + k}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          started = true;
        } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || blank(l)) {
          if (cur === null) {
            if (started) throw new Exit2(`error: parse ${i + 2 + k}`);
            cur = { anchor: null, eof: false, items: [] };
            started = true;
          }
          if (blank(l)) cur.items.push({ kind: 'ctx', text: '' });
          else if (l[0] === ' ') cur.items.push({ kind: 'ctx', text: l.slice(1) });
          else if (l[0] === '-') cur.items.push({ kind: 'del', text: l.slice(1) });
          else cur.items.push({ kind: 'add', text: l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${i + 2 + k}`);
        }
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(makeV4aUpdateEdit(path, moveTo, chunks, strict));
      i = end;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- Section 9: JSON edits ----

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

// ---- Section 10: order, atomicity, output ----

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
    const movesBefore = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: one line per changed path, in byte order of the paths; a successful move is one `R` line
  // (sorted by its new path) replacing that pair's `D` and `A` lines.
  const rows: { key: string; text: string }[] = [];
  const moved = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      moved.add(oldP);
      moved.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
