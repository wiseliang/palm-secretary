import GithubSlugger from 'github-slugger';
import { visit } from 'unist-util-visit';
import type { Root, Text, PhrasingContent } from 'mdast';

// Work on Markdown text nodes so code spans and fenced code remain untouched.
export function remarkKnowledge() {
  return (tree: Root) => {
    const slugger = new GithubSlugger();
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || index === undefined || parent.type === 'link' || parent.type === 'linkReference') return;
      const pattern = /(!?)\[\[([^\]\n]+)\]\]/g;
      const parts: PhrasingContent[] = []; let end = 0;
      for (const match of node.value.matchAll(pattern)) {
        if (match.index > end) parts.push({ type: 'text', value: node.value.slice(end, match.index) });
        const [target, ...labels] = match[2].split('|');
        const label = labels.join('|') || target;
        if (match[1] && /\.(png|jpe?g|gif|webp|avif)(?:#.*)?$/i.test(target)) {
          parts.push({ type: 'image', url: `kb-image:${encodeURIComponent(target)}`, alt: /^\d+(x\d+)?$/.test(label) ? target : label });
        } else {
          parts.push({ type: 'link', url: `kb-note:${encodeURIComponent(target)}`, children: [{ type: 'text', value: match[1] ? `查看嵌入内容：${label}` : label }] });
        }
        end = match.index + match[0].length;
      }
      if (!end) return;
      if (end < node.value.length) parts.push({ type: 'text', value: node.value.slice(end) });
      parent.children.splice(index, 1, ...parts as Text[]);
      return index + parts.length;
    });
    visit(tree, 'heading', node => {
      let text = '';
      visit(node, 'text', child => { text += child.value; });
      visit(node, 'inlineCode', child => { text += child.value; });
      node.data = { ...node.data, hProperties: { id: `kb-${slugger.slug(text)}` } };
    });
    visit(tree, 'blockquote', node => {
      const first = node.children[0];
      if (first?.type !== 'paragraph' || first.children[0]?.type !== 'text') return;
      const text = first.children[0];
      const callout = /^\[!([\w-]+)\][+-]?\s*/.exec(text.value);
      if (!callout) return;
      text.value = text.value.slice(callout[0].length) || ({ note: '笔记', tip: '提示', warning: '注意', info: '说明' }[callout[1].toLowerCase()] ?? callout[1]);
      node.data = { ...node.data, hProperties: { className: ['kb-callout'] } };
    });
  };
}
