import { FunctionTool } from "./tool";

const FETCH_TIMEOUT_MS = 8000;
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// ---------------------------------------------------------------------------
// Brave Search API
// ---------------------------------------------------------------------------

interface BraveResult {
  url: string;
  title: string;
  description: string;
}

async function searchBrave(query: string): Promise<BraveResult[]> {
  const apiKey = process.env["BRAVE_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "BRAVE_API_KEY is not set. Add it to your .env file (free at api.search.brave.com).",
    );
  }
  const response = await fetchWithTimeout(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=3`,
    {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    },
  );
  const data = (await response.json()) as { web?: { results?: BraveResult[] } };
  return data.web?.results?.slice(0, 3) ?? [];
}

// ---------------------------------------------------------------------------
// RSS feed support
// ---------------------------------------------------------------------------

function parseRss(xml: string): string {
  const items: string[] = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null && items.length < 10) {
    const block = match[1];
    const title =
      /<title><!\[CDATA\[([^\]]+)\]\]><\/title>/i.exec(block)?.[1] ??
      /<title>([^<]+)<\/title>/i.exec(block)?.[1] ?? "";
    const link = /<link>([^<]+)<\/link>/i.exec(block)?.[1] ?? "";
    const desc =
      /<description><!\[CDATA\[([^\]]+)\]\]><\/description>/i.exec(block)?.[1] ??
      /<description>([^<]+)<\/description>/i.exec(block)?.[1] ?? "";
    if (title) {
      items.push(`- ${title.trim()}${link ? `\n  ${link.trim()}` : ""}${desc ? `\n  ${desc.replace(/<[^>]+>/g, "").trim().slice(0, 200)}` : ""}`);
    }
  }
  return items.join("\n\n");
}

async function tryFetchRss(baseUrl: string): Promise<string | null> {
  const parsed = new URL(baseUrl);
  const candidates = [
    `${parsed.origin}/rss.xml`,
    `${parsed.origin}/feed`,
    `${parsed.origin}/news/rss.xml`,
    `${parsed.origin}/feeds/posts/default`,
  ];
  for (const rssUrl of candidates) {
    try {
      const res = await fetchWithTimeout(rssUrl, { headers: BROWSER_HEADERS });
      if (!res.ok) continue;
      const text = await res.text();
      if (!text.includes("<rss") && !text.includes("<feed")) continue;
      const items = parseRss(text);
      if (!items) continue;
      return `RSS feed from ${rssUrl}:\n\n${items}`;
    } catch {
      // try next
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTML page content extraction
// ---------------------------------------------------------------------------

async function fetchPageContent(url: string): Promise<string> {
  const response = await fetchWithTimeout(url, { headers: BROWSER_HEADERS });
  const html = await response.text();

  // Extract JSON-LD structured data for content-rich metadata
  const jsonLdMatches = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  const jsonLdTexts: string[] = [];
  for (const m of jsonLdMatches) {
    try {
      const obj = JSON.parse(m[1]) as Record<string, unknown>;
      const text = obj["articleBody"] ?? obj["description"] ?? obj["text"];
      if (typeof text === "string" && text.length > 100) jsonLdTexts.push(text.slice(0, 3000));
    } catch {
      // ignore malformed JSON-LD
    }
  }
  if (jsonLdTexts.length > 0) return jsonLdTexts.join("\n\n");

  // Prefer <main> or <article> for content-dense extraction; fall back to full body
  const mainMatch =
    /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html) ??
    /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html);
  const source = mainMatch ? mainMatch[1] : html;

  const cleaned = source
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.length > 6000 ? cleaned.slice(0, 6000) + "\n\n[content truncated]" : cleaned;
}

// ---------------------------------------------------------------------------
// Search entry point
// ---------------------------------------------------------------------------

async function search(query: string): Promise<string> {
  let results: BraveResult[];
  try {
    results = await searchBrave(query);
  } catch (err) {
    return `Search unavailable: ${(err as Error).message}`;
  }

  if (results.length === 0) {
    return `No results found for "${query}". Try different search terms.`;
  }

  // Fetch all result pages in parallel; fall back to Brave's description on failure
  const fetched = await Promise.all(
    results.map(async (r) => {
      // Try RSS first for likely news/blog homepages
      const isHomepage = new URL(r.url).pathname.length <= 1;
      if (isHomepage) {
        const rss = await tryFetchRss(r.url).catch(() => null);
        if (rss) return { ...r, content: rss };
      }
      const content = await fetchPageContent(r.url).catch(() => null);
      // If page content is too sparse (JS-rendered shell), fall back to description
      const useful = content && content.length > 200 ? content : null;
      return { ...r, content: useful ?? `(page requires JavaScript — description only)\n${r.description}` };
    }),
  );

  const parts: string[] = [`Search results for "${query}":\n`];
  for (const r of fetched) {
    parts.push(`## ${r.title}`);
    parts.push(`URL: ${r.url}`);
    parts.push(`\n${r.content}\n`);
  }

  return parts.join("\n");
}

function isUrl(input: string): boolean {
  try {
    new URL(input);
    return true;
  } catch {
    return false;
  }
}

async function fetchUrl(url: string): Promise<string> {
  // For RSS/Atom feeds, parse as RSS
  if (url.endsWith(".xml") || url.includes("/rss") || url.includes("/feed")) {
    const res = await fetchWithTimeout(url, { headers: BROWSER_HEADERS });
    const text = await res.text();
    if (text.includes("<rss") || text.includes("<feed")) {
      const items = parseRss(text);
      return items || "No items found in feed.";
    }
  }
  // Try RSS discovery for homepages
  try {
    const parsed = new URL(url);
    if (parsed.pathname.length <= 1) {
      const rss = await tryFetchRss(url);
      if (rss) return rss;
    }
  } catch {
    // not a valid URL, fall through
  }
  return fetchPageContent(url);
}

export const webSearchTool = new FunctionTool(
  (params: Record<string, unknown>): Promise<string> => {
    const input = (params.input as string).trim();
    return isUrl(input) ? fetchUrl(input) : search(input);
  },
  "web_search",
  "Search the web or fetch page content. Pass a search query to get top results with page content fetched automatically. Pass a URL to read a specific page or RSS feed. Requires BRAVE_API_KEY in environment for search queries.",
  {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "A search query string or a URL to fetch.",
      },
    },
    required: ["input"],
  },
);
