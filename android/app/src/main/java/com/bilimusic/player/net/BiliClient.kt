package com.bilimusic.player.net

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** 接口错误。code 沿用 B 站的数字码，本地错误用负数。 */
class BiliException(val code: Int, message: String) : Exception(message)

data class NavInfo(
    val isLogin: Boolean,
    val mid: Long,
    val uname: String,
    val face: String,
    val vip: Boolean,
    val level: Int,
)

data class FavFolder(
    val id: Long,
    val fid: Long,
    val title: String,
    val mediaCount: Int,
    val attr: Long,
)

data class FavItem(
    val bvid: String,
    val aid: Long,
    val title: String,
    val cover: String,
    val duration: Int,
    val upper: String,
    val upperMid: Long,
    val favTime: Long,
    val intro: String,
    val type: Int,
)

data class VideoPage(val page: Int, val cid: Long, val part: String, val duration: Int)

data class VideoMeta(
    val bvid: String,
    val aid: Long,
    val title: String,
    val tid: Long,
    val tname: String,
    val pic: String,
    val duration: Int,
    val pubdate: Long,
    val owner: String,
    val ownerMid: Long,
    val isMusic: Boolean,
    val pages: List<VideoPage>,
    val cid: Long,
    val ts: Long,
)

data class AudioStream(
    val id: Int,
    val label: String,
    val codecs: String,
    val bandwidth: Long,
    val urls: List<String>,
)

/** 解析出来的待入库曲目（对应桌面端 resolveLinks 的 out 元素） */
data class ResolvedTrack(
    val bvid: String,
    val id: String,
    val cid: Long,
    val page: Int,
    val title: String,
    val artist: String,
    val cover: String,
    val duration: Int,
    val tname: String,
    val isMusic: Boolean,
    val multiPage: Boolean,
)

data class ResolveResult(val tracks: List<ResolvedTrack>, val failed: List<Pair<String, String>>)

/**
 * B 站接口客户端，移植自 D:\bilibiliMusicPlayer\src\bili.js。
 *
 * 和桌面端的差别：
 *  1. 用 OkHttp 的 CookieJar 自动管 Cookie（桌面端手写解析 Set-Cookie）；
 *  2. 视频元信息缓存不再落 json 文件，直接放内存 + Room 不需要（一首歌的 meta 很小，
 *     而且安卓端「我的库」里已经存了 title/cover/duration，切歌不需要再看 meta）；
 *  3. 所有 suspend 函数都在 Dispatchers.IO 上跑。
 */
class BiliClient(context: Context) {

    val jar = PersistentCookieJar(context)

    private val http: OkHttpClient = OkHttpClient.Builder()
        .cookieJar(jar)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private var mixin: String = ""
    private var mixinAt: Long = 0

    private val metaCache = HashMap<String, VideoMeta>()

    // ---------------- 基础请求 ----------------

    private suspend fun raw(
        url: String,
        headers: Map<String, String> = emptyMap(),
        redirect: Boolean = true,
    ): String = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(url)
            .header("User-Agent", UA)
            .header("Referer", "https://www.bilibili.com/")
            .header("Origin", "https://www.bilibili.com")
            .header("Accept", "application/json, text/plain, */*")
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            .apply { headers.forEach { (k, v) -> header(k, v) } }
            .get()
            .build()
        if (!redirect) {
            // followRedirects 是 client 级设置，这里单独建一个不跟随的请求
            val c = http.newBuilder().followRedirects(false).build()
            c.newCall(req).execute().use { r ->
                r.header("Location") ?: return@use r.request.url.toString()
            }
        } else {
            http.newCall(req).execute().use { r ->
                val body = r.body?.string() ?: ""
                if (!r.isSuccessful) {
                    throw BiliException(r.code, "HTTP ${r.code}：${body.take(120)}")
                }
                body
            }
        }
    }

    private suspend fun jsonOf(url: String, headers: Map<String, String> = emptyMap()): JsonObject {
        val text = raw(url, headers)
        return try {
            json.parseToJsonElement(text).jsonObject
        } catch (e: Exception) {
            throw BiliException(-1, "接口返回非 JSON：${text.take(120)}")
        }
    }

    /** 取 wbi 盐（缓存 1 小时），对应 bili.js:_ensureWbi */
    private suspend fun ensureMixin(): String {
        val now = System.currentTimeMillis()
        if (mixin.isNotEmpty() && now - mixinAt < 3_600_000L) return mixin
        val nav = jsonOf("https://api.bilibili.com/x/web-interface/nav")
        val img = nav.obj("data")?.obj("wbi_img")?.str("img_url") ?: ""
        val sub = nav.obj("data")?.obj("wbi_img")?.str("sub_url") ?: ""
        if (img.isEmpty() || sub.isEmpty()) throw BiliException(-1, "无法获取 WBI 密钥（nav 接口异常）")
        mixin = Wbi.mixinKey(img, sub)
        mixinAt = now
        return mixin
    }

    /** 带 wbi 签名的 GET，对应 bili.js:apiGet */
    private suspend fun sgGet(base: String, params: Map<String, String>): JsonObject {
        val m = ensureMixin()
        return jsonOf("$base?${Wbi.signed(params, m)}")
    }

    // ---------------- 扫码登录 ----------------

    /** 返回 (二维码内容, qrcode_key) */
    suspend fun qrGenerate(): Pair<String, String> {
        val r = jsonOf(
            "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
            mapOf("Referer" to "https://passport.bilibili.com/"),
        )
        if (r.int("code", -1) != 0) throw BiliException(r.int("code", -1), r.str("message", "二维码生成失败"))
        val d = r.obj("data") ?: throw BiliException(-1, "二维码数据为空")
        return d.str("url") to d.str("qrcode_key")
    }

    enum class QrState { WAITING, SCANNED, EXPIRED, OK }

    data class QrPollResult(val state: QrState, val message: String)

    suspend fun qrPoll(key: String): QrPollResult {
        val url = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll" +
            "?qrcode_key=${Wbi.encodeValue(key)}&source=main-fe-header"
        val r = jsonOf(url, mapOf("Referer" to "https://passport.bilibili.com/"))
        val data = r.obj("data")
        val code = data?.int("code", -1) ?: -1
        if (r.int("code", -1) == 0 && code == 0) {
            // 兜底：有些情况下 cookie 只在 data.url 里给
            if (!jar.has("SESSDATA")) {
                val u = data?.str("url") ?: ""
                if (u.isNotEmpty()) {
                    parseLoginUrl(u)?.forEach { (k, v) -> jar.put(k, v) }
                }
            }
            return QrPollResult(QrState.OK, "登录成功")
        }
        return when (code) {
            86_101 -> QrPollResult(QrState.WAITING, "等待扫码")
            86_090 -> QrPollResult(QrState.SCANNED, "已扫码，请在手机上确认")
            86_038 -> QrPollResult(QrState.EXPIRED, "二维码已失效，请刷新")
            86_102 -> QrPollResult(QrState.SCANNED, "已扫码，请确认登录")
            else -> QrPollResult(QrState.WAITING, r.str("message", "状态 $code"))
        }
    }

    /** 从登录成功回调 url 里抠出关键 cookie */
    internal fun parseLoginUrl(u: String): Map<String, String>? {
        val url = u.toHttpUrlOrNull() ?: return null
        val out = LinkedHashMap<String, String>()
        for (name in listOf("SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid")) {
            url.queryParameter(name)?.let { out[name] = it }
        }
        return out.ifEmpty { null }
    }

    fun isLoggedIn(): Boolean = jar.has("SESSDATA")

    fun logout() = jar.clear()

    /** 拿一个匿名 buvid，降低 -352 风控概率 */
    suspend fun ensureBuvid() {
        if (jar.has("buvid3")) return
        try {
            val r = jsonOf("https://api.bilibili.com/x/frontend/finger/spi")
            val d = r.obj("data") ?: return
            val b3 = d.str("b_3")
            val b4 = d.str("b_4")
            if (b3.isNotEmpty()) jar.put("buvid3", b3)
            if (b4.isNotEmpty()) jar.put("buvid4", b4)
        } catch (_: Exception) {
            // 拿不到也不致命
        }
    }

    suspend fun nav(): NavInfo {
        val r = jsonOf("https://api.bilibili.com/x/web-interface/nav")
        val d = r.obj("data") ?: JsonObject(emptyMap())
        val vip = d.num("vipStatus") == 1L || d.obj("vip")?.num("status") == 1L
        return NavInfo(
            isLogin = d.bool("isLogin"),
            mid = d.num("mid"),
            uname = d.str("uname"),
            face = d.str("face"),
            vip = vip,
            level = d.obj("level_info")?.int("current_level") ?: 0,
        )
    }

    // ---------------- 收藏夹 ----------------

    suspend fun favFolders(mid: Long): List<FavFolder> {
        if (mid <= 0) throw BiliException(-101, "未登录")
        try {
            val r = sgGet(
                "https://api.bilibili.com/x/v3/fav/folder/created/list-all",
                mapOf("up_mid" to mid.toString(), "type" to "0", "rid" to "0", "web_location" to "333.1387"),
            )
            if (r.int("code", -1) == 0) {
                val list = r.obj("data")?.arr("list") ?: emptyList()
                if (list.isNotEmpty()) return list.mapNotNull { normalizeFolder(it) }
            }
        } catch (_: Exception) {
            // 落到分页接口
        }
        val out = ArrayList<FavFolder>()
        for (pn in 1..10) {
            val r = sgGet(
                "https://api.bilibili.com/x/v3/fav/folder/created/list",
                mapOf("up_mid" to mid.toString(), "pn" to pn.toString(), "ps" to "100", "web_location" to "333.1387"),
            )
            if (r.int("code", -1) != 0) throw BiliException(r.int("code", -1), r.str("message", "收藏夹列表获取失败"))
            val list = r.obj("data")?.arr("list") ?: emptyList()
            out.addAll(list.mapNotNull { normalizeFolder(it) })
            if (list.size < 100) break
        }
        // 分页翻页期间收藏夹可能增减，导致同一个 id 出现在两页里。
        // 调用方拿这些 id 当 LazyColumn 的 key，重复就会抛异常，所以这里必须去重。
        return out.distinctBy { it.id }
    }

    suspend fun favItems(
        mediaId: Long,
        max: Int = 600,
        onProgress: (suspend (Int, Int) -> Unit)? = null,
    ): Pair<List<FavItem>, Int> {
        val out = ArrayList<FavItem>()
        var total = 0
        for (pn in 1..40) {
            val r = sgGet(
                "https://api.bilibili.com/x/v3/fav/resource/list",
                mapOf(
                    "media_id" to mediaId.toString(),
                    "pn" to pn.toString(),
                    "ps" to "20",
                    "keyword" to "",
                    "order" to "mtime",
                    "type" to "0",
                    "tid" to "0",
                    "platform" to "web",
                    "web_location" to "333.1387",
                ),
            )
            if (r.int("code", -1) != 0) throw BiliException(r.int("code", -1), r.str("message", "收藏夹内容获取失败"))
            val data = r.obj("data")
            total = data?.obj("info")?.int("media_count") ?: total
            val medias = data?.arr("medias") ?: emptyList()
            for (m in medias) normalizeFavItem(m)?.let { out.add(it) }
            onProgress?.invoke(out.size, total)
            val hasMore = data?.bool("has_more") ?: false
            if (!hasMore || medias.isEmpty() || out.size >= max) break
            delay(120)
        }
        return out to total
    }

    // ---------------- 视频信息 / 播放地址 ----------------

    suspend fun videoInfo(bvid: String, force: Boolean = false): VideoMeta {
        if (!force) {
            metaCache[bvid]?.let { return it }
        }
        val r = jsonOf("https://api.bilibili.com/x/web-interface/view?bvid=${Wbi.encodeValue(bvid)}")
        if (r.int("code", -1) != 0) throw BiliException(r.int("code", -1), r.str("message", "视频信息获取失败"))
        val d = r.obj("data") ?: throw BiliException(-1, "视频数据为空")
        val pages = d.arr("pages").map {
            VideoPage(it.int("page", 1), it.num("cid"), it.str("part"), it.int("duration"))
        }
        val tid = d.num("tid")
        val tname = d.str("tname")
        val meta = VideoMeta(
            bvid = d.str("bvid", bvid),
            aid = d.num("aid"),
            title = d.str("title"),
            tid = tid,
            tname = tname,
            pic = normalizePic(d.str("pic")),
            duration = d.int("duration"),
            pubdate = d.num("pubdate"),
            owner = d.obj("owner")?.str("name") ?: "",
            ownerMid = d.obj("owner")?.num("mid") ?: 0,
            isMusic = tid in MUSIC_TIDS || Regex("音乐|MV|演奏|翻唱|VOCALOID").containsMatchIn(tname),
            pages = pages,
            cid = pages.firstOrNull()?.cid ?: d.num("cid"),
            ts = System.currentTimeMillis(),
        )
        metaCache[bvid] = meta
        return meta
    }

    suspend fun resolveMany(
        bvids: Collection<String>,
        concurrency: Int = 5,
        onOne: (suspend (String, VideoMeta?) -> Unit)? = null,
    ): Map<String, VideoMeta?> = coroutineScope {
        val queue = bvids.distinct()
        val out = ConcurrentHashMap<String, VideoMeta?>()
        val idx = AtomicInteger(0)
        val jobs = (0 until minOf(concurrency, queue.size)).map {
            launch(Dispatchers.IO) {
                while (true) {
                    val i = idx.getAndIncrement()
                    if (i >= queue.size) break
                    val b = queue[i]
                    val m = try {
                        videoInfo(b)
                    } catch (_: Exception) {
                        null
                    }
                    out[b] = m
                    onOne?.invoke(b, m)
                    delay(120)
                }
            }
        }
        jobs.forEach { it.join() }
        out
    }

    suspend fun resolveLinks(input: String): ResolveResult {
        val tokens = extractBiliRefs(input)
        if (tokens.isEmpty()) throw BiliException(-400, "没找到有效的 B 站视频链接或 BV 号")
        val out = ArrayList<ResolvedTrack>()
        val failed = ArrayList<Pair<String, String>>()
        val seen = HashSet<String>()

        for (t in tokens) {
            var bvid = t.bvid
            var page = t.page
            try {
                if (bvid.isEmpty() && t.shortUrl != null) {
                    val real = raw(t.shortUrl, redirect = false)
                    val again = extractBiliRefs(real)
                    if (again.isNotEmpty()) {
                        bvid = again[0].bvid
                        if (page == 0) page = again[0].page
                    }
                }
                if (bvid.isEmpty() && t.aid != null) {
                    val vr = jsonOf("https://api.bilibili.com/x/web-interface/view?aid=${t.aid}")
                    if (vr.int("code", -1) == 0) bvid = vr.obj("data")?.str("bvid") ?: ""
                }
                if (bvid.isEmpty()) throw BiliException(-404, "链接里没有 BV 号")

                val meta = videoInfo(bvid)
                val pages = meta.pages.ifEmpty {
                    listOf(VideoPage(1, meta.cid, "", meta.duration))
                }
                val targets = if (page > 0) pages.filter { it.page == page }.ifEmpty { listOf(pages[0]) } else pages
                val multi = pages.size > 1
                if (multi) {
                    metaCache[bvid] = meta.copy()
                }
                for (p in targets) {
                    // 多 P 视频的每个分 P 要有独立 id，否则在库里会互相覆盖
                    val id = if (multi) "${meta.bvid}:p${p.page}" else meta.bvid
                    if (!seen.add(id)) continue
                    val cleaned = cleanPartName(p.part, meta.title)
                    val partName = if (multi) {
                        if (cleaned.isNotEmpty()) "P${p.page} $cleaned" else "P${p.page}"
                    } else ""
                    out.add(
                        ResolvedTrack(
                            bvid = meta.bvid,
                            id = id,
                            cid = p.cid,
                            page = p.page.coerceAtLeast(1),
                            title = if (partName.isNotEmpty()) "${meta.title} · $partName" else meta.title,
                            artist = meta.owner,
                            cover = meta.pic,
                            duration = if (p.duration > 0) p.duration else meta.duration,
                            tname = meta.tname,
                            isMusic = meta.isMusic,
                            multiPage = multi,
                        )
                    )
                }
            } catch (e: Exception) {
                failed.add((t.raw.ifEmpty { bvid }) to (e.message ?: "解析失败"))
            }
            delay(150)
        }
        if (out.isEmpty()) throw BiliException(-404, failed.firstOrNull()?.second ?: "解析失败")
        return ResolveResult(out, failed)
    }

    suspend fun audioStreams(bvid: String, cid: Long): List<AudioStream> {
        if (bvid.isEmpty() || cid <= 0) throw BiliException(-400, "缺少 bvid 或 cid")
        val r = sgGet(
            "https://api.bilibili.com/x/player/wbi/playurl",
            mapOf(
                "bvid" to bvid,
                "cid" to cid.toString(),
                "fnval" to "16",
                "fnver" to "0",
                "fourk" to "1",
                "web_location" to "1315873",
            ),
        )
        if (r.int("code", -1) != 0) throw BiliException(r.int("code", -1), r.str("message", "播放地址获取失败"))
        val data = r.obj("data") ?: throw BiliException(-1, "播放数据为空")
        val audio = data.obj("dash")?.arr("audio") ?: emptyList()
        if (audio.isEmpty()) {
            // 个别老视频只有 durl
            val durl = data.arr("durl")
            if (durl.isNotEmpty()) {
                val u = durl[0].str("url")
                if (u.isNotEmpty()) {
                    val backups = (durl[0]["backup_url"] as? kotlinx.serialization.json.JsonArray)
                        ?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull }
                        ?: emptyList()
                    return listOf(AudioStream(0, "默认音轨", "", 0, listOf(u) + backups))
                }
            }
            throw BiliException(-404, "该视频没有可用的音频流")
        }
        return audio.sortedByDescending { it.num("bandwidth") }.map { a ->
            val id = a.int("id")
            val base = a.str("baseUrl").ifEmpty { a.str("base_url") }
            val backups = (a["backupUrl"] ?: a["backup_url"]) as? kotlinx.serialization.json.JsonArray
            val urls = buildList {
                if (base.isNotEmpty()) add(base)
                backups?.forEach { (it as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull?.let { b -> add(b) } }
            }
            AudioStream(
                id = id,
                label = QUALITY_LABEL[id] ?: id.toString(),
                codecs = a.str("codecs"),
                bandwidth = a.num("bandwidth"),
                urls = urls,
            )
        }
    }

    companion object {
        const val UA =
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"

        val MUSIC_TIDS = setOf(3L, 28L, 31L, 30L, 59L, 29L, 193L, 130L)

        val QUALITY_LABEL = mapOf(
            30216 to "64K 流畅",
            30232 to "132K 标准",
            30280 to "192K 高品质",
            30250 to "杜比全景声",
            30251 to "Hi-Res 无损",
        )

        // ---------- 纯函数（对应 bili.js 末尾那一段） ----------

        fun normalizeFolder(o: JsonObject): FavFolder? {
            val id = o.num("id", -1)
            if (id <= 0) return null
            val fid = o.num("fid", id).let { if (it == 0L) id else it }
            return FavFolder(
                id = id,
                fid = fid,
                title = o.str("title").ifEmpty { "未命名收藏夹" },
                mediaCount = o.int("media_count"),
                attr = o.num("attr"),
            )
        }

        fun normalizeFavItem(o: JsonObject): FavItem? {
            val bvid = o.str("bvid").ifEmpty { o.str("bv_id") }
            if (bvid.isEmpty()) return null
            // type: 2 = 视频，12 = 音频，21 = 视频合集。只保留能取音频的条目
            val type = if (o.containsKey("type")) o.int("type", -1) else 2
            if (type != 2 && type != 21) return null
            return FavItem(
                bvid = bvid,
                aid = o.num("id").let { if (it == 0L) o.num("aid") else it },
                title = o.str("title").ifEmpty { o.str("name").ifEmpty { "未命名" } },
                cover = normalizePic(o.str("cover").ifEmpty { o.str("pic") }),
                duration = parseDuration(o.str("duration", o.num("duration").toString())),
                upper = o.obj("upper")?.str("name") ?: "",
                upperMid = o.obj("upper")?.num("mid") ?: 0,
                favTime = o.num("fav_time").let { if (it == 0L) o.num("ctime") else it },
                intro = o.str("intro"),
                type = type,
            )
        }

        fun parseDuration(v: String): Int {
            val s = v.trim()
            if (s.isEmpty()) return 0
            if (s.all { it.isDigit() }) return s.toIntOrNull() ?: 0
            val parts = s.split(':').map { it.toIntOrNull() }
            if (parts.all { it != null }) {
                var acc = 0
                for (p in parts) acc = acc * 60 + p!!
                return acc
            }
            return 0
        }

        fun normalizePic(url: String): String {
            var u = url.trim()
            if (u.startsWith("//")) u = "https:$u"
            if (u.startsWith("http://")) u = "https://" + u.removePrefix("http://")
            return u
        }

        /** 只在分 P 名包含视频标题时才清洗，否则原样保留 */
        fun cleanPartName(part: String, title: String): String {
            val p = part.trim()
            val t = title.trim()
            if (p.isEmpty()) return ""
            if (t.isEmpty()) return p
            if (!p.contains(t)) return p
            var out = p.split(t).joinToString(" ").replace(Regex("\\s+"), " ").trim()
            out = out.replace(Regex("^[-–—·:：|｜/\\s]+"), "")
            out = out.replace(Regex("[-–—·:：|｜/\\s]+$"), "")
            return out
        }

        private val BV_RE = Regex("(?:BV|bv)([1-9A-HJ-NP-Za-km-z]{10})")
        private val AV_RE = Regex("(?:^|[^a-zA-Z])av(\\d{1,12})", RegexOption.IGNORE_CASE)
        private val SHORT_RE = Regex("https?://b23\\.tv/[A-Za-z0-9]+")
        private val P_RE = Regex("[?&]p=(\\d+)", RegexOption.IGNORE_CASE)

        data class Ref(val raw: String, val bvid: String, val page: Int, val shortUrl: String? = null, val aid: Long? = null)

        fun extractBiliRefs(input: String): List<Ref> {
            val out = ArrayList<Ref>()
            val page = P_RE.find(input)?.groupValues?.get(1)?.toIntOrNull() ?: 0
            BV_RE.findAll(input).forEach { m ->
                out.add(Ref(m.value, "BV" + m.groupValues[1], page))
            }
            if (out.isEmpty()) {
                AV_RE.find(input)?.let { m ->
                    out.add(Ref(m.value.trim(), "", page, aid = m.groupValues[1].toLongOrNull()))
                }
            }
            val shorts = SHORT_RE.findAll(input).map { it.value }.toList()
            if (out.isEmpty() && shorts.isNotEmpty()) {
                shorts.forEach { out.add(Ref(it, "", page, shortUrl = it)) }
            }
            val seen = HashSet<String>()
            return out.filter { r ->
                val k = r.bvid.ifEmpty { r.shortUrl ?: "av${r.aid}" }
                seen.add(k)
            }
        }
    }
}
