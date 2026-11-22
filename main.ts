// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none. See SPEC.md for the
// contract this file implements. Node 22, standard library only; run as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown to report `error: parse <line>`. */
class ParseError {
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }
}

/** Thrown by one edit to report `error: <code> <path>`. */
class EditError {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

/** A patch's lines: split at `\n`, one trailing `\r` removed from each, and
 *  the empty piece after a final `\n` dropped. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isBlank(s: string): boolean {
  return s.trim() === '';
}

/** A path is safe when it is not empty, does not start with `/`, holds no
 *  `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function isSafe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** A file's lines under its own line break, and whether it ends with one. */
interface FileModel {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function modelOf(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function renderModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** Whether two lines are equal at a matching tier. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Every 0-based position at or after `from` where `old` occurs in `lines`
 *  at `tier`; occurrences may overlap. */
function occurrencesAt(lines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (!lineEq(lines[i + j]!, old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `old` occurs at or after `from`, or -1. */
function firstTier(lines: string[], old: string[], from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    if (occurrencesAt(lines, old, t, from).length > 0) return t;
  }
  return -1;
}

/** One line of a replacement: `ctx` names its index in the old lines when
 *  it is a context line (written as the file's own matched line), else null. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** How one replacement line is written: context lines come from the file,
 *  other lines are re-indented at tier 2 and written as they are otherwise. */
function mapNewLine(nl: NewLine, fileLines: string[], at: number, old: string[], tier: number): string {
  if (nl.ctx !== null) return fileLines[at + nl.ctx]!;
  if (tier !== 2) return nl.text;
  const f = leadWs(fileLines[at]!);
  const p = leadWs(old[0]!);
  const t = nl.text;
  if (t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
  return t;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 *  the rest read from disk on demand. */
class Tree {
  orig = new Map<string, string | null>();
  now = new Map<string, string | null>();

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

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

/** One edit: applies itself to the tree, or throws an EditError. It may
 *  return a move, for the `R old -> new` output line. */
type EditResult = { move?: { from: string; to: string } };
type EditFn = (tree: Tree) => EditResult | void;

/** The format of a patch, or null when none is detected. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when the value is not a valid edit. */
function jsonEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path as string;

  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text as string;
    return (tree) => {
      if (!isSafe(p)) throw new EditError('unsafe', p);
      if (tree.get(p) !== null) throw new EditError('exists', p);
      tree.set(p, text);
    };
  }

  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str as string;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafe(p)) throw new EditError('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditError('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditError('no-match', p);
      if (count > 1) throw new EditError('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.split('\n').join('\r\n') : out);
    };
  }

  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const atLine = o.insert_line as number;
    const add = splitPatch(o.new_str as string);
    return (tree) => {
      if (!isSafe(p)) throw new EditError('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditError('missing', p);
      const model = modelOf(before);
      if (atLine < 0 || atLine > model.lines.length) throw new EditError('no-match', p);
      const out = [...model.lines];
      out.splice(atLine, 0, ...add);
      tree.set(p, renderModel({ br: model.br, lines: out, finalBreak: model.finalBreak }));
    };
  }

  return null;
}

/** The JSON edits of a patch: one JSON array, or one edit object per line. */
function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError(1);
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseError(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseError(first + 1);
    for (const item of v) {
      const e = jsonEdit(item);
      if (e === null) throw new ParseError(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseError(i + 1);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

/** One body line of a hunk: context, old, new, or a `\` marker line. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
  raw: string;
}

interface Hunk {
  oldStart: number;
  items: BodyItem[];
}

/** The old and new lines of a hunk, in body order. */
function hunkSides(h: Hunk): { old: string[]; next: NewLine[] } {
  const old: string[] = [];
  const next: NewLine[] = [];
  for (const item of h.items) {
    if (item.kind === 'ctx') {
      old.push(item.text);
      next.push({ text: item.text, ctx: old.length - 1 });
    } else if (item.kind === 'old') {
      old.push(item.text);
    } else if (item.kind === 'new') {
      next.push({ text: item.text, ctx: null });
    }
  }
  return { old, next };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoBreak(h: Hunk): boolean {
  let last = -1;
  h.items.forEach((item, i) => {
    if (item.kind === 'ctx' || item.kind === 'new') last = i;
  });
  return last >= 0 && h.items[last + 1] !== undefined && h.items[last + 1]!.kind === 'mark';
}

/** Apply one section's hunks to a file's text, in order. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let model = modelOf(text);
  let d = 0;
  for (const h of hunks) {
    const { old, next } = hunkSides(h);
    if (old.length === 0) {
      const pos = Math.min(Math.max(h.oldStart + d, 0), model.lines.length);
      const atEnd = pos === model.lines.length;
      const noBreak = atEnd && hunkNoBreak(h);
      const lines = [...model.lines.slice(0, pos), ...next.map((n) => n.text), ...model.lines.slice(pos)];
      model = { br: model.br, lines, finalBreak: atEnd ? !noBreak : model.finalBreak };
      d += next.length;
      continue;
    }
    const tier = firstTier(model.lines, old, 0, strict);
    if (tier < 0) throw new EditError('no-match', path);
    const occ = occurrencesAt(model.lines, old, tier, 0);
    const target = h.oldStart - 1 + d;
    let at = occ[0]!;
    for (const p of occ) {
      if (Math.abs(p - target) < Math.abs(at - target)) at = p;
    }
    const runsToEnd = at + old.length === model.lines.length;
    const noBreak = runsToEnd && hunkNoBreak(h);
    const lines = [
      ...model.lines.slice(0, at),
      ...next.map((n) => mapNewLine(n, model.lines, at, old, tier)),
      ...model.lines.slice(at + old.length),
    ];
    model = { br: model.br, lines, finalBreak: runsToEnd ? !noBreak : model.finalBreak };
    d += next.length - old.length;
  }
  return renderModel(model);
}

interface UniSection {
  dashOld: string | undefined;
  dashNew: string | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` header path: text after the four characters, up to the
 *  first tab, with surrounding spaces removed, and a leading `a/` or `b/`
 *  removed. */
function headerPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Read the unified sections of a patch. */
function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let headed = false; // cur exists and has taken no hunk yet
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new ParseError(i + 1);
      cur = {
        dashOld: undefined, dashNew: undefined,
        renameOld: undefined, renameNew: undefined,
        gitOld: m[1], gitNew: m[2],
        create: false, remove: false, hunks: [],
      };
      sections.push(cur);
      headed = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && headed && cur.dashOld === undefined) {
        cur.dashOld = headerPath(line);
        cur.dashNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      cur = {
        dashOld: headerPath(line), dashNew: headerPath(lines[i + 1]!),
        renameOld: undefined, renameNew: undefined,
        gitOld: undefined, gitNew: undefined,
        create: false, remove: false, hunks: [],
      };
      sections.push(cur);
      headed = true;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new ParseError(i + 1);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new ParseError(i + 1);
      const hunk: Hunk = { oldStart: Number(m[1]), items: [] };
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          if (b === '') hunk.items.push({ kind: 'ctx', text: '', raw: b });
          else if (b[0] === ' ') hunk.items.push({ kind: 'ctx', text: b.slice(1), raw: b });
          else if (b[0] === '-') hunk.items.push({ kind: 'old', text: b.slice(1), raw: b });
          else if (b[0] === '+') hunk.items.push({ kind: 'new', text: b.slice(1), raw: b });
          else hunk.items.push({ kind: 'mark', text: b.slice(1), raw: b });
          i += 1;
          continue;
        }
        break;
      }
      while (hunk.items.length > 0 && hunk.items[hunk.items.length - 1]!.raw === '') hunk.items.pop();
      cur.hunks.push(hunk);
      headed = false;
      continue;
    }
    if (headed) {
      if (line.startsWith('--- ')) throw new ParseError(i + 2);
      if (line.startsWith('+++ ')) {
        cur.dashNew = headerPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.remove = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new ParseError(1);
  return sections.map((s) => unifiedEdit(s, strict));
}

/** The path a section names: the `---`/`+++` pair first, then `rename
 *  from`/`to`, then the `diff --git` paths; `/dev/null` means no file. */
function sectionPath(dash: string | undefined, rename: string | undefined, git: string | undefined): string | null | undefined {
  const raw = dash ?? rename ?? git;
  if (raw === undefined) return undefined;
  return raw === '/dev/null' ? null : raw;
}

/** One unified section as an edit. */
function unifiedEdit(s: UniSection, strict: boolean): EditFn {
  const oldPath = sectionPath(s.dashOld, s.renameOld, s.gitOld);
  const newPath = sectionPath(s.dashNew, s.renameNew, s.gitNew);
  return (tree) => {
    const isCreate = s.create || oldPath === null;
    const isDelete = !isCreate && (s.remove || newPath === null);
    if (isCreate) {
      const p = newPath === null || newPath === undefined ? '/dev/null' : newPath;
      if (!isSafe(p)) throw new EditError('unsafe', p);
      if (tree.get(p) !== null) throw new EditError('exists', p);
      const plus: string[] = [];
      let noBreak = false;
      for (const h of s.hunks) {
        for (const item of h.items) {
          if (item.kind === 'new') plus.push(item.text);
        }
        let lastPlus = -1;
        h.items.forEach((item, idx) => {
          if (item.kind === 'new') lastPlus = idx;
        });
        if (lastPlus >= 0) {
          noBreak = h.items[lastPlus + 1] !== undefined && h.items[lastPlus + 1]!.kind === 'mark';
        }
      }
      tree.set(p, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldPath === null || oldPath === undefined ? '/dev/null' : oldPath;
      if (!isSafe(p)) throw new EditError('unsafe', p);
      if (tree.get(p) === null) throw new EditError('missing', p);
      tree.set(p, null);
      return;
    }
    const oldP = oldPath as string;
    const newP = newPath as string;
    if (oldP !== newP) {
      if (!isSafe(oldP)) throw new EditError('unsafe', oldP);
      if (!isSafe(newP)) throw new EditError('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new EditError('missing', oldP);
      if (tree.get(newP) !== null) throw new EditError('exists', newP);
      tree.set(newP, applyHunks(before, s.hunks, strict, oldP));
      tree.set(oldP, null);
      return { move: { from: oldP, to: newP } };
    }
    if (!isSafe(oldP)) throw new EditError('unsafe', oldP);
    const before = tree.get(oldP);
    if (before === null) throw new EditError('missing', oldP);
    tree.set(oldP, applyHunks(before, s.hunks, strict, oldP));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): EditFn {
  return (tree) => {
    if (!isSafe(path)) throw new EditError('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditError('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditError('missing', path);
    const model = modelOf(before);
    const tier = firstTier(model.lines, oldLines, 0, strict);
    if (tier < 0) throw new EditError('no-match', path);
    const occ = occurrencesAt(model.lines, oldLines, tier, 0);
    if (occ.length > 1) throw new EditError('ambiguous', path);
    const at = occ[0]!;
    const next: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const lines = [
      ...model.lines.slice(0, at),
      ...next.map((n) => mapNewLine(n, model.lines, at, oldLines, tier)),
      ...model.lines.slice(at + oldLines.length),
    ];
    tree.set(path, renderModel({ br: model.br, lines, finalBreak: model.finalBreak }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseError(searchAt + 1);
    let j = searchAt + 1;
    let sep = -1;
    while (j < lines.length) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      j += 1;
    }
    if (sep < 0) throw new ParseError(searchAt + 1);
    let k = sep + 1;
    let end = -1;
    while (k < lines.length) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      k += 1;
    }
    if (end < 0) throw new ParseError(searchAt + 1);
    edits.push(searchReplaceEdit(path, lines.slice(searchAt + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  startNo: number;
  body: { text: string; no: number }[];
}

function v4aChunkSides(ch: V4aChunk): { old: string[]; next: NewLine[] } {
  const old: string[] = [];
  const next: NewLine[] = [];
  for (const item of ch.items) {
    if (item.kind === 'ctx') {
      old.push(item.text);
      next.push({ text: item.text, ctx: old.length - 1 });
    } else if (item.kind === 'old') {
      old.push(item.text);
    } else if (item.kind === 'new') {
      next.push({ text: item.text, ctx: null });
    }
  }
  return { old, next };
}

function v4aEdit(s: V4aSection, strict: boolean): EditFn {
  const path = s.path;
  if (s.kind === 'add') {
    const fileLines: string[] = [];
    for (const b of s.body) {
      if (b.text.startsWith('+')) fileLines.push(b.text.slice(1));
      else if (b.text.trim() === '') fileLines.push('');
      else throw new ParseError(b.no);
    }
    return (tree) => {
      if (!isSafe(path)) throw new EditError('unsafe', path);
      if (tree.get(path) !== null) throw new EditError('exists', path);
      tree.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    if (s.body.length > 0) throw new ParseError(s.body[0]!.no);
    return (tree) => {
      if (!isSafe(path)) throw new EditError('unsafe', path);
      if (tree.get(path) === null) throw new EditError('missing', path);
      tree.set(path, null);
    };
  }
  let idx = 0;
  let moveTo: string | null = null;
  if (s.body.length > 0 && s.body[0]!.text.startsWith('*** Move to: ')) {
    moveTo = s.body[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let seenChunk = false;
  for (; idx < s.body.length; idx++) {
    const b = s.body[idx]!;
    const l = b.text;
    if (l.startsWith('@@')) {
      cur = { anchor: l.slice(2).trim(), eof: false, items: [] };
      chunks.push(cur);
      seenChunk = true;
      continue;
    }
    if (l.trim() === '*** End of File' && !l.startsWith(' ') && !l.startsWith('-') && !l.startsWith('+')) {
      if (cur === null) throw new ParseError(b.no);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (l.startsWith('*** Move to: ')) throw new ParseError(b.no);
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (seenChunk) throw new ParseError(b.no);
        cur = { anchor: null, eof: false, items: [] };
        chunks.push(cur);
        seenChunk = true;
      }
      if (l === '') cur.items.push({ kind: 'ctx', text: '', raw: l });
      else if (l.startsWith(' ')) cur.items.push({ kind: 'ctx', text: l.slice(1), raw: l });
      else if (l.startsWith('-')) cur.items.push({ kind: 'old', text: l.slice(1), raw: l });
      else cur.items.push({ kind: 'new', text: l.slice(1), raw: l });
      continue;
    }
    throw new ParseError(b.no);
  }
  if (chunks.length === 0 && moveTo === null) throw new ParseError(s.startNo);
  return (tree) => {
    if (!isSafe(path)) throw new EditError('unsafe', path);
    if (moveTo !== null && !isSafe(moveTo)) throw new EditError('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new EditError('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditError('exists', moveTo);
    let model = modelOf(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const tiers = strict ? [0] : [0, 1, 2];
        let found = -1;
        for (const t of tiers) {
          for (let p = cursor; p < model.lines.length; p++) {
            if (lineEq(model.lines[p]!, ch.anchor, t)) {
              found = p;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new EditError('no-match', path);
        cursor = found + 1;
      }
      const { old, next } = v4aChunkSides(ch);
      if (old.length === 0) {
        const pos = ch.eof ? model.lines.length : cursor;
        const lines = [...model.lines.slice(0, pos), ...next.map((n) => n.text), ...model.lines.slice(pos)];
        cursor = pos + next.length;
        model = { br: model.br, lines, finalBreak: model.finalBreak };
        continue;
      }
      const tiers = strict ? [0] : [0, 1, 2];
      let tier = -1;
      let occ: number[] = [];
      for (const t of tiers) {
        occ = occurrencesAt(model.lines, old, t, cursor);
        if (ch.eof) occ = occ.filter((p) => p + old.length === model.lines.length);
        if (occ.length > 0) {
          tier = t;
          break;
        }
      }
      if (tier < 0) throw new EditError('no-match', path);
      const at = occ[0]!;
      const lines = [
        ...model.lines.slice(0, at),
        ...next.map((n) => mapNewLine(n, model.lines, at, old, tier)),
        ...model.lines.slice(at + old.length),
      ];
      cursor = at + next.length;
      model = { br: model.br, lines, finalBreak: model.finalBreak };
    }
    const out = renderModel(model);
    if (moveTo !== null) {
      tree.set(moveTo, out);
      tree.set(path, null);
      return { move: { from: path, to: moveTo } };
    }
    tree.set(path, out);
  };
}

function parseV4a(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseError(lines.length + 1);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    let kind: V4aSection['kind'];
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new ParseError(i + 1);
    }
    const startNo = i + 1;
    i += 1;
    const body: { text: string; no: number }[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      body.push({ text: l, no: i + 1 });
      i += 1;
    }
    while (body.length > 0 && body[body.length - 1]!.text.trim() === '') body.pop();
    sections.push({ kind, path, startNo, body });
  }
  if (sections.length === 0) throw new ParseError(1);
  return sections.map((s) => v4aEdit(s, strict));
}

// ---------------------------------------------------------------------------
// Command line, output and exit codes (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function parsePatch(kind: string, text: string, lines: string[], strict: boolean): EditFn[] {
  if (kind === 'unified') return parseUnified(lines, strict);
  if (kind === 'search-replace') return parseSearchReplace(lines, strict);
  if (kind === 'v4a') return parseV4a(lines, strict);
  return parseJson(text, lines);
}

function run(argv: string[]): { code: number; out: string[] } {
  const usage = { code: 2, out: ['error: usage'] };
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return usage;
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return usage;
        format = v;
      } else if (a === '--check') {
        if (check) return usage;
        check = true;
      } else if (a === '--strict') {
        if (strict) return usage;
        strict = true;
      } else {
        return usage;
      }
      continue;
    }
    pos.push(a);
  }
  if (pos.length > 1) return usage;
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    edits = parsePatch(kind, text, lines, strict);
  } catch (e) {
    if (e instanceof ParseError) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  if (edits.length === 0) return { code: 2, out: ['error: parse 1'] };

  const tree = new Tree();
  const fails: EditError[] = [];
  const moves: { from: string; to: string }[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    try {
      const r = edit(tree);
      if (r !== undefined && r.move !== undefined) moves.push(r.move);
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      tree.now.clear();
      for (const [k, v] of snapshot) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  const rows: { key: string; line: string }[] = [];
  const coveredDel = new Set<string>();
  const coveredAdd = new Set<string>();
  for (const m of moves) {
    if (
      tree.original(m.from) !== null &&
      tree.get(m.from) === null &&
      tree.original(m.to) === null &&
      tree.get(m.to) !== null
    ) {
      rows.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
      coveredDel.add(m.from);
      coveredAdd.add(m.to);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCompare)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null && coveredAdd.has(p)) continue;
    if (now === null && coveredDel.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));

  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCompare)) {
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
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
