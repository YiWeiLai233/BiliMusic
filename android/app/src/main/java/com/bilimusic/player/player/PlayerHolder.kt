package com.bilimusic.player.player

import android.content.Context
import android.net.Uri
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import com.bilimusic.player.sync.TrackCore

/**
 * 全局唯一的播放器实例。
 *
 * 关键点在 [httpDataSourceFactory]：B 站的音频 CDN 会校验 Referer **和 UA**，
 * 直接丢给 ExoPlayer 会 403。所以这里给数据源挂上 UA / Referer / Origin 三个头，
 * 和桌面端 src/audioProxy.js 透传的 PASS_HEADERS 保持一致。
 * 桌面端是起了个本地代理做这件事，安卓端 ExoPlayer 自带数据源注入，省掉那一层。
 *
 * ## 为什么取流必须用桌面 UA（踩过的坑）
 *
 * 用 Android UA 去 upos-*.bilivideo.com 取流，CDN 会直接回 **403**（nginx 的
 * 403 页面，345 字节 HTML），所有歌曲都一样。实测同一台机器、同一个直链：
 *
 * | 请求头                                  | 结果          |
 * |-----------------------------------------|---------------|
 * | Windows UA + Referer                    | 200 · video/mp4 |
 * | Windows UA + Referer + Origin           | 200 · video/mp4 |
 * | Mac UA + Referer                        | 200 · video/mp4 |
 * | **Android UA + Referer（+任何 Referer）** | **403**       |
 * | 无 UA，只有 Referer                      | 200 · video/mp4 |
 * | 无 Referer（任何 UA）                     | 403           |
 *
 * 也就是两条独立要求：**Referer 必须是 bilibili.com**，且 **UA 不能含 Android**。
 * 换成 m.bilibili.com 的 Referer 也救不回移动 UA，说明是 UA 本身被拦。
 *
 * 注意 playurl 拿到的直链与 UA 无关（URL 里 platform=pc，WBI 签名也不参与 UA），
 * 所以 API 层照旧用 Android UA（[com.bilimusic.player.net.BiliClient.UA]），
 * 只有真正去 CDN 拉字节这一步换成桌面 UA 即可 —— 已实测 200。
 */
object PlayerHolder {

    private var instance: ExoPlayer? = null

    fun httpDataSourceFactory(): DefaultHttpDataSource.Factory = DefaultHttpDataSource.Factory()
        .setUserAgent(CDN_UA)
        .setDefaultRequestProperties(CDN_REQUEST_HEADERS)
        .setAllowCrossProtocolRedirects(true)
        .setConnectTimeoutMs(15_000)
        .setReadTimeoutMs(20_000)

    /**
     * 取流时附带的请求头。
     *
     * 提成常量是为了能被单测断言 —— media3 的 `DefaultHttpDataSource.Factory`
     * 只有 setter 没有 getter，测试没法从 factory 上把值读回来。
     * 改这里就等于改实际发出去的请求头，两处不会再漂移。
     */
    val CDN_REQUEST_HEADERS: Map<String, String> = mapOf(
        "Referer" to "https://www.bilibili.com/",
        "Origin" to "https://www.bilibili.com",
        "Accept" to "*/*",
        "Accept-Language" to "zh-CN,zh;q=0.9,en;q=0.8",
    )

    /**
     * 取流用的 UA。**必须是桌面 UA**：B 站音视频 CDN 会拒绝含 `Android` 的 UA，
     * 表现为「音频地址被拒绝」的 403。改成桌面 UA 后同一台手机、同一个直链可正常播放。
     *
     * 更新 B 站风控时如果又出现 403，先改这里再怀疑别处。
     */
    const val CDN_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

    fun player(context: Context): ExoPlayer = instance ?: build(context).also { instance = it }

    fun peek(): ExoPlayer? = instance

    private fun build(context: Context): ExoPlayer {
        val http = httpDataSourceFactory()
        val ds = DefaultDataSource.Factory(context, http)
        return ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(ds))
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                true
            )
            .setHandleAudioBecomingNoisy(true)
            .build()
    }

    /** 把曲目变成可播放的 MediaItem。url 是已经过 playurl 解析出来的直链。 */
    fun mediaItemOf(track: TrackCore, url: String, isLocal: Boolean = false): MediaItem {
        val artwork = track.cover.takeIf { it.isNotBlank() }
        val builder = MediaItem.Builder()
            .setMediaId(track.key)
            .setUri(Uri.parse(url))
        if (artwork != null) {
            builder.setMediaMetadata(
                androidx.media3.common.MediaMetadata.Builder()
                    .setTitle(track.title)
                    .setArtist(track.artist)
                    .setArtworkUri(Uri.parse(artwork))
                    .build()
            )
        } else {
            builder.setMediaMetadata(
                androidx.media3.common.MediaMetadata.Builder()
                    .setTitle(track.title)
                    .setArtist(track.artist)
                    .build()
            )
        }
        // 本地文件让 ExoPlayer 按扩展名猜；网络流走 B 站 dash 的 m4a
        if (!isLocal) builder.setMimeType(MimeTypes.AUDIO_MP4)
        return builder.build()
    }
}
