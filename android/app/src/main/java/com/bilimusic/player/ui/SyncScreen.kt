package com.bilimusic.player.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Devices
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.bilimusic.player.SyncCoordinator

/**
 * 跨设备同步页。核心体验：
 *   - 打开页面即开启本机服务 + UDP 广播；
 *   - 同一 Wi-Fi 下的另一台会出现在「发现设备」里，点一下就同步；
 *   - 也可以给对方扫码（二维码里带 ip/port/token），手输作为兜底。
 */
@Composable
fun SyncScreen(vm: BiliViewModel, onBack: () -> Unit) {
    val server by vm.sync.server.collectAsState()
    val status by vm.sync.status.collectAsState()
    val peers by vm.sync.peers.collectAsState()
    var manual by remember { mutableStateOf(false) }
    var showQr by remember { mutableStateOf(false) }
    var scanning by remember { mutableStateOf(false) }
    var importOpen by remember { mutableStateOf(false) }
    var importText by remember { mutableStateOf("") }
    val clip = androidx.compose.ui.platform.LocalClipboardManager.current
    var host by remember { mutableStateOf(vm.settings.lastPeer.substringBeforeLast(":")) }
    var port by remember { mutableStateOf(vm.settings.lastPeer.substringAfterLast(":").takeIf { it.isNotEmpty() } ?: "") }
    var token by remember { mutableStateOf(vm.settings.peerToken) }

    val stats = remember { vm.lib.stats() }

    // 扫码是全屏相机页，直接顶掉整个同步页
    if (scanning) {
        ScanPairScreen(
            onResult = { text ->
                scanning = false
                val info = com.bilimusic.player.sync.PairUri.parse(text)
                if (info == null) {
                    vm.toast("这不是配对二维码")
                } else {
                    vm.syncWith(info.ip, info.port, info.token)
                }
            },
            onBack = { scanning = false },
        )
        return
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        TopBar("跨设备同步", onBack = onBack) {
            IconButton(onClick = { if (server.running) vm.stopSyncServer() else vm.startSyncServer() }) {
                Icon(Icons.Filled.Sync, null, tint = if (server.running) Brand else TextSecondary)
            }
        }

        // 状态卡
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp).clip(RoundedCornerShape(14.dp))
                .background(BgPanel).padding(16.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Devices, null, tint = if (server.running) Brand else TextSecondary)
                Spacer(Modifier.width(8.dp))
                Text("本机", color = TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                Spacer(Modifier.weight(1f))
                Text(
                    if (server.running) "已就绪" else "未开启",
                    color = if (server.running) Brand else TextSecondary,
                    fontSize = 12.sp,
                )
            }
            Spacer(Modifier.height(10.dp))
            if (server.running) {
                Kv("地址", "${server.ip ?: "未知"}:${server.port}")
                Kv("设备名", vm.settings.deviceName)
                Kv("曲目", "${stats.tracks} 首 · ${stats.playlists} 个歌单")
                Spacer(Modifier.height(10.dp))
                Row {
                    Button(
                        onClick = { showQr = true },
                        colors = ButtonDefaults.buttonColors(containerColor = Brand),
                        shape = RoundedCornerShape(18.dp),
                    ) { Text("给对方扫码", color = Color.White, fontSize = 12.sp) }
                    Spacer(Modifier.width(8.dp))
                    TextButton(onClick = { manual = true }) { Text("手动输入", color = TextSecondary, fontSize = 12.sp) }
                }
            } else {
                Text(
                    "开启后本机会在局域网内广播，另一台设备打开同一个页面就能互相发现。",
                    color = TextSecondary, fontSize = 12.sp,
                )
                Spacer(Modifier.height(10.dp))
                Button(
                    onClick = { vm.startSyncServer() },
                    colors = ButtonDefaults.buttonColors(containerColor = Brand),
                    shape = RoundedCornerShape(18.dp),
                ) { Text("开启同步", color = Color.White, fontSize = 12.sp) }
            }
        }

        Spacer(Modifier.height(10.dp))
        // 状态提示
        when (val s = status) {
            is SyncCoordinator.SyncStatus.Running -> StatusRow(s.message, null)
            is SyncCoordinator.SyncStatus.Ok -> StatusRow(s.message, true)
            is SyncCoordinator.SyncStatus.Failed -> StatusRow(s.message, false)
            else -> {}
        }

        Spacer(Modifier.height(6.dp))
        Text(
            "发现设备 · ${peers.size}",
            color = TextSecondary, fontSize = 12.sp,
            modifier = Modifier.padding(start = 18.dp, top = 8.dp, bottom = 6.dp),
        )
        if (peers.isEmpty()) {
            Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                Text(
                    if (server.running) "正在搜索同一 Wi-Fi 下的设备…" else "先开启同步",
                    color = TextSecondary.copy(alpha = 0.8f), fontSize = 12.sp,
                )
            }
        } else {
            for (p in peers) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 3.dp)
                        .clip(RoundedCornerShape(10.dp)).background(BgPanel)
                        .clickable { vm.syncWith(p.host, p.port, p.token) }
                        .padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Filled.Devices, null, tint = Brand, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(p.name, color = TextPrimary, fontSize = 14.sp)
                        Text("${p.host}:${p.port}", color = TextSecondary, fontSize = 11.sp)
                    }
                    Text("同步", color = Brand, fontSize = 13.sp)
                }
            }
        }

        Spacer(Modifier.height(10.dp))
        TextButton(onClick = { manual = true }, modifier = Modifier.padding(start = 8.dp)) {
            Text("手动输入配对信息", color = TextSecondary, fontSize = 12.sp)
        }

        Spacer(Modifier.height(10.dp))
        // 扫码配对：电脑上展示二维码，手机扫一下直接开始同步
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp).clip(RoundedCornerShape(14.dp))
                .background(BgPanel).padding(16.dp),
        ) {
            Text("扫电脑上的二维码", color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            Spacer(Modifier.height(6.dp))
            Text(
                "电脑端点「跨设备同步 → 给对方扫码」，把二维码放进手机取景框，" +
                    "自动连上并同时交换数据，不用记 IP 和口令。",
                color = TextSecondary, fontSize = 11.sp, lineHeight = 17.sp,
            )
            Spacer(Modifier.height(10.dp))
            Button(
                onClick = { scanning = true },
                colors = ButtonDefaults.buttonColors(containerColor = BgElevated),
                shape = RoundedCornerShape(18.dp),
            ) {
                Icon(Icons.Filled.QrCodeScanner, null, tint = Brand, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("扫码配对", color = Brand, fontSize = 12.sp)
            }
        }

        Spacer(Modifier.height(10.dp))

        // 文本同步码：不在同一 Wi-Fi 也能同步
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp).clip(RoundedCornerShape(14.dp))
                .background(BgPanel).padding(16.dp),
        ) {
            Text("文本同步码", color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            Spacer(Modifier.height(6.dp))
            Text(
                "不在同一个 Wi-Fi？把这里生成的码发给对方（微信/QQ 都行），" +
                    "对方贴进「导入」里合并即可。两端各导出一次、各导入一次，歌单就完全一致。",
                color = TextSecondary, fontSize = 11.sp, lineHeight = 17.sp,
            )
            Spacer(Modifier.height(10.dp))
            Row {
                Button(
                    onClick = {
                        val code = vm.exportSyncCode()
                        if (code.isEmpty()) {
                            vm.toast("生成失败")
                        } else {
                            clip.setText(androidx.compose.ui.text.AnnotatedString(code))
                            vm.toast("同步码已复制（${code.length} 字符）")
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = Brand),
                    shape = RoundedCornerShape(18.dp),
                ) { Text("复制我的同步码", color = Color.White, fontSize = 12.sp) }
                Spacer(Modifier.width(8.dp))
                TextButton(onClick = { importOpen = true }) {
                    Text("导入对方的码", color = Brand, fontSize = 12.sp)
                }
            }
        }

        // 原理说明
        Spacer(Modifier.height(6.dp))
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp).clip(RoundedCornerShape(14.dp))
                .background(BgPanel).padding(16.dp),
        ) {
            Text("为什么不需要服务器", color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            Spacer(Modifier.height(6.dp))
            Text(
                "两端的歌单各自是一份可合并的状态（CRDT）。同步时交换整份状态，" +
                    "按「谁的时间戳新谁说了算」逐字段合并，删除用墓碑记录下来避免复活。\n" +
                    "合并满足交换律和结合律，所以不需要谁当权威，也不需要服务器中转：" +
                    "先同步后同步、同步几次，结果都一样。",
                color = TextSecondary, fontSize = 11.sp, lineHeight = 17.sp,
            )
        }
        Spacer(Modifier.height(60.dp))
    }

    if (showQr) {
        val payload = remember(server) { vm.sync.pairingPayload() }
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { showQr = false },
            title = { Text("让对方扫这个码", color = TextPrimary) },
            text = {
                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                    if (payload.isNotEmpty()) QrCode(payload, 230.dp, "同步配对二维码")
                    Spacer(Modifier.height(10.dp))
                    Text("对方在「跨设备同步」页扫码即可", color = TextSecondary, fontSize = 11.sp)
                }
            },
            confirmButton = { TextButton(onClick = { showQr = false }) { Text("关闭", color = Brand) } },
            containerColor = BgPanel,
        )
    }

    if (importOpen) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { importOpen = false },
            title = { Text("导入同步码", color = TextPrimary) },
            text = {
                Column {
                    androidx.compose.material3.OutlinedTextField(
                        value = importText,
                        onValueChange = { importText = it },
                        label = { Text("粘贴对方发来的同步码") },
                        minLines = 4,
                        maxLines = 8,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = {
                        val t = clip.getText()?.text
                        if (!t.isNullOrBlank()) importText = t
                    }) { Text("从剪贴板粘贴", color = Brand, fontSize = 12.sp) }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    importOpen = false
                    val t = importText.trim()
                    if (t.isEmpty()) vm.toast("先粘贴同步码") else {
                        vm.importSyncCode(t)
                        importText = ""
                    }
                }) { Text("合并", color = Brand) }
            },
            dismissButton = { TextButton(onClick = { importOpen = false }) { Text("取消", color = TextSecondary) } },
            containerColor = BgPanel,
        )
    }

    if (manual) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { manual = false },
            title = { Text("手动配对", color = TextPrimary) },
            text = {
                Column {
                    androidx.compose.material3.OutlinedTextField(
                        value = host, onValueChange = { host = it },
                        label = { Text("对方 IP") }, singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(8.dp))
                    androidx.compose.material3.OutlinedTextField(
                        value = port, onValueChange = { port = it },
                        label = { Text("端口") }, singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(8.dp))
                    androidx.compose.material3.OutlinedTextField(
                        value = token, onValueChange = { token = it },
                        label = { Text("配对口令") }, singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    manual = false
                    val p = port.toIntOrNull()
                    if (p != null) vm.syncWith(host.trim(), p, token.trim()) else vm.toast("端口不合法")
                }) { Text("开始同步", color = Brand) }
            },
            dismissButton = { TextButton(onClick = { manual = false }) { Text("取消", color = TextSecondary) } },
            containerColor = BgPanel,
        )
    }
}

@Composable
private fun Kv(k: String, v: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Text(k, color = TextSecondary, fontSize = 12.sp, modifier = Modifier.width(64.dp))
        Text(v, color = TextPrimary, fontSize = 12.sp)
    }
}

@Composable
private fun StatusRow(msg: String, ok: Boolean?) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(
                when (ok) {
                    true -> Brand.copy(alpha = 0.12f)
                    false -> Color(0x33FF6B6B)
                    null -> BgElevated
                }
            )
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when (ok) {
            null -> CircularProgressIndicator(Modifier.size(14.dp), color = Brand, strokeWidth = 2.dp)
            true -> Icon(Icons.Filled.CheckCircle, null, tint = Brand, modifier = Modifier.size(16.dp))
            false -> Icon(Icons.Filled.ErrorOutline, null, tint = Color(0xFFFF6B6B), modifier = Modifier.size(16.dp))
        }
        Spacer(Modifier.width(8.dp))
        Text(msg, color = if (ok == false) Color(0xFFFF8A8A) else TextPrimary, fontSize = 12.sp)
    }
}
