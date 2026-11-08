package com.bilimusic.player.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.style.TextAlign
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * 封面加载。B 站的图床会拒绝没有 Referer 的请求，所以这里同样要带头。
 * 用一个极小的内存 LRU 就够——列表滚动时同一张封面会反复请求。
 */
object CoverLoader {
    private val http = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(12, TimeUnit.SECONDS)
        .build()

    private val cache = object : LinkedHashMap<String, Bitmap>(60, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Bitmap>?): Boolean = size > 120
    }

    fun cached(url: String): Bitmap? = synchronized(cache) { cache[url] }

    suspend fun load(url: String): Bitmap? = withContext(Dispatchers.IO) {
        if (url.isBlank()) return@withContext null
        synchronized(cache) { cache[url] }?.let { return@withContext it }
        try {
            val req = Request.Builder()
                .url(url)
                .header("User-Agent", "Mozilla/5.0 (Linux; Android 13) Chrome/131.0.0.0 Mobile Safari/537.36")
                .header("Referer", "https://www.bilibili.com/")
                .build()
            http.newCall(req).execute().use { r ->
                val bytes = r.body?.bytes() ?: return@withContext null
                val opts = BitmapFactory.Options().apply { inSampleSize = 2 }
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return@withContext null
                synchronized(cache) { cache[url] = bmp }
                bmp
            }
        } catch (_: Exception) {
            null
        }
    }
}

@Composable
fun Cover(url: String, modifier: Modifier = Modifier, placeholder: String = "♪") {
    var bmp by remember(url) { mutableStateOf(CoverLoader.cached(url)) }
    LaunchedEffect(url) {
        if (bmp == null) bmp = CoverLoader.load(url)
    }
    Box(modifier = modifier.background(BgElevated), contentAlignment = Alignment.Center) {
        val img: ImageBitmap? = bmp?.asImageBitmap()
        if (img != null) {
            Image(bitmap = img, contentDescription = null, modifier = Modifier.fillMaxSize())
        } else {
            Text(placeholder, color = TextSecondary, textAlign = TextAlign.Center)
        }
    }
}
