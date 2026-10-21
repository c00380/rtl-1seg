import { messages } from '../messages.js';

const message = (key) => {
  const value = key.split('.').reduce((group, name) => group?.[name], messages);
  if (typeof value !== 'string') throw new Error(`Unknown static message: ${key}`);
  return value;
};

// Replace text markers with plain text nodes, preserving the existing element structure.
export function applyMessages(root = document) {
  const ownerDocument = root.ownerDocument ?? root;
  const walker = ownerDocument.createTreeWalker(root, 128); // NodeFilter.SHOW_COMMENT
  const replacements = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.data.startsWith('message:'))
      replacements.push([node, message(node.data.slice('message:'.length))]);
  }
  for (const [node, text] of replacements) node.replaceWith(ownerDocument.createTextNode(text));
  for (const element of root.querySelectorAll('[data-message]'))
    element.textContent = message(element.getAttribute('data-message'));
  for (const element of root.querySelectorAll(
    '[data-message-aria-label], [data-message-aria-valuetext], [data-message-data-tooltip]',
  )) {
    for (const { name, value } of [...element.attributes]) {
      if (name.startsWith('data-message-')) element.setAttribute(name.slice(13), message(value));
    }
  }
}
