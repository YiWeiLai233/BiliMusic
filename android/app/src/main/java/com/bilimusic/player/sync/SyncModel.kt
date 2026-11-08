package com.bilimusic.player.sync

import kotlinx.serialization.Serializable

/**
 * 无服务器同步的数据模型。
 *
 * 整套设计只依赖一个事实：**只要合并函数满足交换律、结合律、幂等**，
 * 那么两端各自离线改、任意顺序交换、重复交换，最终都会收敛到同一份数据。
 * 这就是 CRDT 的思路，也是不需要服务器的根本原因——没有权威副本，
 * 谁也不需要「先问服务器谁是对的」。
 *
 * 三个原语：
 *  - [Reg] 末次写入胜（LWW）：字典/标题这类「一个字段一个值」的用这个。
 *  - [ItemEntry] 带墓碑的集合成员 + 分数位置：歌单曲目用这个，删除留墓碑防止复活。
 *  - [SyncDoc] 顶层的 tracks / playlists 两张表，各自用上面的原语。
 */

/** 末次写入胜的寄存器。合并时比较 (ts, by)；完全相同则任取（内容必然相同或由 by 定序）。 */
@Serializable
data class Reg<T>(val v: T, val ts: Hlc = Hlc.ZERO, val by: String = "")

fun <T> pickReg(a: Reg<T>, b: Reg<T>): Reg<T> = if (hlcGreater(a.ts, a.by, b.ts, b.by)) a else b

/** 曲目的「身份 + 展示信息」。展示信息会随编辑传播，所以整体作为一个 LWW 值。 */
@Serializable
data class TrackCore(
    val key: String,
    /** "bili" 或 "local" */
    val type: String,
    /** bili 是 bvid（多 P 用 bvid:pN），local 是本地文件指纹 */
    val id: String,
    val bvid: String = "",
    val cid: Long = 0L,
    val page: Int = 1,
    val title: String = "",
    val artist: String = "",
    val cover: String = "",
    val duration: Long = 0L,
    /** 多 P 视频的总分 P 数，用于恢复时判断要不要展开 */
    val partCount: Int = 1,
)

/**
 * 曲目表的一项。
 * present=false 就是墓碑——不能直接删掉，否则另一台机器下次同步会把它当新增带回来。
 */
@Serializable
data class TrackEntry(
    val core: Reg<TrackCore>,
    val present: Reg<Boolean> = Reg(true),
)

/** 歌单里的一条曲目。pos 是分数位置键，脱离数组下标单独可比较。 */
@Serializable
data class ItemEntry(
    val key: String,
    /** 位置键，见 [Pos] */
    val pos: Reg<String>,
    val present: Reg<Boolean> = Reg(true),
    val addedAt: Long = 0L,
)

@Serializable
data class PlaylistEntry(
    val id: String,
    val title: Reg<String>,
    val createdAt: Long = 0L,
    val present: Reg<Boolean> = Reg(true),
    val items: Map<String, ItemEntry> = emptyMap(),
)

/** 「我喜欢的歌」的显式标记：排除表 + 手动加星，同样是 LWW。 */
@Serializable
data class MarkEntry(
    val key: String,
    /** true = 在「我喜欢的歌」里，false = 用户手动移除过 */
    val loved: Reg<Boolean>,
    val at: Long = 0L,
)

@Serializable
data class SyncDoc(
    val version: Int = 1,
    /** 生成这份文档的设备 */
    val deviceId: String = "",
    val deviceName: String = "",
    /** 文档自述的生成时间，仅用于显示 */
    val at: Long = 0L,
    val tracks: Map<String, TrackEntry> = emptyMap(),
    val playlists: Map<String, PlaylistEntry> = emptyMap(),
    val marks: Map<String, MarkEntry> = emptyMap(),
) {
    fun isEmpty(): Boolean = tracks.isEmpty() && playlists.isEmpty() && marks.isEmpty()

    /** 只保留还活着的歌单和曲目（用于导出给别人看） */
    fun compact(): SyncDoc = copy(
        tracks = tracks.filterValues { it.present.v },
        playlists = playlists.filterValues { it.present.v }
            .mapValues { (_, p) -> p.copy(items = p.items.filterValues { it.present.v }) },
    )
}

/**
 * 合并：这是整个无服务器方案的心脏。
 *
 * 逐条性质：
 *  - 交换律：每个字段都用 pickReg / 或运算 / 并集，全部对称。
 *  - 结合律：LWW 比较是偏序上的取最大，并集是取并，天然结合。
 *  - 幂等：merge(a, a) == a。
 * 所以「A 发给 B、B 改完发回 A」这种两轮往返之后，两端一定是同一份。
 */
object Merger {

    fun merge(a: SyncDoc, b: SyncDoc): SyncDoc {
        if (a === b) return a
        return SyncDoc(
            version = maxOf(a.version, b.version),
            // deviceId 是「谁在写这份文件」的本地身份，不属于要同步的内容；
            // 但 merge 必须是纯对称函数，所以这里取字典序较小者（min 满⾜交换/结合/幂等），
            // 调用方（AppLibrary）合并完会把自己真实的 id 写回去。
            deviceId = minOf(a.deviceId, b.deviceId),
            deviceName = if (a.deviceName.isNotEmpty()) a.deviceName else b.deviceName,
            at = maxOf(a.at, b.at),
            tracks = mergeMap(a.tracks, b.tracks) { x, y -> mergeTrack(x, y) },
            playlists = mergeMap(a.playlists, b.playlists) { x, y -> mergePlaylist(x, y) },
            marks = mergeMap(a.marks, b.marks) { x, y -> mergeMark(x, y) },
        )
    }

    private fun <V> mergeMap(
        a: Map<String, V>,
        b: Map<String, V>,
        f: (V, V) -> V,
    ): Map<String, V> {
        if (a.isEmpty()) return b
        if (b.isEmpty()) return a
        val out = LinkedHashMap<String, V>(a.size + b.size)
        for ((k, v) in a) {
            val other = b[k]
            out[k] = if (other == null) v else f(v, other)
        }
        for ((k, v) in b) if (!a.containsKey(k)) out[k] = v
        return out
    }

    fun mergeTrack(x: TrackEntry, y: TrackEntry): TrackEntry =
        TrackEntry(core = pickReg(x.core, y.core), present = pickReg(x.present, y.present))

    fun mergeMark(x: MarkEntry, y: MarkEntry): MarkEntry =
        MarkEntry(key = x.key, loved = pickReg(x.loved, y.loved), at = maxOf(x.at, y.at))

    fun mergePlaylist(x: PlaylistEntry, y: PlaylistEntry): PlaylistEntry {
        // 只有「present」没有被 delete 覆盖时才去并 items；墓碑之后 items 不再变化，
        // 但仍保留着，方便「撤销删除」用（见 undoDelete）。
        val items = mergeMap(x.items, y.items) { p, q -> mergeItem(p, q) }
        return PlaylistEntry(
            id = x.id,
            title = pickReg(x.title, y.title),
            createdAt = if (x.createdAt > 0) x.createdAt else y.createdAt,
            present = pickReg(x.present, y.present),
            items = items,
        )
    }

    fun mergeItem(p: ItemEntry, q: ItemEntry): ItemEntry = ItemEntry(
        key = p.key,
        pos = pickReg(p.pos, q.pos),
        present = pickReg(p.present, q.present),
        addedAt = if (p.addedAt > 0) p.addedAt else q.addedAt,
    )

    /** 合并结果里有没有实质变化（用来决定要不要落盘） */
    fun sameDoc(a: SyncDoc, b: SyncDoc): Boolean = a == b
}
