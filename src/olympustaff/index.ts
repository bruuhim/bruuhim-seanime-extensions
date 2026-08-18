/// <reference path="../../typing/manga-provider.d.ts" />

class Provider {
    private api: string = "https://olympustaff.com"
    private userAgent: string = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"

    private async fetch(url: string, opts: RequestInit = {}): Promise<Response> {
        try {
            const resp = await fetch(url, {
                ...opts,
                headers: {
                    "User-Agent": this.userAgent,
                    "Referer": this.api + "/",
                    ...opts.headers,
                }
            })
            return resp
        } catch (e) {
            throw e
        }
    }

    async search({ query }: QueryOptions): Promise<SearchResult[]> {
        try {
            const url = `${this.api}/search?keyword=${encodeURIComponent(query)}`
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

                // Avoid chapter links
                if (!/\/series\/[^/]+\/?$/.test(href)) {
                     if (/\/series\/[^/]+\/\d+/.test(href)) return 
                }

                // Title - look for a title element inside the anchor first (new design)
                let title = el.find(".tx-card-title, h3, h4, .title, .post-title").text().trim()
                if (!title) {
                    title = el.text().trim()
                }
                
                // Fallback: Check parent for title if anchor is wrapping an image only
                if (!title) {
                     const container = el.closest("article, .item, .post-item, .box, li")
                     if (container.length > 0) {
                         title = container.find(".tx-card-title, h3, h4, .title, .post-title").text().trim()
                     }
                }

                if (!title) return 

                // Filter
                const queryWords = query.toLowerCase().split(" ").filter(w => w.length > 2)
                const titleLower = title.toLowerCase()
                const slugLower = slug.toLowerCase()
                const match = queryWords.length === 0 || queryWords.some(w => titleLower.includes(w) || slugLower.includes(w))
                
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
            
            return Array.from(resultsMap.values())
        } catch (e) {
            return []
        }
    }

    async findChapters(mangaId: string): Promise<ChapterDetails[]> {
        try {
            const url = `${this.api}/series/${mangaId}`
            const resp = await this.fetch(url)
            const html = await resp.text()
            const $ = LoadDoc(html)

            // Find max page
            let maxPage = 1
            $(".pagination a").each((i: number, el: any) => {
                const href = el.attr("href")
                if (href) {
                    const match = href.match(/[?&]page=(\d+)/)
                    if (match) {
                        const p = parseInt(match[1])
                        if (p > maxPage) {
                            maxPage = p
                        }
                    }
                }
            })

            // Fetch all pages in parallel (pages 2 to maxPage)
            const pagesHtml: string[] = [html]
            if (maxPage > 1) {
                const promises: Promise<string>[] = []
                for (let p = 2; p <= maxPage; p++) {
                    promises.push((async () => {
                        try {
                            const r = await this.fetch(`${this.api}/series/${mangaId}?page=${p}`)
                            return await r.text()
                        } catch (e) {
                            return ""
                        }
                    })())
                }
                const additionalPages = await Promise.all(promises)
                for (const pageText of additionalPages) {
                    if (pageText) {
                        pagesHtml.push(pageText)
                    }
                }
            }

            const chapters: ChapterDetails[] = []
            const seenChapters = new Set<string>()

            for (const pageHtml of pagesHtml) {
                const $page = LoadDoc(pageHtml)
                let chapterElements = $page(".chapter-link, .enhanced-chapters-grid a, #chaptersContainer a, .chapter-list a, .listing-chapters_wrap a, .wp-manga-chapter a, a.wp-manga-chapter-link")
                if (chapterElements.length === 0) {
                    chapterElements = $page("a[href*='/series/" + mangaId + "/']")
                }

                chapterElements.each((i: number, el: any) => {
                    const href = el.attr("href")
                    if (!href) return

                    const chapterMatch = href.match(/\/series\/[^/]+\/(\d+)/)
                    if (!chapterMatch) return
                    const chapterNum = chapterMatch[1]

                    if (seenChapters.has(chapterNum)) return
                    seenChapters.add(chapterNum)

                    // Clean up title
                    let titleText = el.find(".chapter-title").text().trim()
                    if (titleText) {
                        titleText = titleText.replace(/^["'“”«»]+|["'“”«»]+$/g, "")
                    }
                    
                    let title = `Chapter ${chapterNum}`
                    if (titleText) {
                        title += ` - ${titleText}`
                    } else {
                        let rawText = el.text().trim()
                        rawText = rawText.replace(/\s+/g, " ")
                        
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

                        if (titleParts.length > 0) {
                             title += ` - ${titleParts.join(" ")}`
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
            }

            chapters.sort((a, b) => parseFloat(a.chapter) - parseFloat(b.chapter))
            chapters.forEach((chapter, index) => {
                chapter.index = index
            })

            return chapters
        } catch (e) {
            return []
        }
    }

    async findChapterPages(chapterId: string): Promise<ChapterPage[]> {
        try {
            const [mangaId, chapterNum] = chapterId.split("$")
            const url = `${this.api}/series/${mangaId}/${chapterNum}`
            const resp = await this.fetch(url)
            const html = await resp.text()
            const $ = LoadDoc(html)

            const pages: ChapterPage[] = []

            let images = $(".chapter-content img, .reading-content img, .page-break img, .image_list img, .image_list canvas")
            if (images.length === 0) {
                images = $("img[class*='wp-manga-chapter-img']")
            }

            let pageIndex = 0
            images.each((i: number, el: any) => {
                let src = el.attr("data-src")?.trim() || 
                            el.attr("src")?.trim() ||
                            el.attr("data-lazy-src")?.trim()
                
                if (src && !src.startsWith("http")) {
                    src = (this.api + src).replace(/([^:]\/)\/+/g, "$1")
                }

                if (src && !src.includes("logo") && !src.includes("icon")) {
                    // Filter out promotional banners:
                    // 1. Must contain /uploads/ (standard for manga pages on OlympusStaff)
                    // 2. Parent link (if exists) must not point to external domains
                    if (!src.includes("/uploads/")) return

                    const parentA = el.parent("a")
                    if (parentA.length > 0) {
                        const parentHref = parentA.attr("href")
                        if (parentHref && parentHref.startsWith("http") && !parentHref.includes("olympustaff.com")) {
                            return
                        }
                    }

                    pages.push({
                        url: src,
                        index: pageIndex++,
                        headers: {
                            "Referer": this.api + "/"
                        }
                    })
                }
            })
            
            return pages
        } catch (e) {
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
