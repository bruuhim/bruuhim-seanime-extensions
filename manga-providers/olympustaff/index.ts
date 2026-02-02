/// <reference path="../../typing/manga-provider.d.ts" />

class Provider {
    private api: string = "https://olympustaff.com"
    private userAgent: string = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"

    private async fetch(url: string, opts: RequestInit = {}): Promise<Response> {
        console.log(`[OlympusStaff] Fetching: ${url}`)
        try {
            const resp = await fetch(url, {
                ...opts,
                headers: {
                    "User-Agent": this.userAgent,
                    "Referer": this.api + "/",
                    ...opts.headers,
                }
            })
            console.log(`[OlympusStaff] Status: ${resp.status}`)
            return resp
        } catch (e) {
            console.error(`[OlympusStaff] Fetch error: ${(e as Error).message}`)
            throw e
        }
    }

    async search({ query }: QueryOptions): Promise<SearchResult[]> {
        console.log(`[OlympusStaff] Searching for: ${query}`)
        try {
            const url = `${this.api}/?s=${encodeURIComponent(query)}`
            const resp = await this.fetch(url)
            const html = await resp.text()
            const $ = LoadDoc(html)

            const resultsMap = new Map<string, SearchResult>()

            // Iterate over ALL links that look like a series link
            $("a").each((i: number, el: any) => {
                const href = el.attr("href")
                if (!href || !href.includes("/series/")) return

                // slug
                const slugMatch = href.match(/\/series\/([^/]+)/)
                if (!slugMatch) return
                const slug = slugMatch[1]
                if (resultsMap.has(slug)) return

                // Avoid chapter links (series/slug/chapter-1)
                // If it has a number at the end, it MIGHT be a chapter, but some series end with numbers.
                // Usually chapter links have another segment.
                // /series/slug is series. /series/slug/chapter is chapter.
                const segments = href.split("/").filter((s: string) => s.length > 0)
                // segments: ['https:', '', 'domain', 'series', 'slug'] -> length 5 (if absolute)
                // or ['series', 'slug'] -> length 2 (if relative)
                // Safe bet: if it has a 3rd part after series, likely a chapter
                // Url structure: https://olympustaff.com/series/slug/ => correct
                // https://olympustaff.com/series/slug/chapter-1 => incorrect
                
                // Let's use strict regex for series page
                // Ends with /series/slug or /series/slug/
                if (!/\/series\/[^/]+\/?$/.test(href)) {
                     // check if it's a chapter link
                     if (/\/series\/[^/]+\/\d+/.test(href)) return 
                }

                // Title - prefer the text inside the anchor first
                let title = el.text().trim()
                if (!title) {
                    title = el.find("h3, h4, .title, .post-title").text().trim()
                }
                
                // Fallback: Check parent for title if anchor is wrapping an image only
                if (!title) {
                     const container = el.closest("article, .item, .post-item, .box, li")
                     if (container.length > 0) {
                         title = container.find("h3, h4, .title, .post-title").text().trim()
                     }
                }

                if (!title) return 

                // Filter
                const queryWords = query.toLowerCase().split(" ").filter(w => w.length > 2)
                const titleLower = title.toLowerCase()
                const match = queryWords.length === 0 || queryWords.some(w => titleLower.includes(w))
                
                if (!match) return

                // Image finding: Look HARD
                // 1. Inside anchor
                let imgEl = el.find("img")
                // 2. Previous sibling
                if (imgEl.length === 0) {
                     imgEl = el.prev().find("img")
                }
                // 3. Parent's siblings (common in list views)
                if (imgEl.length === 0) {
                     const container = el.closest("article, .item, .post-item, .box, li")
                     imgEl = container.find("img")
                }

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
            
            console.log(`[OlympusStaff] Search found ${resultsMap.size} results`)
            return Array.from(resultsMap.values())
        } catch (e) {
            console.error(`[OlympusStaff] Search error: ${(e as Error).message}\n${(e as Error).stack}`)
            return []
        }
    }

    async findChapters(mangaId: string): Promise<ChapterDetails[]> {
        console.log(`[OlympusStaff] Finding chapters for: ${mangaId}`)
        try {
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

                // Clean up title
                let rawText = el.text().trim()
                rawText = rawText.replace(/\s+/g, " ")
                
                console.log(`[OlympusStaff] Raw text for ch ${chapterNum}: "${rawText}"`)

                const garbagePatterns = [
                    /\d{4}/, 
                    /(ago|min|hour|day|week|month|year)/i, 
                    /[\d,.]+\s*(views|مشاهدة)/i, 
                    /^\s*[\d,.]+\s*$/, 
                    /الفصل\s*\d+/ 
                ]
                
                let titleParts: string[] = []
                const parts = rawText.split(/[\n\t•]+/) 
                
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
                        titleParts.push(p)
                    }
                }

                let title = `Chapter ${chapterNum}`
                if (titleParts.length > 0) {
                     title += ` - ${titleParts.join(" ")}`
                }

                chapters.push({
                    id: `${mangaId}$${chapterNum}`,
                    url: href,
                    title: title,
                    chapter: chapterNum,
                    index: 0
                })
            })

            chapters.sort((a, b) => parseInt(b.chapter) - parseInt(a.chapter))
            chapters.forEach((chapter, index) => {
                chapter.index = index
            })

            console.log(`[OlympusStaff] Found ${chapters.length} chapters`)
            return chapters
        } catch (e) {
            console.error(`[OlympusStaff] findChapters error: ${(e as Error).message}\n${(e as Error).stack}`)
            return []
        }
    }

    async findChapterPages(chapterId: string): Promise<ChapterPage[]> {
        console.log(`[OlympusStaff] Finding pages for chapter: ${chapterId}`)
        try {
            const [mangaId, chapterNum] = chapterId.split("$")
            const url = `${this.api}/series/${mangaId}/${chapterNum}`
            const resp = await this.fetch(url)
            const html = await resp.text()
            const $ = LoadDoc(html)

            const pages: ChapterPage[] = []

            let images = $(".chapter-content img, .reading-content img, .page-break img")
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
            
            console.log(`[OlympusStaff] Found ${pages.length} pages`)
            return pages
        } catch (e) {
            console.error(`[OlympusStaff] findChapterPages error: ${(e as Error).message}`)
            return []
        }
    }

    getSettings(): Settings {
        return {
            supportsMultiLanguage: false,
            supportsMultiScanlator: false,
        }
    }
}
