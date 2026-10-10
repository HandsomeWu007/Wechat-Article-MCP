import TurndownService from 'turndown';
import * as cheerio from 'cheerio';

let gfmPlugin: any | undefined;
async function loadGfm(): Promise<any | undefined> {
  if (gfmPlugin !== undefined) return gfmPlugin;
  try {
    const mod: any = await import('turndown-plugin-gfm');
    gfmPlugin = mod?.gfm ?? mod?.default ?? mod;
  } catch {
    gfmPlugin = null;
  }
  return gfmPlugin ?? undefined;
}

export interface ToMarkdownOptions {
  /** 图片链接重写函数，用于把远程图片替换为本地路径 */
  rewriteImage?: (src: string) => string;
  /** 是否丢弃图片 */
  dropImages?: boolean;
}

/** 微信正文 HTML 预处理：懒加载图片、清理脚本、处理特殊组件 */
export function preprocessHtml(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, .qr_code_pc_outer, #js_pc_qr_code').remove();

  $('img').each((_, el) => {
    const img = $(el);
    const src = img.attr('data-src') || img.attr('data-original') || img.attr('src') || '';
    if (src) img.attr('src', src.startsWith('//') ? `https:${src}` : src);
    img.removeAttr('data-src data-original data-croporisrc data-ratio data-w data-type data-s');
  });

  // 语音 / 视频组件降级为占位文本
  $('mpvoice').each((_, el) => {
    $(el).replaceWith(`[语音：${$(el).attr('name') || '音频'}]`);
  });
  $('iframe').each((_, el) => {
    const src = $(el).attr('data-src') || $(el).attr('src') || '';
    $(el).replaceWith(src ? `[视频/嵌入内容：${src}]` : '[嵌入内容]');
  });
  $('mp-common-mpaudio, mpaudio').each((_, el) => {
    $(el).replaceWith('[音频]');
  });

  // 微信正文大量使用 section 包裹，去掉空的 section 减少噪音由 turndown 自然处理
  return $.html();
}

export async function htmlToMarkdown(html: string, opts: ToMarkdownOptions = {}): Promise<string> {
  const clean = preprocessHtml(html);
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });

  const gfm = await loadGfm();
  if (gfm) td.use(gfm);

  td.remove(['script', 'style']);

  if (opts.dropImages) {
    td.remove('img');
  } else if (opts.rewriteImage) {
    td.addRule('imageRewrite', {
      filter: 'img',
      replacement: (_content, node) => {
        const el = node as HTMLElement;
        const src = el.getAttribute('src') || '';
        const alt = el.getAttribute('alt') || '';
        if (!src) return '';
        return `![${alt}](${opts.rewriteImage!(src)})`;
      },
    });
  }

  let md = td.turndown(clean);
  md = md
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return md;
}

/** Markdown → 纯文本（去标记，保留段落结构） */
export function markdownToText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '- ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`{1,3}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
