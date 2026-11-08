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
 * 关键点在 [httpDataSourceFactory]：B 站的音频 CDN 会校验 Referer，
 * 直接丢给 ExoPlayer 会 403。所以这里给数据源挂上 UA / Referer / Origin 三个头，
 * 和桌面端 src/audioProxy.js 透传的 PASS_HEADERS 保持一致。
 * 桌面端是起了个本地代理做这件事，安卓端 ExoPlayer 自带数据源注入，省掉那一层。
 */
object PlayerHolder {

    private var instance: ExoPlayer? = null

    fun httpDataSourceFactory(): DefaultHttpDataSource.Factory = DefaultHttpDataSource.Factory()
        .setUserAgent(UA)
        .setDefaultRequestProperties(
            mapOf(
                "Referer" to "https://www.bilibili.com/",
                "Origin" to "https://www.bilibili.com",
                "Accept" to "*/*",
                "Accept-Language" to "zh-CN,zh;q=0.9,en;q=0.8",
            )
        )
        .setAllowCrossProtocolRedirects(true)
        .setConnectTimeoutMs(15_000)
        .setReadTimeoutMs(20_000)

    /** 取流时用的 UA */
    const val UA =
        "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"

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
