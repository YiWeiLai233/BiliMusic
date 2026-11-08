package com.bilimusic.player.player

import android.content.Intent
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/**
 * 后台播放服务。真正的 ExoPlayer 实例在 [PlayerHolder] 里，Activity 和这里共用。
 */
class PlaybackService : MediaSessionService() {

    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        session = MediaSession.Builder(this, PlayerHolder.player(this)).build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        val p = PlayerHolder.peek()
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        // 只释放 session，不动 ExoPlayer：那是 [PlayerHolder] 的全局单例，
        // 界面还可能在用它，这里 release 掉会让后续 setMediaItem 崩。
        session?.release()
        session = null
        super.onDestroy()
    }
}
