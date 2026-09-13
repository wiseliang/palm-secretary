import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { parseDocument } from 'yaml';

export class KnowledgeError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
export type KnowledgeNote = { path: string; title: string; modifiedAt: string; tags: string[]; excerpt: string };
type IndexedNote = KnowledgeNote & { body: string; signature: string };
const NOTE_LIMIT = 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif' };
const visible = (name: string) => !name.startsWith('.') && !/^agents\.md$/i.test(name) && !name.includes('sync-conflict');
const publicNote = ({ path: file, title, modifiedAt, tags, excerpt }: IndexedNote): KnowledgeNote => ({ path: file, title, modifiedAt, tags, excerpt });

export class KnowledgeStore {
  private notes = new Map<string, IndexedNote>();
  private assets = new Set<string>();
  private checkedAt = 0;
  private pending?: Promise<void>;
  private warnings: string[] = [];
  constructor(private root: string, private ttl = 10_000) {}

  private validate(file: string) {
    if (!file || file.includes('\\') || file.includes('\0') || file.includes(':') || path.posix.isAbsolute(file) || file.split('/').some(p => !p || p === '..' || p === '.' || !visible(p))) {
      throw new KnowledgeError(400, '无法访问这个知识库路径');
    }
  }

  private async safeFile(file: string, limit: number) {
    this.validate(file);
    const root = await realpath(this.root);
    let current = root;
    for (const part of file.split('/')) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new KnowledgeError(403, '知识库不读取链接目录或链接文件');
    }
    const resolved = await realpath(current);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new KnowledgeError(403, '无法访问知识库之外的文件');
    const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const details = await handle.stat();
      if (!details.isFile()) throw new KnowledgeError(404, '文件不存在');
      if (details.size > limit) throw new KnowledgeError(413, '文件过大，暂时无法在线阅读');
      // Bounded reads also protect against a file growing while Syncthing updates it.
      const buffer = Buffer.alloc(Math.min(details.size + 1, limit + 1));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > limit || length > details.size) throw new KnowledgeError(409, '笔记正在更新，请稍后重试');
      return { buffer: buffer.subarray(0, length), details };
    } finally { await handle.close(); }
  }

  private async parse(file: string): Promise<IndexedNote> {
    const { buffer, details } = await this.safeFile(file, NOTE_LIMIT);
    let body = buffer.toString('utf8').replace(/^\uFEFF/, '');
    let title = ''; let tags: string[] = [];
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
    if (frontmatter) {
      try {
        const doc = parseDocument(frontmatter[1]);
        if (!doc.errors.length) {
          const meta = doc.toJS({ maxAliasCount: 20 });
          if (meta && typeof meta === 'object') {
            title = typeof meta.title === 'string' ? meta.title : '';
            const values = Array.isArray(meta.tags) ? meta.tags : typeof meta.tags === 'string' ? meta.tags.split(/[,，\s]+/) : [];
            tags = values.filter((v: unknown): v is string => typeof v === 'string').slice(0, 30);
          }
          body = body.slice(frontmatter[0].length);
        }
      } catch { /* Keep malformed metadata visible instead of losing content. */ }
    }
    title ||= /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || path.posix.basename(file, path.posix.extname(file));
    return { path: file, title, tags, body, modifiedAt: details.mtime.toISOString(), signature: `${details.mtimeMs}:${details.ctimeMs}:${details.size}`, excerpt: body.replace(/[#>*`\[\]_|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 130) };
  }

  async refresh(force = false) {
    if (this.pending) return this.pending;
    if (!force && Date.now() - this.checkedAt < this.ttl) return;
    this.pending = this.scan().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async scan() {
    const notes = new Map<string, IndexedNote>(); const assets = new Set<string>();
    let total = 0; let entriesSeen = 0; let skipped = 0;
    const walk = async (prefix: string, depth: number) => {
      if (depth > 20) { skipped++; return; }
      for (const entry of await readdir(path.join(this.root, prefix), { withFileTypes: true })) {
        if (++entriesSeen > 20_000) { skipped++; break; }
        if (!visible(entry.name) || entry.isSymbolicLink()) continue;
        const file = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { await walk(file, depth + 1); continue; }
        if (!entry.isFile()) continue;
        if (IMAGE_TYPES[path.posix.extname(file).toLowerCase()]) assets.add(file);
        if (!/\.md$/i.test(file)) continue;
        try {
          const details = await lstat(path.join(this.root, file));
          if (notes.size >= 5000 || total + details.size > 64 * 1024 * 1024 || details.size > NOTE_LIMIT) { skipped++; continue; }
          const previous = this.notes.get(file);
          const note = previous?.signature === `${details.mtimeMs}:${details.ctimeMs}:${details.size}` ? previous : await this.parse(file);
          notes.set(file, note); total += details.size;
        } catch { skipped++; }
      }
    };
    try { await walk('', 0); }
    catch { throw new KnowledgeError(503, '知识库暂时无法读取，请稍后刷新'); }
    this.notes = notes; this.assets = assets; this.checkedAt = Date.now();
    this.warnings = skipped ? ['部分文件正在同步、无法读取或超出阅读上限，请稍后刷新。'] : [];
  }

  async list(query = '', force = false) {
    await this.refresh(force);
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
    const matches = [...this.notes.values()].flatMap(note => {
      const title = note.title.toLocaleLowerCase(); const body = note.body.toLocaleLowerCase();
      const haystack = `${title}\n${note.path}\n${note.tags.join(' ')}\n${body}`.toLocaleLowerCase();
      if (!terms.every(term => haystack.includes(term))) return [];
      const hit = terms.length ? body.indexOf(terms[0]) : -1;
      return [{ ...publicNote(note), excerpt: hit >= 0 ? `${hit > 35 ? '…' : ''}${note.body.slice(Math.max(0, hit - 35), hit + 100).replace(/\s+/g, ' ')}` : note.excerpt, score: terms.reduce((n, term) => n + (title.includes(term) ? 10 : 0), 0) }];
    }).sort((a, b) => b.score - a.score || b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path, 'zh-CN'));
    return { notes: matches.map(note => ({ path: note.path, title: note.title, modifiedAt: note.modifiedAt, tags: note.tags, excerpt: note.excerpt })), total: this.notes.size, checkedAt: new Date(this.checkedAt).toISOString(), warnings: this.warnings };
  }

  async read(file: string) {
    this.validate(file);
    if (!/\.md$/i.test(file)) throw new KnowledgeError(400, '请选择 Markdown 笔记');
    try { const note = await this.parse(file); return { ...publicNote(note), body: note.body }; }
    catch (error) {
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError(404, '笔记不存在，可能已被移动或重命名');
    }
  }

  async resolve(target: string, from = '', image = false) {
    await this.refresh();
    if (from) this.validate(from);
    const hash = target.indexOf('#');
    const anchor = hash >= 0 ? target.slice(hash + 1) : '';
    let name = hash >= 0 ? target.slice(0, hash) : target;
    if (!name && from && !image) return { path: from, anchor };
    if (name.includes('\\') || name.includes(':') || name.includes('\0')) throw new KnowledgeError(400, '不支持这个链接');
    if (!image && !/\.md$/i.test(name)) name += '.md';
    const source = image ? this.assets : new Set(this.notes.keys());
    const local = path.posix.normalize(path.posix.join(path.posix.dirname(from), name));
    const rootName = name.replace(/^\//, '');
    for (const candidate of [local, rootName]) {
      if (source.has(candidate)) return { path: candidate, anchor };
    }
    const matches = [...source].filter(file => file === rootName || file.endsWith(`/${rootName}`));
    if (matches.length > 1) throw new KnowledgeError(409, '找到多篇同名内容，请在 Obsidian 链接中补充文件夹路径');
    if (!matches.length) throw new KnowledgeError(404, image ? '图片不存在，可能尚未同步' : '链接的笔记不存在，可能尚未同步');
    return { path: matches[0], anchor };
  }

  async image(target: string, from: string) {
    const resolved = await this.resolve(target, from, true);
    const type = IMAGE_TYPES[path.posix.extname(resolved.path).toLowerCase()];
    if (!type) throw new KnowledgeError(415, '暂不支持这个附件格式');
    try { return { ...(await this.safeFile(resolved.path, 20 * 1024 * 1024)), type }; }
    catch (error) { if (error instanceof KnowledgeError) throw error; throw new KnowledgeError(404, '图片暂时无法读取'); }
  }
}
