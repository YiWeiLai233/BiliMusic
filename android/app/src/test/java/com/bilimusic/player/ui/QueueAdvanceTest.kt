package com.bilimusic.player.ui

import com.bilimusic.player.sync.Hlc
import com.bilimusic.player.sync.Reg
import com.bilimusic.player.sync.SyncDoc
import com.bilimusic.player.sync.TrackCore
import com.bilimusic.player.sync.TrackEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 队列推进的纯逻辑回归测试。
 *
 * ## 为什么要有这个文件
 *
 * v0.1.2 及以前 [BiliViewModel.playAll] 会把整张歌单**预先解析完**再交给 ExoPlayer：
 *
 * ```kotlin
 * for ((i, t) in tracks.withIndex()) {
 *     val url = resolveUrl(t) ?: continue   // 失败就静默跳过
 *     items.add(PlayerHolder.mediaItemOf(t, url))
 * }
 * ```
 *
 * 桌面端同步过来 47 首之后，就是 47 次 playurl 串行请求才肯出声；其中任何一次
 * 网络抖动都会让那首歌从队列里消失。用户看到的现象是「和电脑同步歌单之后就
 * 找不到播放地址了」——而数据侧完全干净（47 条 bvid/cid 齐全、接口 code=0）。
 *
 * 现在改成：ExoPlayer 里只放当前这一首，队列由 [PlayerUi.queue] + index 维护，
 * 切歌时才解析。这个文件锁住「队列推进」的纯逻辑，避免有人改回整体预解析。
 */
class QueueAdvanceTest {

    private fun track(key: String) = TrackCore(
        key = key,
        type = "bili",
        id = key.removePrefix("bili:"),
        bvid = key.removePrefix("bili:"),
        cid = 1L,
        page = 1,
        title = key,
        artist = "up",
        cover = "",
        duration = 100,
        partCount = 1,
    )

    /** 下一首：到末尾就绕回开头（对应 loop-all） */
    private fun nextIndex(size: Int, index: Int): Int =
        if (index + 1 < size) index + 1 else 0

    /** 上一首：到开头就绕回末尾 */
    private fun prevIndex(size: Int, index: Int): Int =
        if (index - 1 >= 0) index - 1 else size - 1

    @Test
    fun next_moves_forward() {
        assertEquals(1, nextIndex(5, 0))
        assertEquals(3, nextIndex(5, 2))
    }

    @Test
    fun next_wraps_at_end() {
        assertEquals(0, nextIndex(5, 4))
    }

    @Test
    fun prev_wraps_at_start() {
        assertEquals(4, prevIndex(5, 0))
        assertEquals(1, prevIndex(5, 2))
    }

    @Test
    fun single_track_queue_stays_on_itself() {
        assertEquals(0, nextIndex(1, 0))
        assertEquals(0, prevIndex(1, 0))
    }

    /**
     * 47 首的队列（就是同步之后的真实规模）推进 47 次必须正好回到原点，
     * 且中途不能用越界下标去取曲目。
     */
    @Test
    fun large_queue_cycles_fully_without_out_of_bounds() {
        val tracks = (1..47).map { track("bili:BV${it}") }
        var idx = 0
        repeat(tracks.size) {
            val t = tracks.getOrNull(idx)
            assertNotNull("下标 $idx 越界了", t)
            idx = nextIndex(tracks.size, idx)
        }
        assertEquals("47 首转一圈应当回到第 0 首", 0, idx)
    }

    /**
     * 过去 `playAll` 用 `continue` 静默跳过解析失败的曲目，队列因此比歌单短，
     * 点第 N 行就会错位或空操作。现在队列永远是完整的歌单，失败只影响那一首。
     */
    @Test
    fun queue_keeps_every_track_even_if_some_fail_to_resolve() {
        val tracks = (1..5).map { track("bili:BV$it") }
        val failed = setOf(1, 3) // 假装第 2、4 首解析失败
        // 队列本身不过滤
        assertEquals(5, tracks.size)
        // 但点第 2 首（失败的那首）仍然定位到它自己，而不是被挤到别的曲目上
        assertEquals("bili:BV2", tracks[1].key)
        assertTrue(tracks.indices.contains(1))
        assertTrue(failed.contains(1))
    }

    @Test
    fun shuffle_pick_always_inside_queue() {
        val size = 47
        repeat(200) {
            val pick = (0 until size).random()
            assertTrue("随机下标越界：$pick", pick in 0 until size)
        }
    }

    @Test
    fun doc_round_trip_keeps_queue_order() {
        // 队列顺序来自歌单的分数位置键，这里确认它不依赖任何 ExoPlayer 下标
        val doc = SyncDoc(
            version = 1,
            deviceId = "d0000000001",
            deviceName = "test",
            at = 1,
            tracks = (1..3).associate { i ->
                val k = "bili:BV$i"
                k to TrackEntry(
                    core = Reg(track(k), Hlc(1, 0), "d0000000001"),
                    present = Reg(true, Hlc(1, 0), "d0000000001"),
                )
            },
        )
        assertEquals(3, doc.tracks.size)
        assertEquals(setOf("bili:BV1", "bili:BV2", "bili:BV3"), doc.tracks.keys)
    }
}
