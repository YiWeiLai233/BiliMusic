package com.bilimusic.player.data

import com.bilimusic.player.sync.Reg
import com.bilimusic.player.sync.TrackCore
import org.json.JSONObject

/**
 * 兼容桌面版导出的 `{kind:"bili-music-playlists", version:1, playlists, local, bili}`。
 *
 * 桌面版（Electron + src/library.js）是「订阅收藏夹的纯音频播放器」，现在的数据是
 * 命令式结构；安卓端是 CRDT 结构。这个适配器让两边的文件**双向可读**：
 * 用户从桌面导出的 JSON 直接倒进手机就能用，反过来手机导出的 compact doc 也能
 * 被桌面端吃（见 SYNC_DESIGN.md 的兼容说明）。
 */
object LegacyImport {

    fun apply(lib: AppLibrary, root: JSONObject): Int {
        var n = 0

        val bili = root.optJSONObject("bili")
        if (bili != null) {
            for (key in bili.keys()) {
                val o = bili.optJSONObject(key) ?: continue
                lib.upsertTrack(
                    TrackCore(
                        key = "bili:$key",
                        type = "bili",
                        id = key,
                        bvid = o.optString("bvid", key.substringBefore(":")),
                        cid = o.optLong("cid", 0L),
                        page = o.optInt("page", 1).coerceAtLeast(1),
                        title = o.optString("title", key),
                        artist = o.optString("artist", o.optString("owner", "")),
                        cover = o.optString("cover", o.optString("pic", "")),
                        duration = o.optLong("duration", 0L),
                        partCount = o.optInt("partCount", 1).coerceAtLeast(1),
                    )
                )
                n++
            }
        }

        val local = root.optJSONObject("local")
        if (local != null) {
            for (key in local.keys()) {
                val o = local.optJSONObject(key) ?: continue
                lib.upsertTrack(
                    TrackCore(
                        key = "local:$key",
                        type = "local",
                        id = key,
                        title = o.optString("title", key),
                        artist = o.optString("artist", ""),
                        cover = "",
                        duration = o.optLong("duration", 0L),
                    )
                )
                n++
            }
        }

        val playlists = root.optJSONObject("playlists")
        if (playlists != null) {
            for (pid in playlists.keys()) {
                val o = playlists.optJSONObject(pid) ?: continue
                val title = o.optString("title", "导入的歌单")
                // 同标题复用，避免反复导入出现一堆同名歌单
                val exist = lib.livePlaylists().firstOrNull { it.title.v == title }
                val id = exist?.id ?: pid.let { if (it.isBlank()) lib.createPlaylist(title) else it }
                if (exist == null && lib.doc.playlists[id] == null) {
                    lib.createPlaylist(title)
                } else if (exist == null) {
                    lib.renamePlaylist(id, title)
                }
                val items = o.optJSONArray("items") ?: continue
                val keys = ArrayList<String>()
                for (i in 0 until items.length()) {
                    val it = items.optJSONObject(i) ?: continue
                    val type = it.optString("type", "bili")
                    val tid = it.optString("id", "")
                    if (tid.isEmpty()) continue
                    val key = if (tid.startsWith("bili:") || tid.startsWith("local:")) tid else "$type:$tid"
                    keys.add(key)
                }
                lib.addToPlaylist(id, keys)
            }
        }
        return n
    }

    /** 桌面端的 favTracks/favSources 也认，倒进来进「我喜欢的歌」 */
    fun applyFavorites(lib: AppLibrary, root: JSONObject): Int {
        var n = 0
        val fav = root.optJSONObject("favTracks") ?: return 0
        for (fid in fav.keys()) {
            val bucket = fav.optJSONObject(fid) ?: continue
            for (key in bucket.keys()) {
                val o = bucket.optJSONObject(key) ?: continue
                val bvid = o.optString("bvid", key.substringBefore(":"))
                if (bvid.isEmpty()) continue
                val k = "bili:$key"
                lib.upsertTrack(
                    TrackCore(
                        key = k,
                        type = "bili",
                        id = key,
                        bvid = bvid,
                        cid = o.optLong("cid", 0L),
                        page = o.optInt("page", 1).coerceAtLeast(1),
                        title = o.optString("title", key),
                        artist = o.optString("owner", ""),
                        cover = o.optString("pic", ""),
                        duration = o.optLong("duration", 0L),
                        partCount = o.optInt("partCount", 1).coerceAtLeast(1),
                    )
                )
                lib.setLoved(k, true)
                n++
            }
        }
        return n
    }

    /** 反过来：把手机端数据导成桌面端吃得下的 JSON */
    fun toDesktop(lib: AppLibrary): JSONObject {
        val root = JSONObject()
        root.put("kind", "bili-music-playlists")
        root.put("version", 1)
        root.put("exportedAt", java.time.Instant.now().toString())

        val bili = JSONObject()
        val local = JSONObject()
        val playlists = JSONObject()

        for (p in lib.livePlaylists()) {
            val po = JSONObject()
            po.put("id", p.id)
            po.put("title", p.title.v)
            po.put("createdAt", p.createdAt)
            val arr = org.json.JSONArray()
            for (k in lib.itemKeys(p.id)) {
                val t = lib.track(k) ?: continue
                val io = JSONObject()
                io.put("type", t.type)
                io.put("id", t.id)
                arr.put(io)
                if (t.type == "bili") bili.put(t.id, biliJson(t)) else local.put(t.id, localJson(t))
            }
            po.put("items", arr)
            playlists.put(p.id, po)
        }
        for (k in lib.lovedKeys()) {
            val t = lib.track(k) ?: continue
            if (t.type == "bili") bili.put(t.id, biliJson(t)) else local.put(t.id, localJson(t))
        }

        root.put("bili", bili)
        root.put("local", local)
        root.put("playlists", playlists)
        return root
    }

    private fun biliJson(t: TrackCore): JSONObject = JSONObject().apply {
        put("id", t.id)
        put("bvid", t.bvid)
        put("cid", t.cid)
        put("page", t.page)
        put("title", t.title)
        put("owner", t.artist)
        put("pic", t.cover)
        put("duration", t.duration)
        put("partCount", t.partCount)
    }

    private fun localJson(t: TrackCore): JSONObject = JSONObject().apply {
        put("id", t.id)
        put("title", t.title)
        put("artist", t.artist)
        put("duration", t.duration)
    }
}
