package com.bilimusic.player

import android.content.Context
import android.os.Build
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 把未捕获异常写到 `filesDir/crash.log`。
 *
 * 为什么需要它：手机上没有 adb 的时候，用户只看到「应用已停止」，我们什么都拿不到。
 * 装了日志之后，用户可以在 App 里「我的 → 关于 → 导出崩溃日志」，或者用文件管理器
 * 进 `Android/data/com.bilimusic.player/files/crash.log` 把文件发出来。
 *
 * 只保留最近 [MAX_ENTRIES] 条，避免日志无限涨。
 */
object CrashLog {

    private const val FILE_NAME = "crash.log"
    private const val MAX_ENTRIES = 5

    /** 装到默认异常处理器前面。必须尽早调用（App.onCreate 第一行）。 */
    fun install(context: Context) {
        val appContext = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            // 写日志本身绝不能再抛异常，否则会把真正的崩溃原因盖掉
            runCatching { write(appContext, thread, error) }
            previous?.uncaughtException(thread, error)
        }
    }

    fun file(context: Context): File = File(context.filesDir, FILE_NAME)

    fun read(context: Context): String =
        runCatching { file(context).takeIf { it.exists() }?.readText().orEmpty() }.getOrDefault("")

    fun clear(context: Context) {
        runCatching { file(context).delete() }
    }

    /**
     * 写一条记录。`internal` 而不是 private，是为了让单元测试能直接验证写入路径
     * （否则只能靠真的制造一个未捕获异常，那会连带杀掉测试进程）。
     */
    internal fun write(context: Context, thread: Thread, error: Throwable) {
        val sw = StringWriter()
        PrintWriter(sw).use { error.printStackTrace(it) }

        val time = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
        val entry = buildString {
            appendLine("========== $time ==========")
            appendLine("thread: ${thread.name}")
            appendLine("device: ${Build.MANUFACTURER} ${Build.MODEL}")
            appendLine("android: ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT})")
            appendLine("app: ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
            appendLine(sw.toString())
        }

        val f = file(context)
        // 保留最近几条：新日志放最前面
        val old = runCatching { f.takeIf { it.exists() }?.readText().orEmpty() }.getOrDefault("")
        val kept = old.split("==========")
            .filter { it.isNotBlank() }
            .take(MAX_ENTRIES - 1)
            .joinToString("==========") { "==========" + it }

        f.parentFile?.mkdirs()
        f.writeText(entry + kept)
    }
}
