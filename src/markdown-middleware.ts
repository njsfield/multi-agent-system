import { BaseMiddleware, MiddlewareContext } from './middleware';
import { ChatCompletionResult } from './types';

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const R = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const ITALIC = '\x1b[3m';
const UNDERLINE = '\x1b[4m';
const STRIKETHROUGH = '\x1b[9m';

const FG_CYAN = '\x1b[36m';
const FG_YELLOW = '\x1b[33m';
const FG_GREEN = '\x1b[32m';
const FG_MAGENTA = '\x1b[35m';
const FG_BLUE = '\x1b[34m';
const BG_BLACK = '\x1b[40m';

// ---------------------------------------------------------------------------
// Detection — is this content likely markdown?
// ---------------------------------------------------------------------------

function looksLikeMarkdown(text: string): boolean {
  return (
    /^#{1,6}\s/m.test(text) ||           // ATX headings
    /^\s*[-*+]\s/m.test(text) ||         // unordered list
    /^\s*\d+\.\s/m.test(text) ||         // ordered list
    /`[^`]+`/.test(text) ||             // inline code
    /^```/m.test(text) ||               // fenced code block
    /\*\*[^*]+\*\*/.test(text) ||       // bold
    /^>\s/m.test(text)                   // blockquote
  );
}

// ---------------------------------------------------------------------------
// Renderer — markdown → ANSI terminal output
// ---------------------------------------------------------------------------

function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines: string[] = [];
  let listDepth = 0;

  const flushCode = () => {
    const header = codeLang ? `${DIM}${FG_CYAN}── ${codeLang} ${'─'.repeat(Math.max(0, 44 - codeLang.length))}${R}` : `${DIM}${'─'.repeat(48)}${R}`;
    out.push(header);
    for (const cl of codeLines) {
      out.push(`${BG_BLACK}${FG_GREEN}  ${cl}${R}`);
    }
    out.push(`${DIM}${'─'.repeat(48)}${R}`);
    codeLines = [];
    codeLang = '';
  };

  for (const raw of lines) {
    // --- fenced code block ---
    const fenceMatch = raw.match(/^```(\w*)/);
    if (fenceMatch) {
      if (inCodeBlock) {
        flushCode();
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeLang = fenceMatch[1] ?? '';
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(raw);
      continue;
    }

    let line = raw;

    // --- ATX headings ---
    const h6 = line.match(/^######\s+(.*)/);
    const h5 = line.match(/^#####\s+(.*)/);
    const h4 = line.match(/^####\s+(.*)/);
    const h3 = line.match(/^###\s+(.*)/);
    const h2 = line.match(/^##\s+(.*)/);
    const h1 = line.match(/^#\s+(.*)/);

    if (h1) { out.push(`\n${BOLD}${FG_YELLOW}${'═'.repeat(48)}${R}\n${BOLD}${FG_YELLOW}  ${h1[1]}${R}\n${BOLD}${FG_YELLOW}${'═'.repeat(48)}${R}`); continue; }
    if (h2) { out.push(`\n${BOLD}${FG_BLUE}  ${h2[1]}${R}\n${BOLD}${FG_BLUE}  ${'─'.repeat(44)}${R}`); continue; }
    if (h3) { out.push(`\n${BOLD}${FG_MAGENTA}  ${h3[1]}${R}`); continue; }
    if (h4) { out.push(`${BOLD}${UNDERLINE}  ${h4[1]}${R}`); continue; }
    if (h5) { out.push(`${BOLD}  ${h5[1]}${R}`); continue; }
    if (h6) { out.push(`${DIM}${ITALIC}  ${h6[1]}${R}`); continue; }

    // --- horizontal rule ---
    if (/^[-*_]{3,}$/.test(line.trim())) {
      out.push(`${DIM}${'─'.repeat(48)}${R}`);
      continue;
    }

    // --- blockquote ---
    const bq = line.match(/^>\s?(.*)/);
    if (bq) {
      out.push(`${FG_CYAN}${DIM}│${R}${ITALIC} ${bq[1]}${R}`);
      continue;
    }

    // --- unordered list ---
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)/);
    if (ulMatch) {
      const indent = Math.floor((ulMatch[1]?.length ?? 0) / 2);
      const bullet = indent > 0 ? `${DIM}◦${R}` : `${FG_YELLOW}•${R}`;
      line = `${'  '.repeat(indent + 1)}${bullet} ${inlineFormat(ulMatch[2] ?? '')}`;
      out.push(line);
      continue;
    }

    // --- ordered list ---
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/);
    if (olMatch) {
      const indent = Math.floor((olMatch[1]?.length ?? 0) / 2);
      line = `${'  '.repeat(indent + 1)}${FG_YELLOW}${olMatch[2]}.${R} ${inlineFormat(olMatch[3] ?? '')}`;
      out.push(line);
      continue;
    }

    // --- blank line ---
    if (!line.trim()) {
      out.push('');
      continue;
    }

    // --- normal paragraph line ---
    out.push(inlineFormat(line));
  }

  // flush unclosed code block
  if (inCodeBlock && codeLines.length) flushCode();

  return out.join('\n');
}

// Apply inline formatting: bold, italic, inline code, strikethrough, links
function inlineFormat(text: string): string {
  return text
    // inline code (process before other patterns to avoid double-formatting)
    .replace(/`([^`]+)`/g, `${BG_BLACK}${FG_GREEN}$1${R}`)
    // bold+italic
    .replace(/\*\*\*(.+?)\*\*\*/g, `${BOLD}${ITALIC}$1${R}`)
    .replace(/___(.+?)___/g, `${BOLD}${ITALIC}$1${R}`)
    // bold
    .replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${R}`)
    .replace(/__(.+?)__/g, `${BOLD}$1${R}`)
    // italic
    .replace(/\*(.+?)\*/g, `${ITALIC}$1${R}`)
    .replace(/_([^_]+)_/g, `${ITALIC}$1${R}`)
    // strikethrough
    .replace(/~~(.+?)~~/g, `${STRIKETHROUGH}$1${R}`)
    // links — show text, dim the URL
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${UNDERLINE}$1${R}${DIM} ($2)${R}`);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export class MarkdownMiddleware extends BaseMiddleware {
  async processResponse(context: MiddlewareContext, result: unknown): Promise<unknown> {
    if (!this.isChatCompletionResult(result)) return result;

    const cr = result as ChatCompletionResult;
    const content = cr.message.content;

    if (!content || !looksLikeMarkdown(content)) return result;

    // Replace raw markdown with ANSI-rendered content so printMessage
    // displays it correctly without a separate console.log.
    return {
      ...cr,
      message: {
        ...cr.message,
        content: renderMarkdown(content),
      },
    };
  }

  private isChatCompletionResult(value: unknown): value is ChatCompletionResult {
    return (
      typeof value === 'object' &&
      value !== null &&
      'message' in value &&
      'finishReason' in value
    );
  }
}
