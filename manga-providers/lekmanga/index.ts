/// <reference path="../typing/manga-provider.d.ts" />

class Provider {
  private api: string = "https://lekmanga.net";
  // Using a mobile User-Agent sometimes helps bypass Cloudflare
  private userAgent: string =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

  private async fetch(url: string, opts: RequestInit = {}): Promise<Response> {
    console.log(`[LekManga] Fetching: ${url}`);
    try {
      const resp = await fetch(url, {
        ...opts,
        headers: {
          "User-Agent": this.userAgent,
          Referer: this.api + "/",
          "X-Requested-With": "XMLHttpRequest",
          ...opts.headers,
        },
      });
      console.log(`[LekManga] Status: ${resp.status}`);
      return resp;
    } catch (e) {
      console.error(`[LekManga] Fetch Error:`, e);
      throw e;
    }
  }

  // Search for manga based on a query. Returns a list of search results.
  async search({ query }: QueryOptions): Promise<SearchResult[]> {
    console.log(`[LekManga] Searching for: ${query}`);
    const url = `${this.api}/?s=${encodeURIComponent(query)}&post_type=wp-manga`;
    const resp = await this.fetch(url);
    const html = await resp.text();
    console.log(`[LekManga] HTML Length: ${html.length}`);
    const $ = LoadDoc(html);

    const resultsMap = new Map<string, SearchResult>();

    $(
      ".c-tabs-item__content, .tab-content-wrap, .c-tabs-item, .row.c-tabs-item__content",
    ).each((i: number, el: any) => {
      const titleAnchor = el
        .find(".post-title h3 a, .post-title h4 a, .post-title a")
        .first();
      if (titleAnchor.length() === 0) return;

      const title = titleAnchor.text().trim();
      const href = titleAnchor.attr("href");
      if (!href) return;

      const slugMatch = href.match(/\/manga\/([^/]+)\//);
      if (!slugMatch) return;
      const slug = slugMatch[1];

      // Avoid duplicates
      if (resultsMap.has(slug)) return;

      const imgEl = el.find("img");
      const image =
        imgEl.attr("data-src")?.trim() ||
        imgEl.attr("data-lazy-src")?.trim() ||
        imgEl.attr("src")?.trim();

      resultsMap.set(slug, {
        id: slug,
        title: title,
        image: image,
      });
    });

    console.log(`[LekManga] Found ${resultsMap.size} results`);
    return Array.from(resultsMap.values());
  }

  // Returns the chapters based on the manga ID (slug).
  async findChapters(mangaId: string): Promise<ChapterDetails[]> {
    console.log(`[LekManga] Finding chapters for: ${mangaId}`);
    const mangaUrl = `${this.api}/manga/${mangaId}/`;
    const resp = await this.fetch(mangaUrl);
    const html = await resp.text();
    let $ = LoadDoc(html);

    let chapters: ChapterDetails[] = [];

    // 1. Try SSR Chapters
    chapters = this.parseChapters($, mangaId);
    console.log(`[LekManga] SSR Count: ${chapters.length}`);

    // 2. AJAX Fallback
    if (chapters.length === 0) {
      console.log(`[LekManga] SSR failed, checking for Post ID...`);
      const postIdMatch =
        html.match(/postid-(\d+)/) || html.match(/data-id="(\d+)"/);
      if (postIdMatch) {
        const postId = postIdMatch[1];
        console.log(`[LekManga] Found Post ID: ${postId}`);

        // Try standard AJAX first
        const ajaxUrl = `${this.api}/wp-admin/admin-ajax.php`;
        console.log(`[LekManga] Trying standard AJAX: ${ajaxUrl}`);
        const ajaxResp = await this.fetch(ajaxUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `action=manga_get_chapters&manga=${postId}`,
        });
        const ajaxHtml = await ajaxResp.text();
        console.log(`[LekManga] Standard AJAX HTML Length: ${ajaxHtml.length}`);

        if (ajaxHtml.length > 5 && ajaxHtml !== "0") {
          const $ajax = LoadDoc(ajaxHtml);
          chapters = this.parseChapters($ajax, mangaId);
        } else {
          console.log(
            `[LekManga] Standard AJAX failed (returned 0 or empty), trying Direct AJAX...`,
          );
          // Try direct AJAX URL fallback
          const directAjaxUrl = `${this.api}/manga/${mangaId}/ajax/chapters/`;
          const directResp = await this.fetch(directAjaxUrl, {
            method: "POST",
          });
          const directHtml = await directResp.text();
          console.log(
            `[LekManga] Direct AJAX HTML Length: ${directHtml.length}`,
          );
          const $direct = LoadDoc(directHtml);
          chapters = this.parseChapters($direct, mangaId);
        }
      } else {
        console.log(`[LekManga] No Post ID found in HTML`);
      }
    }

    // Final sorting
    chapters.reverse();
    chapters.forEach((chapter, index) => {
      chapter.index = index;
    });

    console.log(`[LekManga] Returning ${chapters.length} chapters`);
    return chapters;
  }

  private parseChapters($: any, mangaId: string): ChapterDetails[] {
    const chapters: ChapterDetails[] = [];
    $(".wp-manga-chapter, .chapter-li, .listing-chapters_wrap li").each(
      (i: number, el: any) => {
        const a = el.find("a").first();
        const href = a.attr("href");
        if (!href) return;

        if (!href.includes(mangaId)) return;

        const slugMatch = href.match(/\/manga\/[^/]+\/([^/]+)\//);
        if (!slugMatch) return;
        const chapterSlug = slugMatch[1];
        const title = a.text().trim() || chapterSlug;

        chapters.push({
          id: `${mangaId}$${chapterSlug}`,
          url: href,
          title: title,
          chapter: chapterSlug,
          index: 0,
        });
      },
    );
    return chapters;
  }

  // Returns the chapter pages based on the chapter ID.
  async findChapterPages(chapterId: string): Promise<ChapterPage[]> {
    console.log(`[LekManga] Finding pages for chapter: ${chapterId}`);
    const [mangaId, chapterSlug] = chapterId.split("$");
    const url = `${this.api}/manga/${mangaId}/${chapterSlug}/`;
    const resp = await this.fetch(url);
    const html = await resp.text();
    const $ = LoadDoc(html);

    const pages: ChapterPage[] = [];

    $(".wp-manga-chapter-img").each((i: number, el: any) => {
      const src =
        el.attr("data-src")?.trim() ||
        el.attr("data-lazy-src")?.trim() ||
        el.attr("src")?.trim();
      if (src) {
        pages.push({
          url: src,
          index: i,
          headers: {
            Referer: this.api + "/",
          },
        });
      }
    });

    console.log(`[LekManga] Found ${pages.length} pages`);
    return pages;
  }

  getSettings(): Settings {
    return {
      supportsMultiLanguage: false,
      supportsMultiScanlator: false,
    };
  }
}
