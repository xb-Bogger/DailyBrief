import * as cheerio from "cheerio";
import type { RawArticle } from "./types";

type ListedPaper = {
  id: string;
  title: string;
  authors: string[];
  url: string;
};

type ApiPaper = {
  title?: string;
  summary?: string;
  publishedAt?: Date;
  authors: Array<{ name: string }>;
};

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; DailyBriefBot/1.0; +https://github.com/)",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function absUrl(path: string): string {
  return path.startsWith("http") ? path : `https://arxiv.org${path}`;
}

function inferSecurityArea(title: string, abstract: string | undefined): string {
  const text = `${title} ${abstract ?? ""}`.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/\b(protocol|ake|key exchange|cryptograph|encryption|signature|zero-knowledge|commitment|zkp|mpc|post-quantum|lattice)\b/, "密码学协议"],
    [/\b(software|program|static analysis|dynamic analysis|fuzz|vulnerab|patch|bug|code|binary|compiler|tamarin|threat model|threat modeling)\b/, "软件安全"],
    [/\b(llm|large language model|generative ai|artificial intelligence|machine learning|neural|deep learning|reinforcement learning|adversarial|prompt injection)\b/, "AI 安全"],
    [/\b(system|kernel|container|cloud|distributed|hardware|tee|trusted execution|firmware|side-channel|side channel|microarchitect)\b/, "系统安全"],
    [/\b(network|web|internet|dns|tls|traffic|routing|botnet|phishing|malware|intrusion)\b/, "网络安全"],
    [/\b(privacy|anonymous|anonymity|differential privacy|federated|data protection|tracking)\b/, "隐私保护"],
    [/\b(blockchain|smart contract|ethereum|bitcoin|defi|crypto asset|consensus)\b/, "区块链安全"],
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1] ?? "安全研究";
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`arXiv fetch failed ${res.status}: ${url}`);
  return res.text();
}

function parseFirstRecentBlock(html: string, limit: number): ListedPaper[] {
  const $ = cheerio.load(html);
  const firstDate = $("h3").first();
  const scope = firstDate.length ? firstDate.nextUntil("h3") : $("body").children();
  const entries: ListedPaper[] = [];

  scope.filter("dt").each((i, dt) => {
    if (i >= limit) return false;
    const dd = $(dt).next("dd");
    const abs = $(dt)
      .find('a[href^="/abs/"]')
      .first();
    const href = abs.attr("href") ?? "";
    const id = href.replace(/^\/abs\//, "").trim();
    if (!id || dd.length === 0) return;

    const title = normalizeText(
      dd.find(".list-title").first().text().replace(/^Title:\s*/i, ""),
    );
    const authors = dd
      .find(".list-authors a")
      .map((_, a) => normalizeText($(a).text()))
      .get()
      .filter(Boolean);

    if (title) {
      entries.push({
        id,
        title,
        authors,
        url: absUrl(href),
      });
    }
  });

  return entries.slice(0, limit);
}

function parseApiXml(xml: string): Map<string, ApiPaper> {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out = new Map<string, ApiPaper>();

  $("entry").each((_, entry) => {
    const idUrl = normalizeText($(entry).find("id").first().text());
    const id = idUrl.split("/abs/")[1]?.trim().replace(/v\d+$/, "");
    if (!id) return;

    const authors: Array<{ name: string }> = [];
    $(entry)
      .find("author")
      .each((_, author) => {
        const name = normalizeText($(author).find("name").first().text());
        if (!name) return;
        authors.push({ name });
      });

    const published = normalizeText($(entry).find("published").first().text());
    out.set(id, {
      title: normalizeText($(entry).find("title").first().text()),
      summary: normalizeText($(entry).find("summary").first().text()),
      publishedAt: published ? new Date(published) : undefined,
      authors,
    });
  });

  return out;
}

async function fetchApiDetails(ids: string[]): Promise<Map<string, ApiPaper>> {
  if (ids.length === 0) return new Map();
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(ids.join(","))}`;
  try {
    return parseApiXml(await fetchText(url));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[arxiv] API details unavailable, falling back to abs pages: ${msg}`);
    return new Map();
  }
}

async function fetchAbsPageDetails(url: string): Promise<ApiPaper | undefined> {
  try {
    const $ = cheerio.load(await fetchText(url));
    const title = normalizeText(
      $("h1.title").first().text().replace(/^Title:\s*/i, ""),
    );
    const summary = normalizeText(
      $("blockquote.abstract").first().text().replace(/^Abstract:\s*/i, ""),
    );
    const authors = $(".authors a")
      .map((_, a) => normalizeText($(a).text()))
      .get()
      .filter(Boolean)
      .map((name) => ({ name }));
    return { title, summary, authors };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[arxiv] abs page unavailable for ${url}: ${msg}`);
    return undefined;
  }
}

export async function fetchArxivRecent(
  sourceId: string,
  listUrl: string,
  limit = Number.POSITIVE_INFINITY,
): Promise<RawArticle[]> {
  const listed = parseFirstRecentBlock(await fetchText(listUrl), limit);
  const details = await fetchApiDetails(listed.map((p) => p.id));
  for (const p of listed) {
    if (details.has(p.id)) continue;
    const detail = await fetchAbsPageDetails(p.url);
    if (detail) details.set(p.id, detail);
  }

  return listed.map((p) => {
    const api = details.get(p.id);
    const firstAuthor = api?.authors[0] ?? (p.authors[0] ? { name: p.authors[0] } : undefined);
    const title = api?.title || p.title;
    const excerpt = api?.summary?.slice(0, 900);
    const area = inferSecurityArea(title, excerpt);
    const authorLabel = firstAuthor
      ? `第一作者: ${firstAuthor.name} · 方向: ${area}`
      : `方向: ${area}`;

    return {
      sourceId,
      title,
      url: p.url,
      excerpt,
      publishedAt: api?.publishedAt,
      category: "papers",
      meta: authorLabel,
    };
  });
}
