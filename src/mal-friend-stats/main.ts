/// <reference path="./plugin.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

function init() {
    $ui.register((ctx) => {

        // ──────────────────────────────── Types ────────────────────────────────

        interface FriendEntry {
            status: string
            score: number
            progress: number
            totalEpisodes?: number
            user: {
                name: string
                avatar?: string
            }
        }

        interface MalFriend {
            username: string
            avatar: string
        }

        // L1: in-memory fast path — lives only while this plugin VM is alive.
        const memoryCache = new Map<string, { value: any, complete?: boolean, expiresAt: number }>()

        // ──────────────────────────────── Constants ────────────────────────────────

        const MAX_FRIENDS = 15
        const FRIENDS_LIST_TTL_MS = 60 * 60 * 1000  // 1h
        const ANIME_LIST_TTL_MS = 60 * 60 * 1000    // 1h
        const RESULT_TTL_MS = 24 * 60 * 60 * 1000   // 24h

        // ──────────────────────────────── Cache helpers ($storage-backed) ──────────
        // Two layers:
        //   L1: in-memory Map — fast path while this plugin VM is alive
        //   L2: $storage — persistent across navigation / restarts (requires "storage" permission)
        // Persistent entries are stored as { v, c, e }: v = value, c = complete flag, e = expiry (ms).

        function cacheGet(key: string): { value: any, complete?: boolean } | null {
            const now = Date.now()
            const mem = memoryCache.get(key)
            if (mem && mem.expiresAt > now) {
                return { value: mem.value, complete: mem.complete }
            }
            try {
                const stored = $storage.get<{ v?: any, c?: boolean, e?: number }>(key)
                if (stored && stored.e && stored.e > now) {
                    return { value: stored.v, complete: stored.c }
                }
            } catch (err) {
                // storage unavailable — fall back to memory-only caching
            }
            return null
        }

        function cacheSet(key: string, value: any, ttlMs: number, complete?: boolean) {
            const expiresAt = Date.now() + ttlMs
            memoryCache.set(key, { value, complete, expiresAt })
            try {
                $storage.set(key, { v: value, c: complete, e: expiresAt })
            } catch (err) {
                // ignore — memory cache still provides a fast path for this session
            }
        }

        // ──────────────────────────────── Helpers ────────────────────────────────

        function mapMALStatus(statusNum: number): string {
            switch (statusNum) {
                case 1:  return "CURRENT"
                case 2:  return "COMPLETED"
                case 3:  return "PAUSED"
                case 4:  return "DROPPED"
                case 6:  return "PLANNING"
                default: return "PLANNING"
            }
        }

        function getMalMediaId(anilistId: number): number | null {
            const token = $database.anilist.getToken()
            if (!token) {
                return null
            }
            try {
                const query = `query ($id: Int) { Media(id: $id) { idMal } }`
                const res = $anilist.customQuery<{ Media: { idMal: number | null } }>(
                    { query, variables: { id: anilistId } },
                    token,
                )
                return res?.Media?.idMal ?? null
            } catch (err) {
                return null
            }
        }

        function getMALUsername(): string | null {
            const malUser = "{{malUsername}}"
            if (!malUser || malUser.startsWith("{{")) {
                return null
            }
            return malUser
        }

        async function fetchFriendList(malUsername: string): Promise<MalFriend[]> {
            const cacheKey = `mfs:friends:${malUsername}`

            const cached = cacheGet(cacheKey)
            if (cached) {
                return cached.value
            }

            const friendsUrl = `https://myanimelist.net/profile/${encodeURIComponent(malUsername)}/friends`

            let friendsHtml = ""
            try {
                const friendsHtmlResp = await ctx.fetch(friendsUrl)
                if (!friendsHtmlResp || !friendsHtmlResp.ok) {
                    return []
                }
                friendsHtml = friendsHtmlResp.text()
            } catch (err) {
                return []
            }

            const parts = friendsHtml.split('<div class="boxlist col-3">')
            const parsed: MalFriend[] = []

            for (let i = 1; i < parts.length; i++) {
                const part = parts[i]
                const userMatch = part.match(/href="https:\/\/myanimelist\.net\/profile\/([^"/?#\s]+)"/)
                if (userMatch) {
                    const username = decodeURIComponent(userMatch[1])
                    let avatar = ""
                    const dataSrcMatch = part.match(/data-src="([^"]+)"/)
                    if (dataSrcMatch) {
                        avatar = dataSrcMatch[1]
                    } else {
                        const srcMatch = part.match(/src="([^"]+)"/)
                        if (srcMatch && !srcMatch[1].endsWith('spacer.gif')) {
                            avatar = srcMatch[1]
                        }
                    }
                    parsed.push({ username, avatar })
                }
            }

            cacheSet(cacheKey, parsed, FRIENDS_LIST_TTL_MS)
            return parsed
        }

        // Fetches a single friend's animelist (paginated only when necessary).
        // Returns [] on failure so the caller can continue with the other friends.
        async function fetchAnimeList(friend: MalFriend, malId: number): Promise<any[]> {
            const cacheKey = `mfs:anime:${friend.username.toLowerCase()}`

            const cached = cacheGet(cacheKey)
            if (cached) {
                // Target already present in the cached list → done.
                const hit = (cached.value || []).find((e: any) => e.anime_id === malId)
                if (hit) {
                    return cached.value
                }
                // Only trust a cache entry that covers the friend's ENTIRE completed list.
                if (cached.complete) {
                    return cached.value
                }
                // Incomplete + target not present → re-fetch (list may be truncated).
            }

            let listData: any[] = []
            let offset = 0
            let complete = false
            try {
                while (offset < 900) {
                    const listUrl = `https://myanimelist.net/animelist/${encodeURIComponent(friend.username)}/load.json?status=7&offset=${offset}`
                    const listResp = await ctx.fetch(listUrl)
                    if (!listResp || !listResp.ok) {
                        break
                    }

                    const pageData = listResp.json<any[]>()
                    if (!pageData || !pageData.length) {
                        // Reached the end of the friend's list.
                        complete = true
                        break
                    }

                    listData = listData.concat(pageData)

                    // Early exit once we found the target anime, or when the page
                    // was not completely full (no more pages exist).
                    const found = listData.some(e => e.anime_id === malId)
                    if (found || pageData.length < 300) {
                        complete = pageData.length < 300
                        break
                    }

                    offset += 300
                }

                cacheSet(cacheKey, listData, ANIME_LIST_TTL_MS, complete)
            } catch (err) {
                // Silently ignore — caller continues with the other friends.
            }

            return listData
        }

        async function fetchMalFriends(malId: number, malUsername: string): Promise<FriendEntry[]> {
            const friends = await fetchFriendList(malUsername)

            const limit = Math.min(friends.length, MAX_FRIENDS)
            const results: FriendEntry[] = []

            // Fetch ALL friend animelists in parallel — no staggering, no
            // artificial delays. Worst case is one network round-trip.
            const lists = await Promise.all(
                friends.slice(0, limit).map((friend) => fetchAnimeList(friend, malId))
            )

            for (let i = 0; i < limit; i++) {
                const friend = friends[i]
                const listData = lists[i] || []
                const match = listData.find(e => e.anime_id === malId)
                if (match) {
                    results.push({
                        status: mapMALStatus(match.status),
                        score: (match.score || 0) * 10,
                        progress: match.num_watched_episodes || 0,
                        totalEpisodes: match.anime_num_episodes ?? undefined,
                        user: {
                            name: friend.username,
                            avatar: friend.avatar || undefined,
                        },
                    })
                }
            }

            return results
        }

        // ──────────────────────────────── Plugin Entry ────────────────────────────────

        const mediaId = ctx.state(0)
        const friends = ctx.state<FriendEntry[]>([])
        const loading = ctx.state(false)
        const configured = ctx.state(false)

        const panel = ctx.newWebview({
            slot: "after-anime-entry-episode-list",
            fullWidth: true,
            autoHeight: true,
        })

        panel.channel.sync("friends", friends)
        panel.channel.sync("loading", loading)
        panel.channel.sync("configured", configured)

        // ── Open profile links ──
        const openUrl = ctx.state("")
        panel.channel.on("open-profile", (url: string) => {
            openUrl.set(url)
        })

        ctx.effect(() => {
            const url = openUrl.get()
            if (!url) return
            try {
                if ($os.platform === "windows") {
                    $os.cmd("cmd", "/c", "start", url).start()
                } else if ($os.platform === "darwin") {
                    $os.cmd("open", url).start()
                } else {
                    $os.cmd("xdg-open", url).start()
                }
            } catch (err) {
                // Silently ignore — unable to open the URL.
            }
            openUrl.set("")
        }, [openUrl])

        // ── Track navigation ──
        ctx.screen.onNavigate((e) => {
            const id = e.pathname === "/entry" && !!e.searchParams.id
                ? parseInt(e.searchParams.id)
                : 0
            mediaId.set(id)
            // Show the loading state as soon as we land on an anime page so the
            // user always sees feedback while the plugin is working.
            if (id) {
                friends.set([])
                loading.set(true)
                panel.show()
            }
        })
        ctx.screen.loadCurrent()

        // ── Main effect ──
        ctx.effect(() => {
            const id = mediaId.get()
            if (!id) {
                friends.set([])
                loading.set(false)
                panel.hide()
                return
            }

            const malUser = getMALUsername()
            if (!malUser) {
                friends.set([])
                configured.set(false)
                loading.set(false)
                panel.hide()
                return
            }
            configured.set(true)

            // Show the panel with the loading spinner immediately, before any
            // network work (MAL ID mapping + friend fetches) happens.
            loading.set(true)
            panel.show()

            let malId: number | null = null
            try {
                malId = ctx.cache.getOrSet(`mal-id-${id}`, () => {
                    const resolved = getMalMediaId(id)
                    if (!resolved) {
                        throw new Error("MAL ID mapping returned null")
                    }
                    return resolved
                }, 24 * 60 * 60 * 1000) as number
            } catch (err) {
                // Mapping failed — fall through and hide the panel.
            }

            if (!malId) {
                friends.set([])
                loading.set(false)
                panel.hide()
                return
            }

            const cacheKey = `mfs:result:${malUser}:${malId}`
            const cached = cacheGet(cacheKey)

            if (cached) {
                // Instant path: cached answer — no need to show the spinner.
                friends.set(cached.value)
                loading.set(false)
                if (cached.value.length > 0) {
                    panel.show()
                } else {
                    panel.hide()
                }
                return
            }

            ;(async () => {
                try {
                    const entries = await fetchMalFriends(malId, malUser)
                    cacheSet(cacheKey, entries, RESULT_TTL_MS)
                    friends.set(entries)
                    if (entries.length > 0) {
                        panel.show()
                    } else {
                        panel.hide()
                    }
                } catch (err) {
                    friends.set([])
                    panel.hide()
                } finally {
                    loading.set(false)
                }
            })()
        }, [mediaId])

        // ── UI ──
        panel.setContent(() => `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
    html { color-scheme: dark; overflow: hidden; }
    body { background: transparent; color: #e2e8f0; font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 0; }

    .heading { font-size: 1.3rem; font-weight: 600; margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }
    .heading .icon-svg { flex-shrink: 0; }
    .heading .badge { font-size: 0.7rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: #2e51a2; color: #fff; margin-left: 4px; }

    .list { display: flex; flex-wrap: wrap; gap: 9px; }

    .row { display: flex; align-items: center; gap: 12px; padding: 9px 15px; background: rgba(255,255,255,0.04); border-radius: 12px; text-decoration: none; color: inherit; cursor: pointer; }
    .row:hover { background: rgba(255,255,255,0.08); }

    .avatar { width: 42px; height: 42px; border-radius: 50%; object-fit: cover; flex-shrink: 0; background: rgba(255,255,255,0.08); }
    .name { font-size: 1.3rem; max-width: 270px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .episode { font-size: 1.2rem; opacity: 0.8; }
    .score { font-size: 1.2rem; font-weight: 600; }
    .status { font-size: 1.1rem; font-weight: 600; padding: 3px 12px; border-radius: 999px; color: #10161f; }

    .loading { display: flex; align-items: center; gap: 10px; padding: 12px 15px; color: #8892a4; font-size: 1.2rem; }
    .spinner { width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.12); border-top-color: #8892a4; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .empty { color: #8892a4; padding: 12px 15px; font-size: 1.2rem; }
    .note { color: #5a6476; padding: 12px 15px; font-size: 1.1rem; }
</style>
</head>
<body>
<div id="app"></div>
<script>
    var STATUS_LABEL = {"CURRENT":"Watching","PLANNING":"Planning","COMPLETED":"Completed","DROPPED":"Dropped","PAUSED":"On Hold","REPEATING":"Rewatching"}
    var STATUS_COLOR = {"CURRENT":"#3db4f2","PLANNING":"#f2c94c","COMPLETED":"#4cd137","DROPPED":"#e84118","PAUSED":"#a4a4a4","REPEATING":"#9b59b6"}

    function scoreColor(s) {
        if (s >= 80) return "#4cd137"
        if (s >= 60) return "#c9d137"
        if (s >= 40) return "#f2994a"
        return "#e84118"
    }

    function renderRow(entry) {
        var username = (entry.user && entry.user.name) || ""
        var url = "https://myanimelist.net/profile/" + encodeURIComponent(username)

        var row = document.createElement("a")
        row.className = "row"
        row.href = url
        row.target = "_blank"
        row.rel = "noopener noreferrer"
        row.addEventListener("click", function (e) {
            e.preventDefault()
            window.webview.send("open-profile", url)
        })

        var img = document.createElement("img")
        img.className = "avatar"
        img.src = (entry.user && entry.user.avatar) || ""
        img.onerror = function () { this.style.display = "none" }
        row.appendChild(img)

        var name = document.createElement("div")
        name.className = "name"
        name.textContent = username || "Unknown"
        row.appendChild(name)

        if (entry.progress > 0 && entry.status !== "COMPLETED") {
            var ep = document.createElement("div")
            ep.className = "episode"
            ep.textContent = "Ep " + entry.progress + (entry.totalEpisodes ? "/" + entry.totalEpisodes : "")
            row.appendChild(ep)
        }

        if (entry.score > 0) {
            var s = document.createElement("div")
            s.className = "score"
            s.style.color = scoreColor(entry.score)
            s.textContent = String(Math.round(entry.score) / 10)
            row.appendChild(s)
        }

        var st = document.createElement("div")
        st.className = "status"
        st.style.background = STATUS_COLOR[entry.status] || "#a4a4a4"
        st.textContent = STATUS_LABEL[entry.status] || entry.status
        row.appendChild(st)

        return row
    }

    function render(friends, loading, configured) {
        var app = document.getElementById("app")
        app.innerHTML = ""

        if (!configured) {
            var note = document.createElement("div")
            note.className = "note"
            note.textContent = "Set your MAL username in settings"
            app.appendChild(note)
            return
        }

        if (loading) {
            var loader = document.createElement("div")
            loader.className = "loading"
            var sp = document.createElement("div")
            sp.className = "spinner"
            loader.appendChild(sp)
            loader.appendChild(document.createTextNode("Loading MAL friends\u2026"))
            app.appendChild(loader)
            return
        }

        if (!friends || friends.length === 0) {
            var empty = document.createElement("div")
            empty.className = "empty"
            empty.textContent = "No MAL friends found for this anime"
            app.appendChild(empty)
            return
        }

        // Heading with MAL icon
        var heading = document.createElement("div")
        heading.className = "heading"
        heading.innerHTML = '<svg class="icon-svg" width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="#2e51a2"/><circle cx="8.5" cy="9.5" r="1.5" fill="white"/><circle cx="15.5" cy="9.5" r="1.5" fill="white"/><path d="M7 14.5c1.5 2.5 4.5 2.5 6 0" stroke="white" stroke-width="2" stroke-linecap="round" fill="none"/></svg>'
        heading.appendChild(document.createTextNode("MAL Friends"))
        var badge = document.createElement("span")
        badge.className = "badge"
        badge.textContent = "MAL"
        heading.appendChild(badge)
        app.appendChild(heading)

        var list = document.createElement("div")
        list.className = "list"
        friends.forEach(function (f) { list.appendChild(renderRow(f)) })
        app.appendChild(list)
    }

    var _friends = []
    var _loading = false
    var _configured = false

    function rerender() { render(_friends, _loading, _configured) }

    window.webview.on("friends", function (d) { _friends = d || []; rerender() })
    window.webview.on("loading", function (d) { _loading = !!d; rerender() })
    window.webview.on("configured", function (d) { _configured = !!d; rerender() })
</script>
</body>
</html>
        `)
    })
}
