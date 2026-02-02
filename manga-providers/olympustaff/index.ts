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

        // Iterate over likely container elements first
        $("article, .item, .post-item, .box, .movie-item, .list-item, div[class*='item']").each((i: number, el: any) => {
             const titleEl = el.find("a").first()
             if (!titleEl.length) return
             
             const href = titleEl.attr("href")
             if (!href || !href.includes("/series/")) return

             // slug
             const slugMatch = href.match(/\/series\/([^/]+)/)
             if (!slugMatch) return
             const slug = slugMatch[1]
             if (resultsMap.has(slug)) return

             // Title
             let title = el.find("h3, h4, .title, .post-title").text().trim() || titleEl.text().trim()
             if (!title) return

             // Fuzzy filter
             const queryWords = query.toLowerCase().split(" ").filter(w => w.length > 2)
             const titleLower = title.toLowerCase()
             const match = queryWords.length === 0 || queryWords.some(w => titleLower.includes(w))
             if (!match) return;

             // Image
             const imgEl = el.find("img")
             let image = imgEl.attr("data-src")?.trim() || 
                           imgEl.attr("src")?.trim() || 
                           imgEl.attr("srcset")?.split(",")[0]?.split(" ")[0]?.trim() || 
                           ""
             
             if (image && !image.startsWith("http")) {
                 image = (this.api + image).replace(/([^:]\/)\/+/g, "$1")
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
            // Normalize spaces
            rawText = rawText.replace(/\s+/g, " ")

            // Patterns to ignore
            // 2023, 14 hours ago, 31,673 views, 31.673 
            const garbagePatterns = [
                /\d{4}/, // Year
                /(ago|min|hour|day|week|month|year)/i, // Time relative
                /[\d,.]+\s*(views|مشاهدة)/i, // View count with label
                /^\s*[\d,.]+\s*$/, // Just numbers
                /الفصل\s*\d+/ // "Chapter X" in Arabic (we add generic back later)
            ]

            // Heuristic strategies to find a real title
            // 1. Check if the text contains a real title separate from the chapter number
            let title = ""
            
            // Should usually correspond to the line that does NOT match garbage
            // But since we flattened newlines with Replace, we split by common separators if needed? 
            // Better: re-fetch text with newlines if possible? 
            // In Cheerio/HTML, typical newlines might be lost if we just .text() a block with <br> or divs.
            // Let's assume the site uses <span> or <div> for details.
            
            // Let's use the provided text but filter parts
            const parts = rawText.split(/[\n\t•]+/) // split by bullets or newlines if preserved
            
            for (const part of parts) {
                const p = part.trim()
                if (p.length < 2) continue
                
                let isGarbage = false
                for (const pattern of garbagePatterns) {
                    if (pattern.test(p)) {
                        isGarbage = true
                        break
                    }
                }
                
                if (!isGarbage && !p.includes(chapterNum)) {
                    title = p
                    break
                }
            }

            // Fallback: Default to "Chapter X"
            if (!title) {
                 title = `Chapter ${chapterNum}`
            } else {
                 // If we found a title, format it nice
                 title = `Chapter ${chapterNum} - ${title}`
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

        // Try reading content container first details
        let images = $(".chapter-content img, .reading-content img, .page-break img")
        
        // Fallback for some madara themes
        if (images.length === 0) {
            images = $("img[class*='wp-manga-chapter-img']")
        }

        images.each((i: number, el: any) => {
            let src = el.attr("data-src")?.trim() || 
                        el.attr("src")?.trim() ||
                        el.attr("data-lazy-src")?.trim()
            
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
