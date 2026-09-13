"use client";
import { BookOpen, X } from '@phosphor-icons/react';
import { referenceHref, type KnowledgeReference } from './knowledge-reference';

export default function KnowledgeReferenceCard({ reference, onRemove, onPrompt }: { reference: KnowledgeReference; onRemove?: () => void; onPrompt?: (question: string) => void }) {
  return <section className="knowledge-reference-card" aria-label={onRemove ? '待发送的知识库引用' : '本次知识库引用'}>
    <div className="knowledge-reference-heading"><BookOpen size={18} /><div><strong>{reference.title}</strong><small>{reference.scope === 'selection' ? '选中段落' : '整篇笔记'} · {reference.content.length.toLocaleString('zh-CN')} 字符</small></div><a href={referenceHref(reference)} target="_blank" rel="noopener noreferrer">查看原文</a>{onRemove && <button type="button" onClick={onRemove} aria-label="移除知识库引用"><X size={17} /></button>}</div>
    <details><summary>查看引用内容</summary><p className="knowledge-reference-path">{reference.path}</p><pre>{reference.content}</pre><small>引用于 {new Date(reference.capturedAt).toLocaleString('zh-CN')}</small></details>
    {onPrompt && <div className="knowledge-reference-prompts"><button type="button" onClick={() => onPrompt('请总结这份笔记的核心观点，并标注原文来源。')}>总结要点</button><button type="button" onClick={() => onPrompt('请用直白的语言解释这份笔记，举例时说明哪些是你补充的。')}>解释一下</button><button type="button" onClick={() => onPrompt('请根据这份笔记，列出可以采取的具体行动，并标注依据。')}>提炼行动</button></div>}
  </section>;
}
