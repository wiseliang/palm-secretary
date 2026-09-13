"use client";

import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { ArrowClockwise, ArrowLeft, ArrowUpRight, BookOpen, CaretRight, Check, Copy, FileText, FolderOpen, List, MagnifyingGlass, X } from '@phosphor-icons/react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { slug } from 'github-slugger';
import { remarkKnowledge } from './knowledge-markdown';
import { REFERENCE_LIMIT, type KnowledgeReference } from './knowledge-reference';
import KnowledgeReferenceDialog from './knowledge-reference-dialog';

type Note = { path: string; title: string; modifiedAt: string; tags: string[]; excerpt: string; body?: string };
type Index = { notes: Note[]; total: number; checkedAt: string; warnings: string[] };
type Heading = { id: string; label: string; level: number };
type Branch = { folders: Map<string, Branch>; notes: Note[] };
function treeOf(notes: Note[]) {
  const root: Branch = { folders: new Map(), notes: [] };
  for (const note of notes) {
    let branch = root;
    for (const folder of note.path.split('/').slice(0, -1)) {
      if (!branch.folders.has(folder)) branch.folders.set(folder, { folders: new Map(), notes: [] });
      branch = branch.folders.get(folder)!;
    }
    branch.notes.push(note);
  }
  return root;
}
function Directory({ branch, selected, onOpen, prefix = '' }: { branch: Branch; selected: string; onOpen: (path: string) => void; prefix?: string }) {
  return <ul className="kb-tree">
    {[...branch.folders].sort(([a], [b]) => a.localeCompare(b, 'zh-CN')).map(([name, child]) => <li key={name}>
      <details open={selected.startsWith(`${prefix}${name}/`) || undefined}>
        <summary><CaretRight size={13} /><FolderOpen size={17} /><span>{name}</span></summary>
        <Directory branch={child} selected={selected} onOpen={onOpen} prefix={`${prefix}${name}/`} />
      </details>
    </li>)}
    {[...branch.notes].sort((a, b) => a.title.localeCompare(b.title, 'zh-CN')).map(note => <li key={note.path}>
      <button className={note.path === selected ? 'selected' : ''} aria-current={note.path === selected ? 'page' : undefined} onClick={() => onOpen(note.path)} title={note.path}><FileText size={16} /><span>{note.title}</span></button>
    </li>)}
  </ul>;
}
async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: 'no-store' });
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(response.status === 401 ? '登录已过期，请刷新页面重新登录' : value.error || '暂时无法读取，请重试');
  return value;
}
function date(value: string) { return new Date(value).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }); }
function safeDecode(value: string) { try { return decodeURIComponent(value); } catch { return value; } }
function targetOf(value: string) { return safeDecode(value.replace(/^kb-(?:note|image):/, '')); }
function VaultImage({ src, alt, source }: { src?: string; alt?: string; source: string }) {
  const [failed, setFailed] = useState(false);
  const external = /^https?:\/\//i.test(src || '');
  const url = !src ? '' : external ? src : `/api/knowledge/image?${new URLSearchParams({ target: targetOf(src), from: source })}`;
  return !url || failed ? <span className="kb-image-error">图片暂时无法显示{alt ? `：${alt}` : ''}</span> :
    // Vault images are authenticated dynamic resources, so they bypass Next's image optimizer.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt={alt || '笔记图片'} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

export default function Knowledge({ onReference, referenceTarget, replacingReference = false }: { onReference: (reference: KnowledgeReference) => string | undefined; referenceTarget: string; replacingReference?: boolean }) {
  const [index, setIndex] = useState<Index>();
  const [selected, setSelected] = useState('');
  const [note, setNote] = useState<Note>();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Note[]>();
  const [error, setError] = useState('');
  const [noteError, setNoteError] = useState('');
  const [linkError, setLinkError] = useState('');
  const [searchError, setSearchError] = useState('');
  const [busy, setBusy] = useState(true);
  const [reading, setReading] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reload, setReload] = useState(0);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [selection, setSelection] = useState({ path: '', text: '' });
  const [referencePreview, setReferencePreview] = useState<KnowledgeReference>();
  const article = useRef<HTMLElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const pendingAnchor = useRef('');
  const linkRequest = useRef(0);

  useEffect(() => {
    const capture = () => {
      const range = window.getSelection();
      const prose = article.current?.querySelector('.kb-prose');
      const text = range?.anchorNode && range.focusNode && prose?.contains(range.anchorNode) && prose.contains(range.focusNode) ? range.toString().trim() : '';
      setSelection(previous => previous.path === selected && previous.text === text ? previous : { path: selected, text });
    };
    document.addEventListener('selectionchange', capture);
    return () => document.removeEventListener('selectionchange', capture);
  }, [selected]);

  function prepareReference() {
    if (!note || note.path !== selected || reading) return;
    const excerpt = selection.path === selected ? selection.text : '';
    const content = excerpt || note.body || '';
    if (!content.trim()) { setLinkError('这篇笔记还没有可引用的正文'); return; }
    if (content.length > REFERENCE_LIMIT) { setLinkError('内容较长，请先选中要讨论的段落，每次最多引用 24,000 个字符'); return; }
    const source = new URL('/', window.location.origin);
    source.searchParams.set('knowledge', selected);
    setReferencePreview({ version: 1, path: selected, title: note.title, sourceUrl: source.href, modifiedAt: note.modifiedAt, capturedAt: new Date().toISOString(), scope: excerpt ? 'selection' : 'note', content });
  }

  const openNote = useCallback((file: string, anchor = '') => {
    linkRequest.current++;
    const url = new URL(window.location.href);
    url.searchParams.set('knowledge', file);
    url.hash = anchor ? `kb-${slug(anchor)}` : '';
    window.history.pushState({}, '', url);
    pendingAnchor.current = safeDecode(url.hash.slice(1));
    setSelected(file); setDrawer(false); setLinkError(''); setNoteError('');
    if (pendingAnchor.current) document.getElementById(pendingAnchor.current)?.scrollIntoView({ block: 'start' });
    else window.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    const restore = () => {
      linkRequest.current++;
      setSelected(new URL(window.location.href).searchParams.get('knowledge') || '');
      pendingAnchor.current = safeDecode(window.location.hash.slice(1));
      setDrawer(false); setLinkError('');
    };
    const timer = setTimeout(restore, 0);
    window.addEventListener('popstate', restore);
    return () => { clearTimeout(timer); window.removeEventListener('popstate', restore); restoreCancelled(); };
    function restoreCancelled() { linkRequest.current++; }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = async (force = false) => {
      try {
        const data = await getJson<Index>(`/api/knowledge${force ? '?refresh=1' : ''}`, controller.signal);
        if (!controller.signal.aborted) { setIndex(data); setError(''); }
      } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
      finally { if (!controller.signal.aborted) setBusy(false); }
    };
    void load(reload > 0);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 15_000);
    const focus = () => { void load(); };
    window.addEventListener('focus', focus);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [reload]);

  const modified = index?.notes.find(item => item.path === selected)?.modifiedAt;
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setReading(true); setNoteError('');
      void getJson<Note>(`/api/knowledge/note?${new URLSearchParams({ path: selected })}`, controller.signal)
        .then(value => { if (!controller.signal.aborted) setNote(value); })
        .catch(e => { if (!controller.signal.aborted) { setNote(undefined); setNoteError(e.message); } })
        .finally(() => { if (!controller.signal.aborted) setReading(false); });
    }, 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [selected, modified, reload]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearchError('');
      if (!query.trim()) { setResults(undefined); return; }
      void getJson<Index>(`/api/knowledge?${new URLSearchParams({ q: query })}`, controller.signal)
        .then(value => { if (!controller.signal.aborted) setResults(value.notes); })
        .catch(e => { if (!controller.signal.aborted) setSearchError(e.message); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, index?.checkedAt]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setHeadings(Array.from(article.current?.querySelectorAll('h1[id],h2[id],h3[id]') ?? []).map(el => ({ id: el.id, label: el.textContent || '', level: Number(el.tagName.slice(1)) })));
      if (pendingAnchor.current && note?.path === selected && !reading && article.current) {
        const element = document.getElementById(pendingAnchor.current);
        if (element) element.scrollIntoView({ block: 'start' });
        else if (note?.path === selected) setLinkError('文章已打开，但没有找到对应的小标题');
        pendingAnchor.current = '';
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [note, selected, reading]);

  async function followLink(href: string) {
    const request = ++linkRequest.current;
    setLinkError('');
    try {
      const resolved = await getJson<{ path: string; anchor: string }>(`/api/knowledge/resolve?${new URLSearchParams({ target: targetOf(href), from: selected })}`);
      if (request === linkRequest.current) openNote(resolved.path, resolved.anchor);
    } catch (e) { if (request === linkRequest.current) setLinkError((e as Error).message); }
  }
  const components: ComponentProps<typeof Markdown>['components'] = {
    a: ({ href, children }) => {
      if (/^https?:\/\//i.test(href || '') || /^mailto:/i.test(href || '')) return <a href={href} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={12} /></a>;
      return <a href={`?${new URLSearchParams({ knowledge: selected })}`} onClick={event => { event.preventDefault(); if (href) void followLink(href); }}>{children}</a>;
    },
    img: ({ src, alt }) => <VaultImage key={`${selected}:${src}`} source={selected} src={typeof src === 'string' ? src : undefined} alt={alt} />,
    table: ({ children }) => <div className="kb-table-scroll"><table>{children}</table></div>,
  };
  const activeNote = note?.path === selected ? note : undefined;
  const searching = Boolean(query.trim());
  const shown = searching ? results : index?.notes;
  return <section className="kb" aria-label="知识库">
    <header className="kb-header">
      <div className="kb-heading"><BookOpen size={25} /><h2>知识库</h2><span>{index ? `${index.total} 篇笔记` : '你的 Obsidian 笔记'}</span></div>
      <div className="kb-actions"><button className="kb-mobile-directory" onClick={() => setDrawer(v => !v)} aria-expanded={drawer} aria-controls="kb-directory"><List size={18} />目录</button><button onClick={() => { setBusy(true); setReload(v => v + 1); }} disabled={busy} aria-label="刷新知识库"><ArrowClockwise size={18} /><span>{busy ? '读取中' : '刷新'}</span></button></div>
    </header>
    {error && <div className="kb-alert" role="alert">{error}<button onClick={() => setReload(v => v + 1)}>重试</button></div>}
    {index?.warnings.map(warning => <div className="kb-alert" key={warning}>{warning}</div>)}
    <div className="kb-layout">
      <aside id="kb-directory" className={`kb-sidebar ${drawer ? 'is-open' : ''}`} aria-label="笔记目录">
        <div className="kb-sidebar-heading"><strong>全部笔记</strong><button className="kb-close-directory" onClick={() => setDrawer(false)} aria-label="收起目录"><X size={18} /></button></div>
        <label className="kb-search"><MagnifyingGlass size={18} /><input ref={searchInput} type="search" value={query} onChange={event => { setQuery(event.target.value); setResults(undefined); }} placeholder="搜索标题或正文" aria-label="搜索知识库" maxLength={200} /></label>
        {searching ? <div className="kb-search-results" aria-live="polite">
          <p>{searchError || (shown ? `找到 ${shown.length} 篇笔记` : '正在搜索…')}</p>
          {shown?.map(item => <button key={item.path} onClick={() => openNote(item.path)} className={item.path === selected ? 'selected' : ''}><strong>{item.title}</strong><small>{item.path}</small><span>{item.excerpt}</span></button>)}
          {shown?.length === 0 && <p>换个关键词试试，也可以搜索笔记中的一句话。</p>}
        </div> : index ? <Directory branch={treeOf(index.notes)} selected={selected} onOpen={openNote} /> : <p className="kb-muted">{error ? '目录暂不可用' : '正在读取目录…'}</p>}
        <div className="kb-sidebar-foot">内容来自 Obsidian{index && <small>上次检查 {new Date(index.checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</small>}</div>
      </aside>
      <div className="kb-reading">
        {selected ? <>
          <div className="kb-reader-toolbar"><button onClick={() => openNote('')}><ArrowLeft size={17} />全部笔记</button><div className="kb-reader-actions"><button onClick={async () => { try { await navigator.clipboard.writeText(window.location.href); setCopied(true); } catch { setLinkError('未能复制，可直接复制浏览器地址'); } }} onBlur={() => setCopied(false)}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? '已复制' : '复制链接'}</button><button className="kb-ask" onPointerDown={event => event.preventDefault()} onClick={prepareReference} disabled={reading || !activeNote}><BookOpen size={17} />{selection.path === selected && selection.text ? '引用选中段落' : '拿这篇问助手'}</button></div></div>
          {linkError && <div className="kb-alert" role="alert">{linkError}<button onClick={() => setLinkError('')} aria-label="关闭提示"><X size={16} /></button></div>}
          {noteError ? <div className="kb-empty" role="alert"><FileText size={32} /><h3>这篇笔记暂时无法打开</h3><p>{noteError}</p><button onClick={() => setReload(v => v + 1)}>重新读取</button></div> : reading || !activeNote ? <div className="kb-skeleton" role="status" aria-label="正在打开笔记"><i /><i /><i /><i /></div> : <div className="kb-article-layout">
            <article ref={article} className="kb-article">
              <header className="kb-article-header"><p>{selected.split('/').slice(0, -1).join(' / ') || '全部笔记'}</p><h1 id={`kb-${slug(activeNote.title)}`}>{activeNote.title}</h1><div><time dateTime={activeNote.modifiedAt}>{date(activeNote.modifiedAt)}更新</time>{activeNote.tags.map(tag => <span key={tag}>#{tag.replace(/^#/, '')}</span>)}</div></header>
              <div className="kb-prose"><Markdown remarkPlugins={[remarkGfm, remarkKnowledge]} skipHtml urlTransform={url => /^kb-(note|image):/.test(url) ? url : defaultUrlTransform(url)} components={components}>{(activeNote.body || '').replace(/^#\s+([^\n]+)\r?\n/, (match, title: string) => title.trim() === activeNote.title ? '' : match) || '*这篇笔记还没有正文。*'}</Markdown></div>
            </article>
            {headings.length > 1 && <nav className="kb-outline" aria-label="文章目录"><strong>本篇目录</strong>{headings.map(heading => <a key={heading.id} href={`#${heading.id}`} className={heading.level > 2 ? 'nested' : ''}>{heading.label}</a>)}</nav>}
          </div>}
        </> : <div className="kb-home">
          <div className="kb-home-title"><h3>随时翻开，接着思考。</h3><p>从目录或搜索中，找到你想读的那一篇。</p></div>
          {busy && !index ? <div className="kb-skeleton" aria-label="正在读取知识库" role="status"><i /><i /><i /></div> : index?.total === 0 ? <div className="kb-empty"><BookOpen size={36} /><h3>这里还没有笔记</h3><p>在 Obsidian 中写下第一篇笔记，同步完成后就会出现在这里。</p></div> : index && <section className="kb-recent"><h4>最近更新</h4>{index.notes.slice(0, 12).map(item => <button key={item.path} onClick={() => openNote(item.path)}><FileText size={22} /><span><strong>{item.title}</strong><span>{item.excerpt || item.path}</span><small>{item.path}</small></span><time dateTime={item.modifiedAt}>{date(item.modifiedAt)}</time><CaretRight size={18} /></button>)}</section>}
        </div>}
      </div>
    </div>
    {referencePreview && <KnowledgeReferenceDialog reference={referencePreview} target={referenceTarget} replacing={replacingReference} onClose={() => setReferencePreview(undefined)} onConfirm={onReference} />}
  </section>;
}
