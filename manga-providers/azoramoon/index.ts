/// <reference path="../../typing/manga-provider.d.ts" />

class Provider {
    private api: string = "https://azoramoon.com"
    private apiUrl: string = "https://api.azoramoon.com/api"
    private userAgent: string = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"

    private async fetch(url: string, opts: RequestInit = {}): Promise<Response> {
        try {
            return await fetch(url, {
                ...opts,
                headers: {
                    "User-Agent": this.userAgent,
                    "Referer": this.api + "/",
                    ...opts.headers,
                }
            })
        } catch (e) {
            throw e
        }
    }

    async search({ query }: QueryOptions): Promise<SearchResult[]> {
        try {
            const url = `${this.apiUrl}/query?searchTerm=${encodeURIComponent(query)}&perPage=20`
            const resp = await this.fetch(url)
            const data = await resp.json()

            if (!data || !data.posts) {
                return []
            }

            return data.posts.map((post: any) => {
                const synonyms = post.alternativeTitles 
                    ? post.alternativeTitles.split(/[\s\t]+/).filter((s: string) => s.length > 2)
                    : []

                const year = post.createdAt ? new Date(post.createdAt).getFullYear() : undefined

                return {
                    id: `${post.id}|${post.slug}`,
                    title: post.postTitle,
                    image: post.featuredImage || "",
                    synonyms: synonyms,
                    year: year
                }
            })
        } catch (e) {
            return []
        }
    }

    async findChapters(mangaId: string): Promise<ChapterDetails[]> {
        try {
            let mangaSlug: string | null = null

            if (mangaId.includes("|")) {
                mangaSlug = mangaId.split("|")[1]
            } else {
                mangaSlug = mangaId
            }

            if (!mangaSlug) return []

            const url = `${this.api}/series/${mangaSlug}`
            const resp = await this.fetch(url)
            const html = await resp.text()
            const $ = LoadDoc(html)

            const chapters: ChapterDetails[] = []
            const seenSlugs = new Set<string>()

            // Find all chapter links on the series page
            // AzoraMoon uses standard links for chapters in its SSR/DOM
            $("a").each((i: number, el: any) => {
                const href = el.attr("href")
                if (!href || !href.includes("/series/" + mangaSlug + "/")) return

                const chapterSlugMatch = href.match(/\/series\/[^/]+\/([^/]+)\/?$/)
                if (!chapterSlugMatch) return
                const chapterSlug = chapterSlugMatch[1]

                if (seenSlugs.has(chapterSlug)) return
                seenSlugs.add(chapterSlug)

                // Extract chapter number from slug
                const numMatch = chapterSlug.match(/chapter-(\d+(?:\.\d+)?)/)
                const number = numMatch ? numMatch[1] : chapterSlug.replace("chapter-", "")

                chapters.push({
                    id: `${mangaSlug}$${chapterSlug}`,
                    url: (href.startsWith("http") ? href : this.api + href).replace(/([^:]\/)\/+/g, "$1"),
                    title: `الفصل ${number}`,
                    chapter: number,
                    index: 0
                })
            })

            // Sort ascending by chapter number
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
            const [mangaSlug, chapterSlug] = chapterId.split("$")
            const url = `${this.api}/series/${mangaSlug}/${chapterSlug}`
            const resp = await this.fetch(url)
            const html = await resp.text()
            
            const pages: ChapterPage[] = []

            // Robust regex extraction for Next.js App Router RSC data
            const imgRegex = /https:\/\/storage\.azoramoon\.com\/WP-manga\/data\/[^\s"']+\.(?:webp|jpg|png|jpeg)/gi
            const matches = html.match(imgRegex)
            
            if (matches && matches.length > 0) {
                const uniqueImages = [...new Set(matches)]
                uniqueImages.forEach((url, i) => {
                    pages.push({
                        url: url,
                        index: i,
                        headers: {
                            "Referer": this.api + "/"
                        }
                    })
                })
            }

            // Fallback to DOM if regex fails (e.g. if structure changes slightly)
            if (pages.length === 0) {
                const $ = LoadDoc(html)
                const images = $(".comic-images-wrapper img")
                
                images.each((i: number, el: any) => {
                    let src = el.attr("src") || el.attr("data-src") || el.attr("data-lazy-src")
                    if (src) {
                        src = src.trim()
                        if (!src.startsWith("http")) {
                            src = (this.api + (src.startsWith("/") ? "" : "/") + src).replace(/([^:]\/)\/+/g, "$1")
                        }
                        
                        pages.push({
                            url: src,
                            index: i,
                            headers: {
                                "Referer": this.api + "/"
                            }
                        })
                    }
                })
            }

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
