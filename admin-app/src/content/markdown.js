import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
});

export function renderMarkdown(source) {
  const rendered = markdown.render(source);
  return sanitizeHtml(rendered, {
    allowedTags: ['p', 'strong', 'em', 'ul', 'ol', 'li', 'h2', 'h3', 'blockquote', 'a', 'code', 'pre', 'br'],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
    },
    allowedSchemes: ['https'],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tagName, attributes) => ({
        tagName: 'a',
        attribs: {
          ...attributes,
          target: '_blank',
          rel: 'noreferrer noopener',
        },
      }),
    },
  });
}

export function assertWeeklyDigestMarkdown(source) {
  const tokens = markdown.parse(source, {});
  const isOneTopLevelOrderedList = tokens.length >= 2
    && tokens[0].type === 'ordered_list_open'
    && tokens[0].level === 0
    && tokens.at(-1).type === 'ordered_list_close'
    && tokens.at(-1).level === 0
    && tokens.slice(1, -1).every((token) => token.level > 0);
  const itemCount = tokens.filter(
    (token) => token.type === 'list_item_open' && token.level === 1,
  ).length;
  const meaningfulItemCount = countMeaningfulTopLevelItems(tokens);
  if (!isOneTopLevelOrderedList
      || itemCount < 3
      || itemCount > 5
      || meaningfulItemCount !== itemCount) {
    throw new TypeError('bodyMarkdown must contain one ordered list with 3–5 editorial items');
  }
}

function countMeaningfulTopLevelItems(tokens) {
  let insideTopLevelItem = false;
  let currentItemIsMeaningful = false;
  let meaningfulItems = 0;
  for (const token of tokens) {
    if (token.type === 'list_item_open' && token.level === 1) {
      insideTopLevelItem = true;
      currentItemIsMeaningful = false;
    } else if (token.type === 'list_item_close' && token.level === 1) {
      if (currentItemIsMeaningful) meaningfulItems += 1;
      insideTopLevelItem = false;
    } else if (insideTopLevelItem && token.type === 'inline') {
      currentItemIsMeaningful ||= token.children?.some(
        (child) => ['text', 'code_inline'].includes(child.type) && child.content.trim() !== '',
      ) ?? false;
    }
  }
  return meaningfulItems;
}
