package com.bilimusic.player.sync

/**
 * 位置键（fractional index / LSEQ 的简化版）。
 *
 * 为什么不用数组下标：两端各自删掉了不同的歌，下标就全乱了，合并时会莫名其妙
 * 地换位。位置键是「可以无限细分的排序坐标」——插入时算一个介于左右邻居之间的
 * 新坐标，别人的插入永远不会让你这个坐标失效。
 *
 * 表示：IntArray 按字典序比较，前缀更短者更小（[0] < [0,5]）。
 * 两端永远落在 1 级长度上时不会增长；只有反复往同一个缝隙里插入才会加深，
 * 这是可接受的（每次加深容量翻 60 倍以上）。
 */
object Pos {

    /** 字典序比较；短的是长的前缀时，短的更小 */
    fun compare(a: IntArray, b: IntArray): Int {
        val n = minOf(a.size, b.size)
        for (i in 0 until n) {
            if (a[i] != b[i]) return a[i].compareTo(b[i])
        }
        return a.size.compareTo(b.size)
    }

    fun encode(p: IntArray): String = p.joinToString(".") { it.toString(36) }

    fun decode(s: String): IntArray {
        if (s.isEmpty()) return IntArray(0)
        val parts = s.split('.')
        val out = IntArray(parts.size)
        for (i in parts.indices) out[i] = parts[i].toIntOrNull(36) ?: 0
        return out
    }

    /** 传 null 表示「无限小 / 无限大」 */
    fun between(a: IntArray?, b: IntArray?): IntArray {
        if (a == null && b == null) return intArrayOf(38)
        if (a == null) {
            val bb = b!!
            if (bb.isEmpty()) return intArrayOf(0)
            return if (bb[0] > 0) intArrayOf(bb[0] / 2) else intArrayOf(bb[0] - 1)
        }
        if (b == null) {
            return if (a[0] < Int.MAX_VALUE) intArrayOf(a[0] + 1) else a + 0
        }
        var i = 0
        val n = minOf(a.size, b.size)
        while (i < n && a[i] == b[i]) i++
        if (i == a.size && i == b.size) return intArrayOf(38) // 相等，理论不该发生
        if (i == a.size) {
            // a 是 b 的前缀：在 b 的这一层下方取一个更小的兄弟
            val head = a.copyOf()
            val bi = b[i]
            return if (bi > Int.MIN_VALUE + 1) head + (bi - 1) else head + between(null, b.copyOfRange(i, b.size))
        }
        if (i == b.size) {
            // b 是 a 的前缀（说明 a > b，调用方给反了）——退化成往 a 之前插
            return between(null, a)
        }
        val ai = a[i]
        val bi = b[i]
        if (bi - ai >= 2) {
            val head = a.copyOfRange(0, i)
            return head + ((ai + bi) / 2)
        }
        // 相邻：前缀到 i（含），再往 a 的残留后面接一段
        val head = a.copyOfRange(0, i + 1)
        val rest = if (i + 1 < a.size) a.copyOfRange(i + 1, a.size) else IntArray(0)
        return head + after(rest)
    }

    private fun after(a: IntArray): IntArray {
        if (a.isEmpty()) return intArrayOf(0)
        return if (a[0] < Int.MAX_VALUE) intArrayOf(a[0] + 1) else a + 0
    }
}
