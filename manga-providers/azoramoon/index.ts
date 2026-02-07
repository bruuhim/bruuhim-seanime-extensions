/// <reference path="../../typing/manga-provider.d.ts" />

class Provider {
  private api: string = "https://azoramoon.com";
  private userAgent: string =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

  private async fetch(url: string, opts: RequestInit = {}): Promise<Response> {
    try {
      const resp = await fetch(url, {
        ...opts,
        headers: {
          "User-Agent": this.userAgent,
          Referer: this.api + "/",
          ...opts.headers,
        },
      });
      return resp;
    } catch (e) {
      throw e;
    }
  }

  async search({ query }: QueryOptions): Promise<SearchResult[]> {
    try {
      const url = `${this.api}/series?searchTerm=${encodeURIComponent(query)}`;
      const resp = await this.fetch(url);
      const html = await resp.text();
      const $ = LoadDoc(html);

      const resultsMap = new Map<string, SearchResult>();

      // Find all links that point to a series
      $("a[href^='/series/']").each((i: number, el: any) => {
        const href = el.attr("href");
        if (!href) return;

        // Extract slug
        const parts = href.split("/");
        const slug = parts[2]; // /series/slug
        if (!slug || resultsMap.has(slug)) return;

        // Find title and image
        let title = "";
        let image = "";

        const imgEl = el.find("img");
        if (imgEl.length > 0) {
          image = imgEl.attr("src") || imgEl.attr("data-src") || "";
          title = imgEl.attr("alt") || "";
          // Clean up title from "Cover of " prefix if exists
          title = title.replace(/^Cover of\s+/i, "");
        }

        if (!title) {
          title = el.text().trim();
        }

        if (!title) return;

        resultsMap.set(slug, {
          id: slug,
          title: title,
          image: image,
        });
      });

      return Array.from(resultsMap.values());
    } catch (e) {
      console.error("AzoraMoon search error:", e);
      return [];
    }
  }

  async findChapters(mangaId: string): Promise<ChapterDetails[]> {
    try {
      const url = `${this.api}/series/${mangaId}`;
      const resp = await this.fetch(url);
      const html = await resp.text();
      const $ = LoadDoc(html);

      const chapters: ChapterDetails[] = [];
      const seenChapters = new Set<string>();

      // Select all chapter links
      $("a[href*='/chapter-']").each((i: number, el: any) => {
        const href = el.attr("href");
        if (!href) return;

        // URL format: /series/slug/chapter-number
        // or sometimes /chapter-slug-number
        // Based on research, it's inside the series page.
        const slugParts = href.split("/");
        const chapterSlug = slugParts[slugParts.length - 1];

        if (seenChapters.has(chapterSlug)) return;
        seenChapters.add(chapterSlug);

        const chapterNumMatch = chapterSlug.match(/chapter-(\d+(\.\d+)?)/i);
        const chapterNum = chapterNumMatch ? chapterNumMatch[1] : "0";

        let title = el.text().trim();
        if (!title) {
          title = `Chapter ${chapterNum}`;
        }

        chapters.push({
          id: `${mangaId}$${chapterSlug}`,
          url: href,
          title: title,
          chapter: chapterNum,
          index: 0,
        });
      });

      // Sort chapters by number descending
      chapters.sort((a, b) => parseFloat(b.chapter) - parseFloat(a.chapter));
      chapters.forEach((chapter, index) => {
        chapter.index = index;
      });

      return chapters;
    } catch (e) {
      console.error("AzoraMoon findChapters error:", e);
      return [];
    }
  }

  async findChapterPages(chapterId: string): Promise<ChapterPage[]> {
    try {
      const [mangaId, chapterSlug] = chapterId.split("$");
      const url = `${this.api}/series/${mangaId}/${chapterSlug}`;
      const resp = await this.fetch(url);
      const html = await resp.text();
      const $ = LoadDoc(html);

      const pages: ChapterPage[] = [];

      // Selector from research: .comic-images-wrapper img
      const images = $(".comic-images-wrapper img");

      images.each((i: number, el: any) => {
        let src =
          el.attr("src") || el.attr("data-src") || el.attr("data-lazy-src");
        if (src) {
          src = src.trim();
          if (!src.startsWith("http")) {
            src = (this.api + (src.startsWith("/") ? "" : "/") + src).replace(
              /([^:]\/)\/+/g,
              "$1",
            );
          }

          pages.push({
            url: src,
            index: i,
            headers: {
              Referer: this.api + "/",
            },
          });
        }
      });

      return pages;
    } catch (e) {
      console.error("AzoraMoon findChapterPages error:", e);
      return [];
    }
  }

  getSettings(): Settings {
    return {
      supportsMultiLanguage: false,
      supportsMultiScanlator: false,
    };
  }
}
