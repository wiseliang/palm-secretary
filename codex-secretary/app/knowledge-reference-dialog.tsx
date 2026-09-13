"use client";
import { useEffect, useRef, useState } from 'react';
import { X } from '@phosphor-icons/react';
import type { KnowledgeReference } from './knowledge-reference';
import KnowledgeReferenceCard from './knowledge-reference-card';

export default function KnowledgeReferenceDialog({ reference, target, replacing, onClose, onConfirm }: { reference: KnowledgeReference; target: string; replacing: boolean; onClose: () => void; onConfirm: (reference: KnowledgeReference) => string | undefined }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState('');
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="knowledge-reference-dialog" aria-labelledby="reference-dialog-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="knowledge-reference-dialog-body"><header><div><h2 id="reference-dialog-title">拿这篇问助手</h2><p>带入{target}，填写问题后再发送。</p></div><button type="button" onClick={onClose} aria-label="关闭引用预览"><X size={20} /></button></header>
      <KnowledgeReferenceCard reference={reference} />
      {replacing && <p className="knowledge-reference-hint">输入框中已有的知识库引用会被替换，问题和附件会保留。</p>}
      {error && <p role="alert" className="knowledge-reference-hint">{error}</p>}
      <footer><button type="button" onClick={onClose}>取消</button><button type="button" className="primary" onClick={() => { const message = onConfirm(reference); if (message) setError(message); else onClose(); }}>带入对话</button></footer>
    </div>
  </dialog>;
}
