package com.bilimusic.player

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 崩溃日志的单元测试。
 *
 * 这个类存在的意义：崩溃日志本身必须绝对可靠 —— 它在已经出问题的时候运行，
 * 如果它自己也崩，用户就彻底没有线索了。所以单独验证它的写入/读取/清理。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CrashLogTest {

    private val ctx get() = ApplicationProvider.getApplicationContext<App>()

    @Test
    fun write_records_message_and_stack() {
        CrashLog.clear(ctx)
        CrashLog.write(ctx, Thread.currentThread(), IllegalStateException("boom from test"))

        val text = CrashLog.read(ctx)
        assertTrue("应包含异常类型", text.contains("IllegalStateException"))
        assertTrue("应包含异常消息", text.contains("boom from test"))
        assertTrue("应包含设备信息", text.contains("device:"))
        assertTrue("应包含 SDK 版本", text.contains("SDK 34"))
    }

    @Test
    fun keeps_only_most_recent_entries() {
        CrashLog.clear(ctx)
        repeat(8) { i -> CrashLog.write(ctx, Thread.currentThread(), RuntimeException("err-$i")) }
        val text = CrashLog.read(ctx)

        // 最新的那条必须在，最老的那几条应该被丢掉
        assertTrue("最新的应保留", text.contains("err-7"))
        assertFalse("最老的应被裁掉", text.contains("err-0"))
        val entries = text.split("==========").count { it.contains("err-") }
        assertTrue("条目数应受上限约束，实际 $entries", entries <= 5)
    }

    @Test
    fun clear_removes_file() {
        CrashLog.write(ctx, Thread.currentThread(), RuntimeException("to be cleared"))
        assertFalse(CrashLog.read(ctx).isEmpty())
        CrashLog.clear(ctx)
        assertEquals("", CrashLog.read(ctx))
    }

    @Test
    fun install_replaces_handler_and_can_be_restored() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        CrashLog.install(ctx)
        val installed = Thread.getDefaultUncaughtExceptionHandler()
        assertTrue("install 之后必须换成我们的处理器", installed != null && installed !== previous)
        // 还原，避免影响同一 JVM 里后续的测试
        Thread.setDefaultUncaughtExceptionHandler(previous)
        assertEquals(previous, Thread.getDefaultUncaughtExceptionHandler())
    }

    @Test
    fun read_returns_empty_when_no_file() {
        CrashLog.clear(ctx)
        assertEquals("", CrashLog.read(ctx))
    }
}
