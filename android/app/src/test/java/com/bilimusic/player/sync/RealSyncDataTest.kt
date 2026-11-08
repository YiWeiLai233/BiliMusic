package com.bilimusic.player.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 用**真实桌面端数据**验证「同步之后还能找到播放地址」。
 *
 * 背景：用户报告「和电脑同步歌单之后就找不到播放地址」。
 * 播放地址靠 `bvid + cid` 调 playurl 解析，缺任一个就直接报「缺少 bvid 或 cid」。
 *
 * 之前那份 fixture（gen-sync-fixture.js）里的 cid 是人造的 111 / 222，
 * 而真实的 cid 是 42977919965 这种 11 位大数 —— 小数字能过，不代表大数字能过
 * （序列化、JSON 数字精度、默认值合并，任一环节都可能把大整数处理坏）。
 *
 * 这份数据由 scripts/gen-real-sync-code.mjs 从真实 .userdata/library.json 生成，
 * 配套的 desktop-real-expect.json 是桌面端认为「这些曲目可播」的清单。
 */
class RealSyncDataTest {

    private fun realCode(): String {
        val stream = javaClass.classLoader!!.getResourceAsStream("desktop-real-sync-code.txt")
        assertNotNull("缺少 desktop-real-sync-code.txt，跑 node scripts/gen-real-sync-code.mjs 生成", stream)
        return stream!!.bufferedReader().readText().trim()
    }

    private fun expected(): List<Map<String, Any>> {
        val stream = javaClass.classLoader!!.getResourceAsStream("desktop-real-expect.json")
        assertNotNull("缺少 desktop-real-expect.json", stream)
        val text = stream!!.bufferedReader().readText()
        val arr = org.json.JSONArray(text)
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            mapOf(
                "key" to o.getString("key"),
                "bvid" to o.getString("bvid"),
                "cid" to o.getLong("cid"),
                "title" to o.optString("title"),
            )
        }
    }

    @Test
    fun real_desktop_code_decodes() {
        val doc = SyncCodec.decode(realCode())
        assertTrue("应该解出曲目", doc.tracks.isNotEmpty())
        assertEquals("REAL-PC", doc.deviceName)
        assertEquals("d0000real01", doc.deviceId)
    }

    /**
     * 核心断言：真实数据里每一条 bili 曲目，解码后 bvid 和 cid 都要还在。
     * 只要有一条 cid 变成 0，「找不到播放地址」就复现了。
     */
    @Test
    fun real_tracks_keep_bvid_and_cid() {
        val doc = SyncCodec.decode(realCode())
        val expect = expected()

        val broken = mutableListOf<String>()
        for (row in expect) {
            val key = row["key"] as String
            val entry = doc.tracks[key]
            if (entry == null) {
                broken.add("$key 不存在")
                continue
            }
            val core = entry.core.v
            if (!entry.present.v) {
                broken.add("$key 被标记为已删除")
                continue
            }
            if (core.bvid != row["bvid"]) {
                broken.add("$key bvid 变成 '${core.bvid}'（应为 '${row["bvid"]}'）")
            }
            val wantCid = row["cid"] as Long
            if (core.cid != wantCid) {
                broken.add("$key cid 变成 ${core.cid}（应为 $wantCid）")
            }
        }
        assertEquals("这些曲目同步后没法解析播放地址：\n" + broken.joinToString("\n"), 0, broken.size)
    }

    @Test
    fun real_tracks_all_have_positive_cid() {
        val doc = SyncCodec.decode(realCode())
        val zero = doc.tracks.values
            .filter { it.present.v && it.core.v.type == "bili" }
            .filter { it.core.v.cid <= 0L }
            .map { it.core.v.key }
        assertEquals("cid 为 0 会直接报「缺少 bvid 或 cid」：$zero", 0, zero.size)
    }

    @Test
    fun large_cid_survives_encode_decode_roundtrip() {
        // 真实 cid 是 11 位数字，超过 32 位整数范围，单独立一条防止被当成 Int 处理
        val big = 42_977_919_965L
        val doc = SyncDoc(
            deviceId = "dtest",
            tracks = mapOf(
                "bili:BV1Lknb6fEnH" to TrackEntry(
                    core = Reg(
                        TrackCore(
                            key = "bili:BV1Lknb6fEnH", type = "bili", id = "BV1Lknb6fEnH",
                            bvid = "BV1Lknb6fEnH", cid = big, page = 1, title = "t",
                        )
                    ),
                    present = Reg(true),
                )
            ),
        )
        val back = SyncCodec.decode(SyncCodec.encode(doc))
        assertEquals("大整数 cid 在编解码中损坏了", big, back.tracks["bili:BV1Lknb6fEnH"]!!.core.v.cid)
    }

    @Test
    fun real_data_merges_into_an_empty_library_without_losing_cid() {
        // 模拟手机端第一次接收电脑的库：合并进一个空库
        val dir = kotlin.io.path.createTempDirectory("bili-real-sync").toFile()
        try {
            val phone = com.bilimusic.player.data.AppLibrary(File(dir, "phone.json"))
            phone.load("d0000phone")
            val remote = SyncCodec.decode(realCode())
            phone.mergeWith(remote)

            val missing = phone.liveTracks()
                .filter { it.type == "bili" }
                .filter { it.cid <= 0L || it.bvid.isEmpty() }
                .map { it.key }
            assertEquals("合并后这些曲目丢了播放字段：$missing", 0, missing.size)
            assertTrue("应该合并进曲目", phone.liveTracks().size >= 40)
        } finally {
            dir.deleteRecursively()
        }
    }
}
