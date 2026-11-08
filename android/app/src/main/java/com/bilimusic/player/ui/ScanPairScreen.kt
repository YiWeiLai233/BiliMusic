package com.bilimusic.player.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 扫对方屏幕上的配对二维码。
 *
 * 为什么自己写而不是跳第三方扫码 App：
 *   配对串是私有 scheme（bilimusic://pair?...），系统扫码器扫完只会提示
 *   「无法打开链接」，用户还得再抄一遍 IP 和口令——那二维码就白扫了。
 *   自己扫才能直接把 ip/port/token 填进去发起同步。
 *
 * 用 CameraX 的 ImageAnalysis 拿 YUV 帧，只取 Y 平面喂 zxing 的
 * PlanarYUVLuminanceSource（灰度就够了，省掉一次 RGB 转换）。
 */
@Composable
fun ScanPairScreen(
    onResult: (String) -> Unit,
    onBack: () -> Unit,
) {
    val ctx = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val granted = remember {
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    }
    var hasPermission by remember { mutableStateOf(granted) }
    var denied by remember { mutableStateOf(false) }
    var hint by remember { mutableStateOf("把对方的配对二维码放进框里") }

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        hasPermission = ok
        denied = !ok
    }

    LaunchedEffect(Unit) {
        if (!hasPermission) launcher.launch(Manifest.permission.CAMERA)
    }

    // 扫码页是全屏页而不是弹窗，必须自己接返回键：
    // 否则按返回会越过同步页直接退出 App（外层 AppRoot 的 BackHandler 只看到 Route.Sync）。
    BackHandler { onBack() }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        if (hasPermission) {
            CameraPreview(
                onDecoded = { text ->
                    hint = "识别成功"
                    onResult(text)
                },
                onFail = { msg -> hint = msg },
            )
            // 取景框
            Box(
                Modifier.align(Alignment.Center).fillMaxWidth(0.62f).aspectRatio(1f)
                    .clip(RoundedCornerShape(16.dp))
                    .border(2.dp, Brand, RoundedCornerShape(16.dp)),
            )
            Column(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                    .background(Color(0xCC101218)).padding(20.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(hint, color = TextPrimary, fontSize = 13.sp)
                Spacer(Modifier.height(6.dp))
                Text(
                    "电脑端点「跨设备同步」→「给对方扫码」，手机对着屏幕即可",
                    color = TextSecondary, fontSize = 11.sp,
                )
                Spacer(Modifier.height(12.dp))
                Button(
                    onClick = onBack,
                    colors = ButtonDefaults.buttonColors(containerColor = BgElevated),
                    shape = RoundedCornerShape(18.dp),
                ) { Text("取消", color = TextPrimary, fontSize = 13.sp) }
            }
        } else {
            Column(
                Modifier.fillMaxSize().padding(28.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("需要相机权限才能扫码", color = TextPrimary, fontSize = 15.sp)
                Spacer(Modifier.height(8.dp))
                Text(
                    if (denied) "已拒绝。可以再点一次授权，或者直接手输 IP、端口和口令。"
                    else "扫码只是省去手抄 IP 和口令，不想给权限也能手动配对。",
                    color = TextSecondary, fontSize = 12.sp,
                )
                Spacer(Modifier.height(16.dp))
                Row2 {
                    Button(
                        onClick = { launcher.launch(Manifest.permission.CAMERA) },
                        colors = ButtonDefaults.buttonColors(containerColor = Brand),
                        shape = RoundedCornerShape(18.dp),
                    ) { Text("授权相机", color = Color.White, fontSize = 13.sp) }
                    Spacer(Modifier.width(10.dp))
                    Button(
                        onClick = onBack,
                        colors = ButtonDefaults.buttonColors(containerColor = BgElevated),
                        shape = RoundedCornerShape(18.dp),
                    ) { Text("手动配对", color = TextPrimary, fontSize = 13.sp) }
                }
            }
        }
    }
}

/** 只是为了在一处放两个按钮，避免重复写 Row 的对齐参数 */
@Composable
private fun Row2(content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    androidx.compose.foundation.layout.Row(
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

@Composable
private fun CameraPreview(onDecoded: (String) -> Unit, onFail: (String) -> Unit) {
    val ctx = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val previewView = remember { PreviewView(ctx).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }
    val handled = remember { AtomicBoolean(false) }

    DisposableEffect(Unit) {
        val executor = Executors.newSingleThreadExecutor()
        val future = ProcessCameraProvider.getInstance(ctx)

        future.addListener({
            val provider = try {
                future.get()
            } catch (e: Exception) {
                onFail("相机初始化失败：" + (e.message ?: ""))
                return@addListener
            }

            val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
            val reader = MultiFormatReader().apply {
                setHints(
                    mapOf(
                        DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
                        // 纯黑白二维码，不开这些省点 CPU
                        DecodeHintType.TRY_HARDER to false,
                    )
                )
            }

            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(executor) { proxy ->
                if (handled.get()) {
                    proxy.close()
                    return@setAnalyzer
                }
                var hit: String? = null
                try {
                    hit = decodeQr(proxy, reader)
                } catch (_: Throwable) {
                    // 单帧失败无所谓，下一秒还有帧
                } finally {
                    runCatching { proxy.close() }
                }
                // 只有第一帧抢到标记的才回调，后面重复解出来的直接丢掉
                if (hit != null && handled.compareAndSet(false, true)) onDecoded(hit)
            }

            try {
                provider.unbindAll()
                provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            } catch (e: Exception) {
                onFail("无法打开相机：" + (e.message ?: ""))
            }
        }, ContextCompat.getMainExecutor(ctx))

        onDispose {
            runCatching { future.get().unbindAll() }
            executor.shutdown()
        }
    }

    AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())
}

/** 从 ImageProxy 的 Y 平面解二维码 */
private fun decodeQr(proxy: ImageProxy, reader: MultiFormatReader): String? {
    val plane = proxy.planes.firstOrNull() ?: return null
    val buf = plane.buffer
    val rowStride = plane.rowStride
    val pixelStride = plane.pixelStride
    val w = proxy.width
    val h = proxy.height

    // rowStride 常大于 width，必须按 stride 拷，否则图像会斜切
    val data: ByteArray
    if (pixelStride == 1 && rowStride == w) {
        data = ByteArray(buf.remaining())
        buf.get(data)
    } else {
        data = ByteArray(rowStride * h)
        buf.get(data, 0, minOf(buf.remaining(), data.size))
    }

    val source = PlanarYUVLuminanceSource(data, rowStride, h, 0, 0, w, h, false)
    val bitmap = BinaryBitmap(HybridBinarizer(source))
    return try {
        reader.decodeWithState(bitmap)?.text
    } catch (_: Throwable) {
        null
    } finally {
        reader.reset()
    }
}
