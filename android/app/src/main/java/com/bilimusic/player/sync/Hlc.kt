package com.bilimusic.player.sync

import kotlinx.serialization.Serializable

/**
 * 混合逻辑时钟（Hybrid Logical Clock）。
 *
 * 无服务器同步的关键是「合并必须与顺序无关」，所以每个可写的字段都要带一个
 * 可比较的时间戳。物理时钟不够：两端时间可能差几分钟，也可能同一毫秒改两次。
 * HLC = 物理毫秒 + 计数器，既有墙钟的可读性，又有逻辑时钟的单调性。
 *
 * 比较规则：先比 wall，再比 counter。两端合并时若完全相等，再用 deviceId 做
 * 固定次序的最终裁决，保证任意两端算出同一个赢家。
 */
@Serializable
data class Hlc(val wall: Long = 0L, val counter: Int = 0) : Comparable<Hlc> {

    override fun compareTo(other: Hlc): Int {
        if (wall != other.wall) return wall.compareTo(other.wall)
        return counter.compareTo(other.counter)
    }

    /** 本机发生一次本地修改 */
    fun tick(nowWall: Long = System.currentTimeMillis()): Hlc =
        if (nowWall > wall) Hlc(nowWall, 0) else Hlc(wall, counter + 1)

    /** 收到对方时钟后推进本机时钟（Lamport 规则） */
    fun observe(remote: Hlc, nowWall: Long = System.currentTimeMillis()): Hlc {
        val maxWall = maxOf(nowWall, wall, remote.wall)
        val c = when (maxWall) {
            wall -> if (wall == remote.wall) maxOf(counter, remote.counter) + 1 else counter + 1
            remote.wall -> remote.counter + 1
            else -> 0
        }
        return Hlc(maxWall, c)
    }

    companion object {
        val ZERO = Hlc(0L, 0)
    }
}

/** (Hlc, deviceId) 的确定性全序：任意两端判定同一个胜者。 */
fun hlcGreater(aTs: Hlc, aDev: String, bTs: Hlc, bDev: String): Boolean {
    val c = aTs.compareTo(bTs)
    if (c != 0) return c > 0
    return aDev > bDev
}
