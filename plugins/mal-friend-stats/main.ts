/// <reference path="./plugin.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

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

interface JikanUser {
    username: string
    images?: { webp?: { image_url?: string } }
}

interface JikanFriendEntry {
    user: JikanUser
}

interface JikanFriendsResponse {
    data: JikanFriendEntry[]
}

interface JikanAnimeEntry {
    anime: {
        mal_id: number
        episodes?: number
    }
    status: string
    score: number
    episodes_watched: number
}

interface JikanListResponse {
    data: JikanAnimeEntry[]
}

function init() {
    // ── Constants ──
    const JIKAN_BASE = "https://api.jikan.moe/v4"
    const JIKAN_DELAY_MS = 400
    const MAX_FRIENDS = 15
    const CACHE_TTL_MS = 10 * 60 * 1000
    let lastJikanCall = 0

    // ── Jikan API ──
    function jikanGet<T>(path: string): T | null {
        for (let attempt = 0; attempt < 2; attempt++) {
            const now = Date.now()
            const elapsed = now - lastJikanCall
            if (elapsed < JIKAN_DELAY_MS) {
                $sleep(JIKAN_DELAY_MS - elapsed)
            }
            lastJikanCall = Date.now()

            try {
                let response: FetchResponse | undefined
                $await(fetch(JIKAN_BASE + path).then(r => { response = r }))
                if (!response) return null
                if (response.status === 429) {
                    $sleep(1000 * (attempt + 1))
                    continue
                }
                if (!response.ok) return null
                return response.json<T>()
            } catch (err) {
                console.error("mal-friend-stats: Jikan error", err)
                if (attempt === 1) return null
            }
        }
        return null
    }

    // ── Helpers ──
    function mapJikanStatus(status: string): string {
        switch (status) {
            case "watching":       return "CURRENT"
            case "completed":      return "COMPLETED"
            case "on_hold":        return "PAUSED"
            case "dropped":        return "DROPPED"
            case "plan_to_watch":  return "PLANNING"
            default:               return "PLANNING"
        }
    }

    function getMalMediaId(anilistId: number): number | null {
        const token = $database.anilist.getToken()
        if (!token) return null
        try {
            const query = `query ($id: Int) { Media(id: $id) { idMal } }`
            const res = $anilist.customQuery<{ Media: { idMal: number | null } }>(
                { query, variables: { id: anilistId } },
                token,
            )
            return res?.Media?.idMal ?? null
        } catch (err) {
            console.error("mal-friend-stats: failed to get MAL id", err)
            return null
        }
    }

    function getMALUsername(): string | null {
        try {
            const pref = $getUserPreference("MALUsername")
            if (pref) return pref
        } catch {}
        try {
            const stored = $storage.get("mal-username")
            if (stored) return stored
        } catch {}
        return null
    }

    function fetchMalFriends(malId: number, malUsername: string): FriendEntry[] {
        const friendsResp = jikanGet<JikanFriendsResponse>(
            `/users/${encodeURIComponent(malUsername)}/friends`,
        )
        if (!friendsResp?.data?.length) return []

        const results: FriendEntry[] = []
        const limit = Math.min(friendsResp.data.length, MAX_FRIENDS)

        for (let i = 0; i < limit; i++) {
            const friend = friendsResp.data[i]
            const username = friend.user.username

            const listResp = jikanGet<JikanListResponse>(
                `/users/${encodeURIComponent(username)}/animelist`,
            )
            if (!listResp?.data) continue

            const match = listResp.data.find(e => e.anime.mal_id === malId)
            if (!match) continue

            results.push({
                status: mapJikanStatus(match.status),
                score: (match.score || 0) * 10,
                progress: match.episodes_watched || 0,
                totalEpisodes: match.anime.episodes ?? undefined,
                user: {
                    name: username,
                    avatar: friend.user.images?.webp?.image_url,
                },
            })
        }
        return results
    }

    // ── Plugin UI ──
    $ui.register((ctx) => {
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
                console.error("mal-friend-stats: failed to open url", err)
            }
            openUrl.set("")
        }, [openUrl])

        ctx.screen.onNavigate((e) => {
            const id = e.pathname === "/entry" && !!e.searchParams.id
                ? parseInt(e.searchParams.id)
                : 0
            mediaId.set(id)
        })
        ctx.screen.loadCurrent()

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

            const malId = getMalMediaId(id)
            if (!malId) {
                friends.set([])
                loading.set(false)
                panel.show()
                return
            }

            // Check storage cache
            try {
                const cached = $storage.get(`mal-friends-${malId}`)
                if (cached) {
                    const { timestamp, entries } = JSON.parse(cached)
                    if (Date.now() - timestamp < CACHE_TTL_MS) {
                        friends.set(entries)
                        loading.set(false)
                        if (entries.length > 0) panel.show()
                        else panel.hide()
                        return
                    }
                }
            } catch {}

            loading.set(true)
            const entries = fetchMalFriends(malId, malUser)

            try {
                $storage.set(`mal-friends-${malId}`, JSON.stringify({
                    timestamp: Date.now(),
                    entries,
                }))
            } catch {}

            friends.set(entries)
            loading.set(false)

            if (entries.length > 0) panel.show()
            else panel.hide()
        }, [mediaId])

        panel.setContent(() => `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
    html { color-scheme: dark; overflow: hidden; }
    body { background: transparent; color: #e2e8f0; font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 0; }
    .heading { font-size: 1.3rem; font-weight: 600; margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }
    .heading .badge { font-size: 0.7rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: #2e51a2; color: #fff; }
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
            note.textContent = "Set your MAL username in settings or $storage('mal-username')"
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

        var heading = document.createElement("div")
        heading.className = "heading"
        heading.textContent = "MAL Friends"
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
