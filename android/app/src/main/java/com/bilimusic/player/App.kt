package com.bilimusic.player

import android.app.Application
import android.content.Context
import com.bilimusic.player.data.AppLibrary
import com.bilimusic.player.data.FavSourceStore
import com.bilimusic.player.net.BiliClient
import java.io.File

/**
 * 手写的极简依赖容器。
 *
 * 不引 Hilt/Koin：整个 App 只有五个长期存活的对象，一个懒加载单例足够，
 * 而且能避免注解处理器拖慢构建。
 */
class App : Application() {

    lateinit var library: AppLibrary
        private set
    lateinit var bili: BiliClient
        private set
    lateinit var favStore: FavSourceStore
        private set
    val settings: AppSettings by lazy { AppSettings(this) }
    val sync: SyncCoordinator by lazy { SyncCoordinator(this) }

    override fun onCreate() {
        super.onCreate()
        // 第一件事：装崩溃日志。之后任何异常都会落到 filesDir/crash.log，
        // 用户可以在「我的 → 导出崩溃日志」里把它拿出来，不用连 adb。
        CrashLog.install(this)
        instance = this
        library = AppLibrary(File(filesDir, "library.json")).also {
            it.load(AppLibrary.ensureDeviceId(getSharedPreferences("device", MODE_PRIVATE)))
        }
        bili = BiliClient(this)
        favStore = FavSourceStore(this)
        // 补偿上次没来得及落的盘
        library.flushIfDirty()
    }

    override fun onTerminate() {
        library.flushIfDirty()
        super.onTerminate()
    }

    companion object {
        lateinit var instance: App
            private set

        fun ctx(): Context = instance
    }
}

/** 播放设置（对应桌面端 src/store.js 的 DEFAULTS 里跟播放有关的那几项） */
class AppSettings(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var quality: Int
        get() = prefs.getInt("quality", 0)
        set(v) = prefs.edit().putInt("quality", v).apply()

    var volume: Float
        get() = prefs.getFloat("volume", 0.8f)
        set(v) = prefs.edit().putFloat("volume", v).apply()

    /** loop-all / loop-one / shuffle / sequential —— 与桌面端 playMode 取值一致 */
    var playMode: String
        get() = prefs.getString("playMode", "loop-all") ?: "loop-all"
        set(v) = prefs.edit().putString("playMode", v).apply()

    /** 同步开关：关掉之后既不上传也不合并，纯粹本地模式 */
    var syncEnabled: Boolean
        get() = prefs.getBoolean("syncEnabled", true)
        set(v) = prefs.edit().putBoolean("syncEnabled", v).apply()

    /** 上一次连的对端地址，重连时预填 */
    var lastPeer: String
        get() = prefs.getString("lastPeer", "") ?: ""
        set(v) = prefs.edit().putString("lastPeer", v).apply()

    var peerToken: String
        get() = prefs.getString("peerToken", "") ?: ""
        set(v) = prefs.edit().putString("peerToken", v).apply()

    var lastSyncAt: Long
        get() = prefs.getLong("lastSyncAt", 0L)
        set(v) = prefs.edit().putLong("lastSyncAt", v).apply()

    var deviceName: String
        get() = prefs.getString("deviceName", android.os.Build.MODEL ?: "Android") ?: "Android"
        set(v) = prefs.edit().putString("deviceName", v).apply()
}
