package com.bilimusic.player.sync

import com.bilimusic.player.data.AppLibrary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 复现用户报的那条路径：**手机先有自己的几首歌，再合并电脑的 47 首，然后按 UI 的
 * 取法去拿「我喜欢的歌」里的每一首**。
 *
 * ## 为什么单独写这个
 *
 * 之前所有同步测试都是「空库 ← 合并远端」或者「桌面端 fixture ↔ 安卓解码」，
 * 从来没测过「本地已有数据 + 合远端 + 用 UI 的真实取法遍历」。
 * 如果合并后某些键在 marks 里有、在 tracks 里没有，
 * [com.bilimusic.player.ui.BiliViewModel.playlistTracks] 的 `mapNotNull` 会把它们
 * **静默吞掉**，用户看到的就是「歌单里少了歌 / 点播放没地址」。
 *
 * 这个测试直接断言：合并后 marks 的每个键都能在 tracks 里取到，且 bvid/cid 可用。
 */
class MergeThenPlayTest {

    private fun tmpLib(name: String): AppLibrary {
        val dir = kotlin.io.path.createTempDirectory("bili-merge-play").toFile()
        return AppLibrary(File(dir, name))
    }

    /** 模拟手机端自己的 6 首（cid 是小数字，像早期扫描出来的） */
    private fun seedPhone(lib: AppLibrary) {
        for (i in 1..6) {
            val key = "bili:BVphone$i"
            lib.upsertTrack(
                TrackCore(
                    key = key,
                    type = "bili",
                    id = "BVphone$i",
                    bvid = "BVphone$i",
                    cid = 1000L + i,
                    page = 1,
                    title = "手机本地 $i",
                    artist = "up",
                    cover = "",
                    duration = 180,
                    partCount = 1,
                ),
            )
            lib.setLoved(key, true)
        }
    }

    /** 模拟电脑端发来的 47 首，其中含多 P 与 11 位大 cid */
    private fun remoteDoc(): SyncDoc {
        var doc = SyncDoc(version = 1, deviceId = "dpcpcpcpcp", deviceName = "PC", at = 1_000)
        for (i in 1..47) {
            val key = if (i % 7 == 0) "bili:BVpc$i:p2" else "bili:BVpc$i"
            val bvid = "BVpc$i"
            val core = TrackCore(
                key = key,
                type = "bili",
                id = if (i % 7 == 0) "BVpc$i:p2" else bvid,
                bvid = bvid,
                cid = 42_977_919_000L + i, // 超过 32 位
                page = if (i % 7 == 0) 2 else 1,
                title = "电脑 $i",
                artist = "up",
                cover = "",
                duration = 200,
                partCount = if (i % 7 == 0) 2 else 1,
            )
            doc = doc.copy(
                tracks = doc.tracks + (key to TrackEntry(
                    core = Reg(core, Hlc(500, 0), "dpcpcpcpcp"),
                    present = Reg(true, Hlc(500, 0), "dpcpcpcpcp"),
                )),
            )
            if (i <= 26) {
                doc = doc.copy(
                    marks = doc.marks + (key to MarkEntry(
                        key = key,
                        loved = Reg(true, Hlc(500, 0), "dpcpcpcpcp"),
                        at = 500,
                    )),
                )
            }
        }
        return doc
    }

    @Test
    fun merged_library_keeps_every_loved_track_retrievable() {
        val phone = tmpLib("phone.json")
        seedPhone(phone)

        val merged = phone.mergeWith(remoteDoc())
        phone.flushIfDirty()

        // 47 首远端 + 6 首本地
        assertEquals("合并后应当有 53 首曲目", 53, phone.liveTracks().size)
        assertTrue("应当报告新增曲目", merged.newTracks >= 47)

        // 关键：UI 取「我喜欢的歌」的真实路径 —— lovedKeys().mapNotNull { track(it) }
        val lovedKeys = phone.lovedKeys()
        assertTrue("喜欢里应当有 6 + 26 = 32 首", lovedKeys.size >= 32)

        var missing = 0
        for (k in lovedKeys) {
            val t = phone.track(k)
            if (t == null) {
                missing++
                continue
            }
            // 每一条都必须能拿去请求 playurl
            assertTrue("$k 的 bvid 为空", t.bvid.isNotEmpty())
            assertTrue("$k 的 cid 非正（${t.cid}）", t.cid > 0)
        }
        assertEquals("喜欢列表里有键但取不到曲目（会被 mapNotNull 静默吞掉）", 0, missing)
    }

    @Test
    fun multipage_and_large_cid_survive_merge() {
        val phone = tmpLib("phone2.json")
        seedPhone(phone)
        phone.mergeWith(remoteDoc())

        val multi = phone.track("bili:BVpc7:p2")
        assertNotNull("多 P 曲目应当在", multi)
        assertEquals(2, multi!!.page)
        assertEquals(2, multi.partCount)
        assertEquals("BVpc7", multi.bvid)
        assertEquals(42_977_919_007L, multi.cid)

        val normal = phone.track("bili:BVpc1")
        assertNotNull(normal)
        assertEquals(42_977_919_001L, normal!!.cid)
    }

    @Test
    fun merging_twice_is_idempotent_for_retrieval() {
        val phone = tmpLib("phone3.json")
        seedPhone(phone)
        phone.mergeWith(remoteDoc())
        val afterFirst = phone.liveTracks().size
        phone.mergeWith(remoteDoc())
        phone.flushIfDirty()
        assertEquals("重复合并不应改变曲目数", afterFirst, phone.liveTracks().size)
        assertEquals(afterFirst, phone.liveTracks().size)
    }

    @Test
    fun android_generated_doc_is_decodable_and_playable() {
        // 与上面同规模，但走一次完整编码/解码，覆盖真实传输链路
        val phone = tmpLib("phone4.json")
        seedPhone(phone)
        phone.mergeWith(remoteDoc())

        val text = SyncCodec.encode(phone.exportCompact())
        assertTrue("同步码不应为空", text.isNotEmpty())

        val back = SyncCodec.decode(text)
        for ((key, entry) in back.tracks) {
            if (!entry.present.v) continue
            val core = entry.core.v
            assertTrue("$key 的 bvid 为空", core.bvid.isNotEmpty())
            assertTrue("$key 的 cid 非正", core.cid > 0)
        }
        assertTrue("解码后应当仍有 53 首", back.tracks.count { it.value.present.v } >= 53)
    }
}
