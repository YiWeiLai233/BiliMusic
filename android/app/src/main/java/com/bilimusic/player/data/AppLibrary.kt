package com.bilimusic.player.data

import com.bilimusic.player.sync.ItemEntry
import com.bilimusic.player.sync.MarkEntry
import com.bilimusic.player.sync.Merger
import com.bilimusic.player.sync.PlaylistEntry
import com.bilimusic.player.sync.Pos
import com.bilimusic.player.sync.Reg
import com.bilimusic.player.sync.SyncCodec
import com.bilimusic.player.sync.SyncDoc
import com.bilimusic.player.sync.TrackCore
import com.bilimusic.player.sync.TrackEntry
import com.bilimusic.player.sync.hlcGreater
import java.io.File

/**
 * 应用侧的唯一真相：一份 [SyncDoc]。
 *
 * 这里**不维护**第二份「方便的结构」，因为双份数据一旦不同步就会出现
 * 「界面上有、同步过去没有」这类最难查的 bug。所有读操作都从 doc 现算，
 * 顺序由 [Pos] 位置键排出来。
 *
 * 本地文件里保存的也是原样的 doc，所以桌面端（Node 版实现）能直接读同一份结构。
 *
 * **线程安全**：所有会改 doc / 落盘的方法都加了 `@Synchronized`。同步服务端是
 * 固定 4 线程池，主动同步和「吃同步码」又各起裸线程，两台设备同时连过来时
 * 会有多个线程一起 merge。没有锁就是「读 doc → 算 → 写 doc」的丢更新，
 * 以及两个线程同时往同一个 `.tmp` 里写导致的文件损坏。
 */
class AppLibrary(val file: File) {

    var doc: SyncDoc = SyncDoc()
        private set

    private var clock = com.bilimusic.player.sync.Hlc.ZERO
    var deviceId: String = ""
        private set

    /** 落盘节流：连续改十几下不必写十几次盘 */
    private var dirty = false

    @Synchronized
    fun load(id: String) {
        deviceId = id
        doc = try {
            if (file.exists()) {
                SyncCodec.json.decodeFromString(SyncDoc.serializer(), file.readText())
            } else {
                SyncDoc(deviceId = id)
            }
        } catch (e: Exception) {
            // 文件坏了就当空库，但别把坏文件覆盖掉——改名留档
            runCatching {
                file.renameTo(File(file.parentFile, file.name + ".broken." + System.currentTimeMillis()))
            }
            SyncDoc(deviceId = id)
        }
        if (doc.deviceId.isEmpty()) doc = doc.copy(deviceId = id)
    }

    @Synchronized
    fun save() {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(SyncCodec.json.encodeToString(SyncDoc.serializer(), doc))
        if (!tmp.renameTo(file)) {
            file.delete()
            tmp.renameTo(file)
        }
        dirty = false
    }

    @Synchronized
    fun markDirty() { dirty = true }
    @Synchronized
    fun flushIfDirty() { if (dirty) save() }

    // ---------------- 时钟 ----------------

    @Synchronized
    fun tick(): com.bilimusic.player.sync.Hlc {
        clock = clock.tick()
        return clock
    }

    /** 收到对方的 doc 后推进本机时钟，保证以后的本机修改一定比对方新 */
    private fun observeRemote(remote: SyncDoc) {
        var max = clock
        for (t in remote.tracks.values) {
            if (t.core.ts > max) max = t.core.ts
            if (t.present.ts > max) max = t.present.ts
        }
        for (p in remote.playlists.values) {
            if (p.title.ts > max) max = p.title.ts
            if (p.present.ts > max) max = p.present.ts
            for (i in p.items.values) {
                if (i.pos.ts > max) max = i.pos.ts
                if (i.present.ts > max) max = i.present.ts
            }
        }
        for (m in remote.marks.values) if (m.loved.ts > max) max = m.loved.ts
        clock = clock.observe(max)
    }

    // ---------------- 合并 ----------------

    /** 把对方的一整份 doc 合进来，返回实际新增/变化的条数（给界面提示用） */
    @Synchronized
    fun mergeWith(remote: SyncDoc): MergeResult {
        observeRemote(remote)
        val before = doc
        // merge 本身是对称的（deviceId 取 min），合并后把本机的真实身份写回去，
        // 否则落盘的 doc.deviceId 会变成对方的，下次 generateId 就串了。
        val merged = Merger.merge(doc, remote).copy(deviceId = deviceId)
        doc = merged
        markDirty()
        return diff(before, merged)
    }

    data class MergeResult(
        val newTracks: Int,
        val newPlaylists: Int,
        val addedItems: Int,
        val changed: Boolean,
    )

    private fun diff(a: SyncDoc, b: SyncDoc): MergeResult {
        var nt = 0
        for ((k, v) in b.tracks) {
            val old = a.tracks[k]
            if (v.present.v && (old == null || !old.present.v)) nt++
        }
        var np = 0
        for ((k, v) in b.playlists) {
            val old = a.playlists[k]
            if (v.present.v && (old == null || !old.present.v)) np++
        }
        var ni = 0
        for ((k, p) in b.playlists) {
            val old = a.playlists[k]
            for ((ik, iv) in p.items) {
                if (!iv.present.v) continue
                val ov = old?.items?.get(ik)
                if (ov == null || !ov.present.v) ni++
            }
        }
        return MergeResult(nt, np, ni, a != b)
    }

    // ---------------- 曲目 ----------------

    @Synchronized
    fun upsertTrack(core: TrackCore) {
        val ts = tick()
        val cur = doc.tracks[core.key]
        // 内容没变就别动时间戳，否则每端一刷新就把对方覆盖一次，白白让时钟跑满
        if (cur != null && cur.core.v == core) return
        val entry = TrackEntry(core = Reg(core, ts, deviceId), present = Reg(true, ts, deviceId))
        doc = doc.copy(tracks = doc.tracks + (core.key to entry))
        markDirty()
    }

    @Synchronized
    fun removeTrack(key: String) {
        val cur = doc.tracks[key] ?: return
        if (!cur.present.v) return
        val ts = tick()
        doc = doc.copy(
            tracks = doc.tracks + (key to cur.copy(present = Reg(false, ts, deviceId)))
        )
        markDirty()
    }

    @Synchronized
    fun liveTracks(): List<TrackCore> =
        doc.tracks.values.filter { it.present.v }.map { it.core.v }

    @Synchronized
    fun track(key: String): TrackCore? = doc.tracks[key]?.takeIf { it.present.v }?.core?.v

    // ---------------- 歌单 ----------------

    @Synchronized
    fun createPlaylist(title: String): String {
        val ts = tick()
        var id = "p" + java.lang.Long.toString(System.currentTimeMillis(), 36) +
            (1000 + (Math.random() * 9000).toInt()).toString()
        while (doc.playlists.containsKey(id)) {
            id = "p" + java.lang.Long.toString(System.currentTimeMillis(), 36) +
                (1000 + (Math.random() * 9000).toInt()).toString()
        }
        val e = PlaylistEntry(
            id = id,
            title = Reg(title.ifBlank { "新建歌单" }, ts, deviceId),
            createdAt = System.currentTimeMillis(),
            present = Reg(true, ts, deviceId),
        )
        doc = doc.copy(playlists = doc.playlists + (id to e))
        markDirty()
        return id
    }

    @Synchronized
    fun renamePlaylist(id: String, title: String) {
        val p = doc.playlists[id] ?: return
        if (p.title.v == title) return
        val ts = tick()
        doc = doc.copy(playlists = doc.playlists + (id to p.copy(title = Reg(title, ts, deviceId))))
        markDirty()
    }

    @Synchronized
    fun deletePlaylist(id: String) {
        val p = doc.playlists[id] ?: return
        if (!p.present.v) return
        val ts = tick()
        doc = doc.copy(playlists = doc.playlists + (id to p.copy(present = Reg(false, ts, deviceId))))
        markDirty()
    }

    /** 歌单里展示用的有序曲目键列表 */
    @Synchronized
    fun itemKeys(plId: String): List<String> {
        val p = doc.playlists[plId] ?: return emptyList()
        return p.items.values
            .filter { it.present.v }
            .sortedWith(itemOrder)
            .map { it.key }
            .toList()
    }

    @Synchronized
    fun playlistTracks(plId: String): List<TrackCore> =
        itemKeys(plId).mapNotNull { track(it) }

    /** 追加到末尾；已存在则跳过 */
    @Synchronized
    fun addToPlaylist(plId: String, keys: List<String>): Int {
        val p = doc.playlists[plId] ?: return 0
        var lastPos: String? = p.items.values
            .filter { it.present.v }
            .maxWithOrNull(itemOrder)
            ?.pos?.v
        var added = 0
        var items = p.items
        for (k in keys) {
            if (items[k]?.present?.v == true) continue
            val ts = tick()
            val pos = Reg(Pos.encode(Pos.between(if (lastPos == null) null else Pos.decode(lastPos), null)), ts, deviceId)
            lastPos = pos.v
            items = items + (k to ItemEntry(k, pos, Reg(true, ts, deviceId), System.currentTimeMillis()))
            added++
        }
        if (added > 0) {
            doc = doc.copy(playlists = doc.playlists + (plId to p.copy(items = items)))
            markDirty()
        }
        return added
    }

    @Synchronized
    fun removeFromPlaylist(plId: String, key: String) {
        val p = doc.playlists[plId] ?: return
        val it = p.items[key] ?: return
        if (!it.present.v) return
        val ts = tick()
        val items = p.items + (key to it.copy(present = Reg(false, ts, deviceId)))
        doc = doc.copy(playlists = doc.playlists + (plId to p.copy(items = items)))
        markDirty()
    }

    /**
     * 把一项从 from 挪到 to：给这项算一个落在新邻居之间的位置键。
     * 只要一条记录变，不碰其余项的下标，所以两端并发拖动也不会互相踩。
     */
    @Synchronized
    fun moveItem(plId: String, from: Int, to: Int) {
        val p = doc.playlists[plId] ?: return
        val ordered = p.items.values.filter { it.present.v }.sortedWith(itemOrder)
        if (from !in ordered.indices) return
        val moved = ordered[from]
        val rest = ordered.toMutableList().also { it.removeAt(from) }
        val target = to.coerceIn(0, rest.size)
        val prev = if (target - 1 >= 0) Pos.decode(rest[target - 1].pos.v) else null
        val next = if (target < rest.size) Pos.decode(rest[target].pos.v) else null
        val ts = tick()
        val newPos = Pos.encode(Pos.between(prev, next))
        val items = p.items + (moved.key to moved.copy(pos = Reg(newPos, ts, deviceId)))
        doc = doc.copy(playlists = doc.playlists + (plId to p.copy(items = items)))
        markDirty()
    }

    @Synchronized
    fun livePlaylists(): List<PlaylistEntry> =
        doc.playlists.values.filter { it.present.v }.sortedBy { it.createdAt }

    // ---------------- 我喜欢的歌 ----------------

    @Synchronized
    fun lovedKeys(): List<String> =
        doc.marks.values.filter { it.loved.v }.sortedByDescending { it.at }.map { it.key }

    @Synchronized
    fun isLoved(key: String): Boolean = doc.marks[key]?.loved?.v == true

    @Synchronized
    fun setLoved(key: String, loved: Boolean) {
        val ts = tick()
        doc = doc.copy(marks = doc.marks + (key to MarkEntry(key, Reg(loved, ts, deviceId), System.currentTimeMillis())))
        markDirty()
    }

    // ---------------- 统计 ----------------

    data class Stats(
        val tracks: Int,
        val playlists: Int,
        val loved: Int,
        val tombstones: Int,
        val device: String,
    )

    @Synchronized
    fun stats(): Stats = Stats(
        tracks = doc.tracks.values.count { it.present.v },
        playlists = doc.playlists.values.count { it.present.v },
        loved = doc.marks.values.count { it.loved.v },
        tombstones = doc.tracks.values.count { !it.present.v } + doc.playlists.values.count { !it.present.v },
        device = deviceId,
    )

    /**
     * 导出一份文档，用于局域网交换 / 二维码 / 文本同步码。
     *
     * **必须带上墓碑**（present=false 的那些条目）。删除本身也是一次写入：
     * 只有把墓碑发给对方，对方才知道「这条被删了」；如果过滤掉，对方看到的只是
     * 「没有这条」，它本地那份还活着的拷贝就永远删不掉，删除无法传播。
     * 墓碑的回收交给 vacuum() 按天数处理，不靠导出时剥离。
     */
    @Synchronized
    fun exportCompact(): SyncDoc = doc.copy(deviceId = deviceId, at = System.currentTimeMillis())

    /**
     * 记下本机设备名，随载荷一起发出去，对端 UI 才显示得出「来自哪台设备」。
     * 换手机 / 改机型时会更新，所以只在真的变了才写盘。
     */
    @Synchronized
    fun setDeviceName(name: String) {
        if (doc.deviceName == name) return
        doc = doc.copy(deviceName = name)
        markDirty()
    }

    /** 清理超过 90 天、且确实没在用的墓碑，避免文件无限长 */
    @Synchronized
    fun vacuum(maxAgeDays: Long = 90) {
        val cutoffWall = System.currentTimeMillis() - maxAgeDays * 24L * 3600_000L
        val tracks = doc.tracks.filterValues { it.present.v || it.present.ts.wall >= cutoffWall }
        val playlists = doc.playlists
            .filterValues { it.present.v || it.present.ts.wall >= cutoffWall }
            .mapValues { (_, p) ->
                p.copy(items = p.items.filterValues { it.present.v || it.present.ts.wall >= cutoffWall })
            }
        doc = doc.copy(tracks = tracks, playlists = playlists)
        markDirty()
    }

    /** 兼容桌面端导出的 v1 歌单 JSON */
    @Synchronized
    fun importDesktopExport(root: org.json.JSONObject): Int = LegacyImport.apply(this, root)

    companion object {
        /**
         * 曲目顺序的唯一判据：先比分数位置键，同一个键（几乎不可能）再比曲目键。
         * 必须是全序且与合并顺序无关，否则两端排出来的列表会不一样。
         */
        val itemOrder: Comparator<ItemEntry> = Comparator { a, b ->
            val c = Pos.compare(Pos.decode(a.pos.v), Pos.decode(b.pos.v))
            if (c != 0) c else a.key.compareTo(b.key)
        }

        fun ensureDeviceId(prefs: android.content.SharedPreferences): String {
            val k = "device_id"
            prefs.getString(k, null)?.let { return it }
            val id = "d" + java.util.UUID.randomUUID().toString().replace("-", "").take(10)
            prefs.edit().putString(k, id).apply()
            return id
        }

        fun nameOf(deviceId: String): String = deviceId
    }
}

/** 判定「同一条记录」的辅助，供 moveItem 等使用 */
internal fun sameTs(a: Reg<*>, b: Reg<*>): Boolean = a.ts == b.ts && a.by == b.by

internal fun newer(a: Reg<*>, b: Reg<*>): Boolean = hlcGreater(a.ts, a.by, b.ts, b.by)
