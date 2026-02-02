/// <reference path="../../typing/manga-provider.d.ts" />

class Provider {
    private api: string = "https://olympustaff.com"
    private userAgent: string = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"

    private async fetch(url: string, opts: RequestInit = {}): Promise<Response> {
        const resp = await fetch(url, {
            ...opts,
            headers: {
                "User-Agent": this.userAgent,
                "Referer": this.api + "/",
                ...opts.headers,
            }
        })
        return resp
    }

    async search({ query }: QueryOptions): Promise<SearchResult[]> {
        const url = `${this.api}/?s=${encodeURIComponent(query)}`
        const resp = await this.fetch(url)
        const html = await resp.text()
        const $ = LoadDoc(html)

        const resultsMap = new Map<string, SearchResult>()

        $("a").each((i: number, el: any) => {
            const href = el.attr("href")
            if (!href) return

            // Match /series/slug pattern
            const slugMatch = href.match(/\/series\/([^/]+)$/) || href.match(/\/series\/([^/]+)\/$/)
            if (!slugMatch) return
            const slug = slugMatch[1]

            // Avoid duplicates
            if (resultsMap.has(slug)) return

            // Start from the anchor and look for title/image
            let title = el.text().trim()
            if (!title) {
                 const titleEl = el.find("h3, h4, .title, .post-title")
                 if (titleEl.length() > 0) title = titleEl.text().trim()
            }
            if (!title) return // Skip if no title found

            // Simple fuzzy filter: only keep if title includes part of the query
            // Split query into words and check if at least one word is in the title
            const queryWords = query.toLowerCase().split(" ").filter(w => w.length > 2)
            const titleLower = title.toLowerCase()
            const match = queryWords.length === 0 || queryWords.some(w => titleLower.includes(w))
            
            if (!match) return;

            // Image: look inside or near the anchor
            let imgEl = el.find("img")
            if (imgEl.length() === 0) {
                imgEl = el.closest(".item, .post-item, .box, div").find("img")
            }

            let image = imgEl.attr("data-src")?.trim() || 
                          imgEl.attr("src")?.trim() ||
                          ""
            
            if (image && !image.startsWith("http")) {
                image = (this.api + image).replace(/([^:]\/)\/+/g, "$1") // fix double slashes except protocol
            }

            resultsMap.set(slug, {
                id: slug,
                title: title,
                image: image
            })
        })

        return Array.from(resultsMap.values())
    }

    async findChapters(mangaId: string): Promise<ChapterDetails[]> {
        const url = `${this.api}/series/${mangaId}`
        const resp = await this.fetch(url)
        const html = await resp.text()
        const $ = LoadDoc(html)

        const chapters: ChapterDetails[] = []
        const seenChapters = new Set<string>()

        $("a[href*='/series/" + mangaId + "/']").each((i: number, el: any) => {
            const href = el.attr("href")
            if (!href) return

            const chapterMatch = href.match(/\/series\/[^/]+\/(\d+)/)
            if (!chapterMatch) return
            const chapterNum = chapterMatch[1]

            if (seenChapters.has(chapterNum)) return
            seenChapters.add(chapterNum)

            // Clean up title: Remove date, views, and numbers
            let rawText = el.text().trim()
            const lines = rawText.split(/[\n\r]+/).map((l: string) => l.trim()).filter((l: string) => l.length > 0)
            
            let title = `Chapter ${chapterNum}`
            
            // Heuristic: Check lines for actual content that isn't just numbers or dates
            for (const line of lines) {
                const isDate = /\d+ (ago|min|hour|day|week|month|year)/i.test(line)
                const isViewCount = /^\d[\d,.]*$/.test(line) // e.g. "31,673" or "387"
                const isChapterNum = line.includes(chapterNum) || line.includes("الفصل")

                if (!isDate && !isViewCount && !isChapterNum) {
                     title = line
                     break 
                }
            }

            chapters.push({
                id: `${mangaId}$${chapterNum}`,
                url: href,
                title: title,
                chapter: chapterNum,
                index: 0
            })
        })

        // Sort by chapter number descending
        chapters.sort((a, b) => parseInt(b.chapter) - parseInt(a.chapter))
        chapters.forEach((chapter, index) => {
            chapter.index = index
        })

        return chapters
    }

    async findChapterPages(chapterId: string): Promise<ChapterPage[]> {
        const [mangaId, chapterNum] = chapterId.split("$")
        const url = `${this.api}/series/${mangaId}/${chapterNum}`
        const resp = await this.fetch(url)
        const html = await resp.text()
        const $ = LoadDoc(html)

        const pages: ChapterPage[] = []

        $(".chapter-content img, .reading-content img, .page-break img").each((i: number, el: any) => {
            let src = el.attr("data-src")?.trim() || 
                        el.attr("src")?.trim()
            
            if (src && !src.startsWith("http")) {
                src = (this.api + src).replace(/([^:]\/)\/+/g, "$1")
            }

            if (src && !src.includes("logo") && !src.includes("icon")) {
                pages.push({
                    url: src,
                    index: i,
                    headers: {
                        "Referer": this.api + "/"
                    }
                })
            }
        })

        return pages
    }

    getSettings(): Settings {
        return {
            supportsMultiLanguage: false,
            supportsMultiScanlator: false,
        }
    }
}
