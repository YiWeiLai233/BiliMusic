package com.bilimusic.player.net

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * 用 kotlinx.serialization 的 JsonElement 读接口返回值，而不是 org.json。
 * 原因：org.json 在纯 JVM 单元测试里是抛异常的桩类，换成这套接口解析就能直接写测试。
 */
internal fun JsonObject.str(k: String, def: String = ""): String =
    (this[k] as? JsonPrimitive)?.contentOrNull ?: def

internal fun JsonObject.num(k: String, def: Long = 0L): Long =
    (this[k] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()?.toLong() ?: def

internal fun JsonObject.int(k: String, def: Int = 0): Int = num(k, def.toLong()).toInt()

internal fun JsonObject.bool(k: String): Boolean =
    (this[k] as? JsonPrimitive)?.contentOrNull.let { it == "true" || it == "1" }

internal fun JsonObject.obj(k: String): JsonObject? = this[k] as? JsonObject

internal fun JsonObject.arr(k: String): List<JsonObject> =
    (this[k] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
