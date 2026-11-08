package com.bilimusic.player.data

import android.content.Context
import com.bilimusic.player.net.BiliClient
import com.bilimusic.player.net.FavFolder
import com.bilimusic.player.net.VideoMeta
import com.bilimusic.player.sync.TrackCore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * 「跟随收藏夹」的本地状态：
 *   - 关注了哪些收藏夹（favSources）
 *   - 每个收藏夹上次同步到的条目快照（favTracks，键 `${folderId}:${bvid}:${page}`）
 *
 * 桌面端把这两份东西放在 library.json 里。安卓端同样放在自己的 AppLibrary 目录下，
 * 用一个小的 JSON 文件，因为它是「收藏夹镜像」而不是用户手改的歌单，
 * 不需要 CRDT 合并（每次同步都是拿远端覆盖本地的过程）。
 */
class FavSourceStore(context: Context) {

    @kotlinx.serialization.Serializable
    data class Source(val folderId: Long, val title: String, val count: Int, val followed: Boolean, val lastSync: Long)

    private val file = File(context.filesDir, "fav-sources.json")
    private val doc = kotlinx.serialization.json.Json { prettyPrint = false; ignoreUnknownKeys = true }

    private var sources: MutableMap<String, Source> = LinkedHashMap()
    /** 收藏夹条目快照：folderId -> (key -> TrackCore) */
    private var items: MutableMap<String, MutableMap<String, TrackCore>> = LinkedHashMap()

    @kotlinx.serialization.Serializable
    private data class Payload(
        val sources: Map<String, Source> = emptyMap(),
        val items: Map<String, Map<String, TrackCore>> = emptyMap(),
    )

    init {
        load()
    }

    private fun load() {
        if (!file.exists()) return
        runCatching {
            val p = doc.decodeFromString(Payload.serializer(), file.readText())
            sources = LinkedHashMap(p.sources)
            items = p.items.mapValuesTo(LinkedHashMap()) { LinkedHashMap(it.value) }
        }
    }

    fun save() {
        runCatching {
            file.writeText(doc.encodeToString(Payload.serializer(), Payload(sources, items)))
        }
    }

    fun all(): List<Source> = sources.values.sortedBy { it.title }

    fun get(folderId: Long): Source? = sources[folderId.toString()]

    fun follow(folder: FavFolder) {
        sources[folder.id.toString()] = Source(folder.id, folder.title, folder.mediaCount, true, 0)
    }

    fun unfollow(folderId: Long) {
        sources.remove(folderId.toString())
        items.remove(folderId.toString())
    }

    fun tracksOf(folderId: Long): List<TrackCore> =
        items[folderId.toString()]?.values?.sortedBy { it.title } ?: emptyList()

    /**
     * 用一次完整的收藏夹快照替换本地镜像。
     * 返回新增了多少首歌（只在新增时提示用户，删掉的静默处理）。
     */
    fun applySnapshot(folderId: Long, title: String, count: Int, tracks: List<TrackCore>): Int {
        val key = folderId.toString()
        val old = items[key] ?: emptyMap()
        val next = LinkedHashMap<String, TrackCore>()
        var added = 0
        for (t in tracks) {
            next[t.key] = t
            if (!old.containsKey(t.key)) added++
        }
        items[key] = next
        val prev = sources[key]
        sources[key] = Source(
            folderId = folderId,
            title = title,
            count = count,
            followed = prev?.followed ?: false,
            lastSync = System.currentTimeMillis(),
        )
        save()
        return added
    }

    companion object {
        /** 收藏夹条目 → 曲目键约定与桌面端一致：bili:<bvid> 或 bili:<bvid>:p<page> */
        fun keyOf(bvid: String, page: Int, multi: Boolean): String =
            if (multi) "bili:$bvid:p$page" else "bili:$bvid"

        fun toTrackCore(
            meta: VideoMeta,
            page: Int,
            pages: Int,
            part: String,
            duration: Int,
            cid: Long,
        ): TrackCore {
            val multi = pages > 1
            val id = if (multi) "${meta.bvid}:p$page" else meta.bvid
            val cleaned = BiliClient.cleanPartName(part, meta.title)
            val partName = if (multi) {
                if (cleaned.isNotEmpty()) "P$page $cleaned" else "P$page"
            } else ""
            return TrackCore(
                key = "bili:$id",
                type = "bili",
                id = id,
                bvid = meta.bvid,
                cid = if (cid > 0) cid else meta.cid,
                page = page,
                title = if (partName.isNotEmpty()) "${meta.title} · $partName" else meta.title,
                artist = meta.owner,
                cover = meta.pic,
                duration = if (duration > 0) duration.toLong() else meta.duration.toLong(),
                partCount = pages,
            )
        }
    }
}
