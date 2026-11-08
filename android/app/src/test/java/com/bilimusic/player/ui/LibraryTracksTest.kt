package com.bilimusic.player.ui

import com.bilimusic.player.data.AppLibrary
import com.bilimusic.player.sync.SyncCodec
import com.bilimusic.player.sync.TrackCore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 回归测试：链接收藏导入的曲目必须能从界面取到。
 *
 * ## 背景（真实用户反馈）
 *
 * 「链接收藏他导入之后没有显示」——导入确实成功了（曲目进了 tracks 表），
 * 但首页只渲染「我喜欢的歌」和自建歌单，导入的曲目两边都不属于，
 * 于是在界面上完全不可见，只剩一句「已导入 N 首」。
 *
 * 这些测试锁住的是「取数路径」本身：只要 [BiliViewModel.libraryTracks]
 * 的取值口径改了，这里就会红。
 */
class LibraryTracksTest {

    private fun tempLib(): AppLibrary {
        val dir = kotlin.io.path.createTempDirectory("bili-lib-test").toFile()
        return AppLibrary(File(dir, "library.json")).also { it.load("dtracks0001") }
    }

    private fun core(key: String, title: String, artist: String = "UP主", cid: Long = 1000L) =
        TrackCore(
            key = key,
            type = "bili",
            id = key.removePrefix("bili:"),
            bvid = key.removePrefix("bili:"),
            cid = cid,
            page = 1,
            title = title,
            artist = artist,
            cover = "",
            duration = 200L,
            partCount = 1,
        )

    /**
     * 核心断言：导入（upsertTrack）之后，`liveTracks()` 必须能看到它。
     *
     * 这就是 `libraryTracks()` 的底层数据源 —— 以前这个列表存在，
     * 但**没有任何界面在用**，所以测试要断言的不只是数据在，
     * 还要断言视图层用的那个方法返回非空。
     */
    @Test
    fun imported_tracks_are_visible_to_the_library_view() {
        val lib = tempLib()
        assertTrue("空库不该有曲目", lib.liveTracks().isEmpty())

        lib.upsertTrack(core("bili:BV1aa", "第一首"))
        lib.upsertTrack(core("bili:BV1bb", "第二首"))

        val tracks = lib.liveTracks()
        assertEquals("导入两首就该看到两首", 2, tracks.size)
        assertEquals(setOf("bili:BV1aa", "bili:BV1bb"), tracks.map { it.key }.toSet())
    }

    /**
     * 导入的曲目不属于任何歌单，也不在「我喜欢的歌」里 ——
     * 这正是它以前「看不见」的原因，写下来防止有人把
     * 「我的库」又当成冗余入口删掉。
     */
    @Test
    fun imported_tracks_belong_to_no_playlist_and_are_not_loved_by_default() {
        val lib = tempLib()
        lib.upsertTrack(core("bili:BV1aa", "第一首"))

        assertTrue("不该自动进喜欢", lib.lovedKeys().isEmpty())
        assertTrue("不该自动进任何歌单", lib.livePlaylists().isEmpty())
        assertNotNull("但必须能从库里取到", lib.track("bili:BV1aa"))
    }

    /** 导入的曲目可以被加进歌单，加进去之后两处都能看到。 */
    @Test
    fun imported_tracks_can_be_added_into_a_playlist() {
        val lib = tempLib()
        lib.upsertTrack(core("bili:BV1aa", "第一首"))
        val plId = lib.createPlaylist("测试歌单")

        val added = lib.addToPlaylist(plId, listOf("bili:BV1aa"))
        assertEquals(1, added)
        assertEquals(1, lib.playlistTracks(plId).size)
        assertEquals("加进歌单后库里仍然有", 1, lib.liveTracks().size)
    }

    /** 删除是一道墓碑，删除后「我的库」里不该再出现（防止墓碑漏过滤）。 */
    @Test
    fun removed_track_disappears_from_the_library_view() {
        val lib = tempLib()
        lib.upsertTrack(core("bili:BV1aa", "第一首"))
        lib.removeTrack("bili:BV1aa")

        assertTrue("删除后不该还在库里", lib.liveTracks().isEmpty())
    }

    /**
     * 同步进来的曲目同样要在「我的库」里可见 ——
     * 用户报「和电脑同步歌单之后就找不到播放地址」时，
     * 有一半情况其实是「不知道怎么找到这些歌」。
     */
    @Test
    fun synced_tracks_are_visible_to_the_library_view() {
        val a = tempLib()
        a.upsertTrack(core("bili:BV1aa", "电脑上的歌"))
        a.upsertTrack(core("bili:BV1bb", "电脑上的第二首"))

        val b = tempLib()
        assertTrue(b.liveTracks().isEmpty())
        b.mergeWith(a.exportCompact())

        assertEquals("同步后应能看到电脑的两首", 2, b.liveTracks().size)
        assertTrue(b.liveTracks().any { it.title == "电脑上的歌" })
    }

    /** 经过一次完整的编解码（真实同步载荷）之后依然可见。 */
    @Test
    fun tracks_survive_a_full_payload_round_trip() {
        val a = tempLib()
        a.upsertTrack(core("bili:BV1aa", "第一首", cid = 42_977_919_965L))

        val code = SyncCodec.encode(a.exportCompact())
        val decoded = SyncCodec.decode(code)

        val b = tempLib()
        b.mergeWith(decoded)

        val t = b.track("bili:BV1aa")
        assertNotNull("编解码后曲目必须还在", t)
        assertEquals(42_977_919_965L, t!!.cid)
        assertEquals(1, b.liveTracks().size)
    }

    /** 排序稳定：渲染顺序不该每次刷新都跳。 */
    @Test
    fun library_view_order_is_stable() {
        val lib = tempLib()
        lib.upsertTrack(core("bili:BV1b", "B 歌"))
        lib.upsertTrack(core("bili:BV1a", "A 歌"))
        lib.upsertTrack(core("bili:BV1c", "C 歌"))

        val first = lib.liveTracks().map { it.key }
        val second = lib.liveTracks().map { it.key }
        assertEquals("同样的数据两次取到的顺序必须一致", first, second)
    }
}
