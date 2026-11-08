package com.bilimusic.player.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 这些测试是整个「无服务器同步」的合同：
 * 合并必须满足交换律 / 结合律 / 幂等，否则两端会永久分叉。
 */
class SyncMergeTest {

    private fun track(key: String, title: String, ts: Long, by: String): TrackEntry =
        TrackEntry(core = Reg(TrackCore(key = key, type = "bili", id = key.substringAfter(":"), title = title), Hlc(ts, 0), by))

    private fun item(key: String, pos: String, ts: Long, by: String): ItemEntry =
        ItemEntry(key = key, pos = Reg(pos, Hlc(ts, 0), by))

    private fun playlist(id: String, title: String, ts: Long, by: String, items: Map<String, ItemEntry>) =
        PlaylistEntry(id = id, title = Reg(title, Hlc(ts, 0), by), createdAt = ts, items = items)

    // ---------- 交换律 / 结合律 / 幂等 ----------

    @Test
    fun merge_is_commutative() {
        val a = SyncDoc(
            deviceId = "A",
            tracks = mapOf("bili:BV1" to track("bili:BV1", "歌一", 100, "A")),
            playlists = mapOf("p1" to playlist("p1", "我的歌单", 100, "A", mapOf("bili:BV1" to item("bili:BV1", "10", 100, "A")))),
        )
        val b = SyncDoc(
            deviceId = "B",
            tracks = mapOf("bili:BV2" to track("bili:BV2", "歌二", 200, "B")),
            playlists = mapOf("p1" to playlist("p1", "我的歌单", 100, "A", mapOf("bili:BV2" to item("bili:BV2", "20", 200, "B")))),
        )
        assertEquals(Merger.merge(a, b), Merger.merge(b, a))
    }

    @Test
    fun merge_is_associative() {
        val a = SyncDoc(tracks = mapOf("bili:BV1" to track("bili:BV1", "A1", 100, "A")))
        val b = SyncDoc(tracks = mapOf("bili:BV1" to track("bili:BV1", "B1", 200, "B")))
        val c = SyncDoc(tracks = mapOf("bili:BV1" to track("bili:BV1", "C1", 150, "C")))
        assertEquals(
            Merger.merge(Merger.merge(a, b), c),
            Merger.merge(a, Merger.merge(b, c)),
        )
    }

    @Test
    fun merge_is_idempotent() {
        val a = SyncDoc(
            tracks = mapOf("bili:BV1" to track("bili:BV1", "歌一", 100, "A")),
            playlists = mapOf("p1" to playlist("p1", "单", 100, "A", mapOf("bili:BV1" to item("bili:BV1", "10", 100, "A")))),
            marks = mapOf("bili:BV1" to MarkEntry("bili:BV1", Reg(true, Hlc(100, 0), "A"))),
        )
        assertEquals(a, Merger.merge(a, a))
        assertEquals(a, Merger.merge(Merger.merge(a, a), a))
    }

    @Test
    fun concurrent_edit_resolves_to_later_timestamp() {
        val a = SyncDoc(tracks = mapOf("k" to track("k", "旧标题", 100, "A")))
        val b = SyncDoc(tracks = mapOf("k" to track("k", "新标题", 200, "B")))
        val m = Merger.merge(a, b)
        assertEquals("新标题", m.tracks["k"]!!.core.v.title)
        assertEquals("新标题", Merger.merge(b, a).tracks["k"]!!.core.v.title)
    }

    @Test
    fun same_timestamp_breaks_tie_by_device() {
        val a = SyncDoc(tracks = mapOf("k" to track("k", "A 的标题", 100, "devA")))
        val b = SyncDoc(tracks = mapOf("k" to track("k", "B 的标题", 100, "devB")))
        // 固定次序，两端结论一致（这里 devB > devA，取 B）
        assertEquals("B 的标题", Merger.merge(a, b).tracks["k"]!!.core.v.title)
        assertEquals("B 的标题", Merger.merge(b, a).tracks["k"]!!.core.v.title)
    }

    // ---------- 墓碑会阻止「删除的又回来」 ----------

    @Test
    fun tombstone_prevents_resurrection() {
        val alive = SyncDoc(tracks = mapOf("k" to TrackEntry(
            core = Reg(TrackCore(key = "k", type = "bili", id = "BV1", title = "歌"), Hlc(100, 0), "A"),
            present = Reg(true, Hlc(100, 0), "A"),
        )))
        val deleted = SyncDoc(tracks = mapOf("k" to TrackEntry(
            core = Reg(TrackCore(key = "k", type = "bili", id = "BV1", title = "歌"), Hlc(100, 0), "A"),
            present = Reg(false, Hlc(200, 0), "A"),
        )))
        val m = Merger.merge(alive, deleted)
        assertTrue("删除必须生效", !m.tracks["k"]!!.present.v)
        assertTrue("反向合并也一样", !Merger.merge(deleted, alive).tracks["k"]!!.present.v)
    }

    @Test
    fun undo_delete_wins_if_newer() {
        val deleted = SyncDoc(tracks = mapOf("k" to TrackEntry(
            core = Reg(TrackCore(key = "k", type = "bili", id = "BV1"), Hlc(100, 0), "A"),
            present = Reg(false, Hlc(900, 0), "A"),
        )))
        val reAdded = SyncDoc(tracks = mapOf("k" to TrackEntry(
            core = Reg(TrackCore(key = "k", type = "bili", id = "BV1"), Hlc(950, 0), "B"),
            present = Reg(true, Hlc(950, 0), "B"),
        )))
        assertTrue(Merger.merge(deleted, reAdded).tracks["k"]!!.present.v)
    }

    // ---------- 两个设备同时加歌，都要在 ----------

    @Test
    fun concurrent_adds_both_survive() {
        val a = SyncDoc(playlists = mapOf("p" to playlist("p", "单", 1, "A",
            mapOf("bili:1" to item("bili:1", "a0", 10, "A")))))
        val b = SyncDoc(playlists = mapOf("p" to playlist("p", "单", 1, "A",
            mapOf("bili:2" to item("bili:2", "a1", 20, "B")))))
        val items = Merger.merge(a, b).playlists["p"]!!.items
        assertTrue(items.containsKey("bili:1"))
        assertTrue(items.containsKey("bili:2"))
        assertEquals(2, items.size)
    }

    // ---------- 位置键 ----------

    @Test
    fun pos_between_is_strictly_ordered() {
        val p = Pos.between(null, null)
        val q = Pos.between(p, null)
        val r = Pos.between(null, q)
        assertTrue(Pos.compare(p, q) < 0)
        assertTrue(Pos.compare(r, q) < 0)
        assertTrue(Pos.compare(r, p) < 0)
    }

    @Test
    fun pos_can_split_same_gap_many_times() {
        val lo = Pos.between(null, null)
        var hi = Pos.between(lo, null)
        val seen = ArrayList<String>()
        repeat(40) {
            // 每次都往 lo..hi 这个缝隙里插，新值必须严格落在这两者之间
            val mid = Pos.between(lo, hi)
            seen.add(Pos.encode(mid))
            assertTrue(
                "第 $it 次插入没有落在左邻居右边：${Pos.encode(lo)} vs ${seen.last()}",
                Pos.compare(lo, mid) < 0,
            )
            assertTrue(
                "第 $it 次插入没有落在右邻居左边：${seen.last()} vs ${Pos.encode(hi)}",
                Pos.compare(mid, hi) < 0,
            )
            hi = mid
        }
        // 反复往同一缝隙插会不断加深坐标，但顺序必须始终严格递减（越插越靠前）
        for (i in 1 until seen.size) {
            assertTrue(
                "第 $i 次插入破坏了顺序：${seen[i - 1]} vs ${seen[i]}",
                Pos.compare(Pos.decode(seen[i]), Pos.decode(seen[i - 1])) < 0,
            )
        }
        // 换一个方向：固定右邻居，往左边一路插，序列应严格递增
        val right = Pos.between(lo, null)
        var left = Pos.between(lo, right)
        var prev = left
        repeat(20) {
            val mid = Pos.between(left, right)
            assertTrue(Pos.compare(prev, mid) < 0)
            assertTrue(Pos.compare(mid, right) < 0)
            left = mid
            prev = mid
        }
    }

    @Test
    fun pos_roundtrip() {
        for (s in listOf("0", "1.2", "z.k", "1.0.5")) {
            assertEquals(s, Pos.encode(Pos.decode(s)))
        }
    }

    @Test
    fun pos_between_adjacent_values_does_not_loop() {
        val a = intArrayOf(5)
        val b = intArrayOf(6)
        val m = Pos.between(a, b)
        assertTrue(Pos.compare(a, m) < 0)
        assertTrue(Pos.compare(m, b) < 0)
    }

    // ---------- 编解码 ----------

    private fun sampleDoc(): SyncDoc {
        val tracks = LinkedHashMap<String, TrackEntry>()
        for (i in 0 until 60) {
            val k = "bili:BV1xx411c7m$i"
            tracks[k] = TrackEntry(
                core = Reg(TrackCore(key = k, type = "bili", id = k.substringAfter(":"), bvid = "BV$i", title = "第 $i 首歌的名字有点长", artist = "UP 主 $i", duration = 200 + i.toLong()), Hlc(1000L + i, 0), "devA"),
                present = Reg(true, Hlc(1000L + i, 0), "devA"),
            )
        }
        val items = LinkedHashMap<String, ItemEntry>()
        tracks.keys.forEachIndexed { i, k -> items[k] = item(k, Pos.encode(Pos.between(null, null)) + "." + i, 2000L + i, "devA") }
        return SyncDoc(
            deviceId = "devA",
            deviceName = "我的手机",
            at = 123456789L,
            tracks = tracks,
            playlists = mapOf("p1" to PlaylistEntry("p1", Reg("通勤", Hlc(2000, 0), "devA"), 2000L, Reg(true), items)),
            marks = mapOf("bili:BV1" to MarkEntry("bili:BV1", Reg(true, Hlc(3000, 0), "devA"))),
        )
    }

    @Test
    fun codec_roundtrip_keeps_everything() {
        val doc = sampleDoc()
        val text = SyncCodec.encode(doc)
        val back = SyncCodec.decode(text)
        assertEquals(doc, back)
    }

    @Test
    fun codec_compresses_repetitive_payload() {
        val doc = sampleDoc()
        val raw = SyncCodec.json.encodeToString(SyncDoc.serializer(), doc).toByteArray()
        val packed = SyncCodec.pack(doc)
        assertTrue("压缩后应该明显更小：raw=${raw.size} packed=${packed.size}", packed.size < raw.size)
        assertEquals(doc, SyncCodec.unpack(packed))
    }

    @Test
    fun codec_rejects_corrupted_payload() {
        val text = SyncCodec.encode(sampleDoc())
        val broken = text.substring(0, text.length - 4) + "AAAA"
        var threw = false
        try {
            SyncCodec.decode(broken)
        } catch (e: SyncException) {
            threw = true
        }
        assertTrue("坏数据必须被拒绝", threw)
    }

    @Test
    fun codec_rejects_foreign_text() {
        var threw = false
        try {
            SyncCodec.decode("这不是同步码")
        } catch (e: SyncException) {
            threw = true
        }
        assertTrue(threw)
    }

    @Test
    fun chunked_qr_reassembles_in_any_order() {
        val doc = sampleDoc()
        val chunks = SyncCodec.packChunks(doc, 900)
        assertTrue("样本应该被切成多片：${chunks.size}", chunks.size > 1)

        val asm = SyncCodec.ChunkAssembler()
        // 乱序喂进去
        for (c in chunks.shuffled()) asm.offer(c)
        assertTrue(asm.complete)
        assertEquals(doc, asm.assemble())
    }

    @Test
    fun chunk_assembler_reports_progress() {
        val chunks = SyncCodec.packChunks(sampleDoc(), 900)
        val asm = SyncCodec.ChunkAssembler()
        assertEquals(0, asm.received)
        assertTrue(asm.offer(chunks[0]))
        assertEquals(1, asm.received)
        assertEquals(chunks.size, asm.expected)
        assertTrue("重复扫同一片不算新片", !asm.offer(chunks[0]))
        assertEquals(1, asm.received)
    }

    @Test
    fun chunk_assembler_detects_missing_piece() {
        val chunks = SyncCodec.packChunks(sampleDoc(), 900)
        val asm = SyncCodec.ChunkAssembler()
        for (c in chunks.dropLast(1)) asm.offer(c)
        assertTrue(!asm.complete)
        var threw = false
        try {
            asm.assemble()
        } catch (e: SyncException) {
            threw = true
        }
        assertTrue(threw)
    }

    // ---------- HLC ----------

    @Test
    fun hlc_is_monotonic_even_when_clock_goes_backwards() {
        var c = Hlc(1000, 0)
        c = c.tick(1000)
        val a = c
        c = c.tick(500) // 系统时间倒退
        assertTrue(c > a)
    }

    @Test
    fun hlc_observing_remote_moves_forward() {
        val local = Hlc(1000, 0)
        val remote = Hlc(5000, 3)
        val after = local.observe(remote, 1200)
        assertTrue(after > remote)
    }

    @Test
    fun hlc_reproduces_the_lsh_algorithm() {
        // 同一毫秒内的两次事件：counter 递增而不是相等
        val a = Hlc(1000, 5).tick(1000)
        assertEquals(1000L, a.wall)
        assertEquals(6, a.counter)
    }

    // ---------- 三端收敛（模拟真实往返） ----------

    @Test
    fun three_devices_converge_after_two_round_trips() {
        val base = SyncDoc(
            tracks = mapOf(
                "bili:A" to track("bili:A", "A", 10, "X"),
                "bili:B" to track("bili:B", "B", 10, "X"),
            ),
            playlists = mapOf("p" to playlist("p", "歌单", 10, "X",
                mapOf("bili:A" to item("bili:A", "10", 10, "X"), "bili:B" to item("bili:B", "20", 10, "X")))),
        )
        // 手机端：删掉 A 的歌单条目、改歌单名
        val phone = Merger.merge(base, SyncDoc(
            playlists = mapOf("p" to playlist("p", "通勤歌单", 50, "phone",
                mapOf("bili:A" to item("bili:A", "10", 10, "X").copy(present = Reg(false, Hlc(50, 0), "phone")))))),
        )
        // 平板端：加一首 C，删掉歌单 B 条目
        val tablet = Merger.merge(base, SyncDoc(
            tracks = mapOf("bili:C" to track("bili:C", "C", 60, "tablet")),
            playlists = mapOf("p" to playlist("p", "歌单", 10, "X",
                mapOf(
                    "bili:B" to item("bili:B", "20", 10, "X").copy(present = Reg(false, Hlc(60, 0), "tablet")),
                    "bili:C" to item("bili:C", "30", 60, "tablet"),
                ))),
        ))
        // 桌面端：什么都不动
        val desktop = base

        // 任意顺序互相同步一轮 → 两端必须一致
        val all = Merger.merge(Merger.merge(phone, tablet), desktop)
        assertEquals(all, Merger.merge(Merger.merge(desktop, tablet), phone))
        assertEquals(all, Merger.merge(Merger.merge(tablet, desktop), phone))

        val items = all.playlists["p"]!!.items.filterValues { it.present.v }
        assertEquals("只剩 C", setOf("bili:C"), items.keys)
        assertEquals("通勤歌单", all.playlists["p"]!!.title.v)
        assertNotNull(all.tracks["bili:C"])
    }

    // ---------- 删除必须能传播出去（回归测试） ----------

    /**
     * 曾经的真实 bug：导出时把 present=false 的墓碑过滤掉了。
     *
     * 于是删掉一首歌之后，对端收到的载荷里「没有这条」而不是「这条被删了」，
     * 它本地那份还活着的拷贝永远删不掉 —— 删除永远传播不了。
     * 这里锁死行为：导出必须带上墓碑。
     */
    @Test
    fun export_keeps_tombstones_so_deletion_propagates() {
        val dir = kotlin.io.path.createTempDirectory("bili-sync-test").toFile()
        try {
            val a = com.bilimusic.player.data.AppLibrary(java.io.File(dir, "a.json"))
            a.load("devA")
            val core = TrackCore(key = "bili:BV1", type = "bili", id = "BV1", bvid = "BV1", title = "会被删的")
            a.upsertTrack(core)

            val b = com.bilimusic.player.data.AppLibrary(java.io.File(dir, "b.json"))
            b.load("devB")
            b.mergeWith(a.exportCompact())
            assertNotNull("删除前 B 应该有这首歌", b.track("bili:BV1"))

            // A 删掉，然后把导出载荷发给 B
            a.removeTrack("bili:BV1")
            val payload = a.exportCompact()
            assertTrue("导出的载荷里必须留着墓碑", payload.tracks["bili:BV1"]?.present?.v == false)

            b.mergeWith(payload)
            assertEquals("删除应当传播到 B", null, b.track("bili:BV1"))
        } finally {
            dir.deleteRecursively()
        }
    }

    // ---------- 与桌面端的真实互通 ----------

    /**
     * 解一份**桌面端 Node 实现真正写出来的**同步码。
     *
     * 各自跑自己的 roundtrip 是证明不了互通的：那样两端可能只是各自自洽。
     * 这里有固定样例（scripts/gen-sync-fixture.js 生成），一旦哪端的
     * 字段名 / 编解码变了，这个测试立刻红。
     */
    @Test
    fun can_decode_fixture_produced_by_desktop() {
        val text = javaClass.classLoader!!.getResourceAsStream("desktop-sync-code.txt")
            ?.bufferedReader()?.use { it.readText() }?.trim()
        assertNotNull("缺少 fixture，先跑 node scripts/gen-sync-fixture.js", text)
        assertTrue("fixture 不能为空", text!!.isNotEmpty())

        val doc = SyncCodec.decode(text)
        assertEquals("FIXTURE-PC", doc.deviceName)
        assertEquals("d0000000001", doc.deviceId)

        // 两首曲目，其中一首是多 P 的第 2 P
        assertEquals(2, doc.tracks.count { it.value.present.v })
        val p2 = doc.tracks["bili:BV1fx411c7mD:p2"]?.core?.v
        assertNotNull("多 P 曲目必须能被安卓读出来", p2)
        assertEquals(2, p2!!.page)
        assertEquals(2, p2.partCount)
        assertEquals("夜曲 · P2 伴奏版", p2.title)

        // 两个歌单，顺序按导出时的排列
        val commute = doc.playlists.values.firstOrNull { it.title.v == "通勤" }
        assertNotNull("歌单「通勤」应当存在", commute)
        val keys = commute!!.items.values.filter { it.present.v }
            .sortedWith(Comparator { x, y -> Pos.compare(Pos.decode(x.pos.v), Pos.decode(y.pos.v)) })
            .map { it.key }
        assertEquals(listOf("bili:BV1fx411c7mD", "bili:BV1fx411c7mD:p2"), keys)

        // 爱心也是一条被同步的事实
        assertEquals(true, doc.marks["bili:BV1fx411c7mD"]?.loved?.v)
    }

    /**
     * 反向：用固定内容生成一份「安卓写出来的同步码」，落到 build 目录。
     *
     * 桌面端仓库里的 fixtures/android-sync-code.txt 就是从这里复制过去的，
     * 让 node scripts/test-sync.js 能验证「Node 能解安卓的字节」。
     * 需要重新生成时删掉 fixtures 里那份，跑一遍这个测试再复制即可。
     */
    @Test
    fun write_fixture_for_desktop() {
        val dir = kotlin.io.path.createTempDirectory("bili-android-fixture").toFile()
        try {
            val lib = com.bilimusic.player.data.AppLibrary(java.io.File(dir, "library.json"))
            lib.load("d0000000002")
            lib.setDeviceName("FIXTURE-ANDROID")
            val single = TrackCore(
                key = "bili:BV1fx411c7mD", type = "bili", id = "BV1fx411c7mD", bvid = "BV1fx411c7mD",
                cid = 111, page = 1, title = "夜曲", artist = "周同学",
                cover = "https://i0.hdslb.com/bfs/archive/a.jpg", duration = 227, partCount = 1,
            )
            val multi = TrackCore(
                key = "bili:BV1fx411c7mD:p2", type = "bili", id = "BV1fx411c7mD:p2", bvid = "BV1fx411c7mD",
                cid = 222, page = 2, title = "夜曲 · P2 伴奏版", artist = "周同学",
                cover = "https://i0.hdslb.com/bfs/archive/a.jpg", duration = 225, partCount = 2,
            )
            lib.upsertTrack(single)
            lib.upsertTrack(multi)

            val commute = lib.createPlaylist("通勤")
            lib.addToPlaylist(commute, listOf("bili:BV1fx411c7mD", "bili:BV1fx411c7mD:p2"))
            val night = lib.createPlaylist("深夜")
            lib.addToPlaylist(night, listOf("bili:BV1fx411c7mD:p2"))
            lib.setLoved("bili:BV1fx411c7mD", true)

            val code = SyncCodec.encode(lib.exportCompact())
            val out = java.io.File(System.getProperty("user.dir"), "build/android-sync-code.txt")
            out.parentFile?.mkdirs()
            out.writeText(code, Charsets.UTF_8)
            println("[fixture] $out (${code.length} chars)")
            assertTrue(code.isNotEmpty())
        } finally {
            dir.deleteRecursively()
        }
    }

    /**
     * 并发保护的回归测试。
     *
     * 同步服务端是固定 4 线程池，主动同步和「吃同步码」又各起裸线程，
     * 两台设备同时连过来时会有多个线程一起改同一份 doc。没有锁就是
     * 「读 doc → 算 → 写 doc」的丢更新，并且多个线程同时往同一个 .tmp
     * 里写还会把库文件写坏。
     *
     * 这里用 8 个线程各写 50 次，跑完断言没有丢：曲目全在、每首歌单的
     * 条目数正好是 50，且文件能被正常解析回来。
     */
    @Test
    fun concurrent_writes_do_not_lose_updates() {
        val dir = kotlin.io.path.createTempDirectory("bili-concurrent").toFile()
        try {
            val lib = com.bilimusic.player.data.AppLibrary(java.io.File(dir, "library.json"))
            lib.load("d0000000009")
            val pl = lib.createPlaylist("并发")

            val threads = 8
            val per = 50
            val start = java.util.concurrent.CountDownLatch(1)
            val done = java.util.concurrent.CountDownLatch(threads)
            val errors = java.util.concurrent.ConcurrentLinkedQueue<Throwable>()

            for (t in 0 until threads) {
                Thread {
                    try {
                        start.await()
                        for (i in 0 until per) {
                            val n = t * per + i
                            lib.upsertTrack(
                                TrackCore(
                                    key = "bili:BV$n", type = "bili", id = "BV$n", bvid = "BV$n",
                                    title = "曲 $n", artist = "UP", duration = 100,
                                )
                            )
                            lib.addToPlaylist(pl, listOf("bili:BV$n"))
                            if (n % 10 == 0) lib.flushIfDirty()
                        }
                    } catch (e: Throwable) {
                        errors.add(e)
                    } finally {
                        done.countDown()
                    }
                }.start()
            }
            start.countDown()
            assertTrue("并发写入超时", done.await(60, java.util.concurrent.TimeUnit.SECONDS))
            assertEquals("并发写入抛异常: ${errors.firstOrNull()}", 0, errors.size)

            lib.flushIfDirty()

            val total = threads * per
            assertEquals("曲目丢了", total, lib.stats().tracks)
            assertEquals("歌单条目丢了", total, lib.itemKeys(pl).size)

            // 落盘结果必须还能解析回来（没被并发写坏）
            val again = com.bilimusic.player.data.AppLibrary(java.io.File(dir, "library.json"))
            again.load("d0000000009")
            assertEquals("落盘后曲目数不一致", total, again.stats().tracks)
            assertEquals("落盘后条目数不一致", total, again.itemKeys(pl).size)
        } finally {
            dir.deleteRecursively()
        }
    }
}
