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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.material.icons.filled.ExitToApp
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Person
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
import androidx.compose.runtime.LaunchedEffect
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
import kotlinx.coroutines.delay

/** 「我的」：登录状态、链接导入、同步入口 */
@Composable
fun MeScreen(
    vm: BiliViewModel,
    onOpenSync: () -> Unit,
) {
    val nav by vm.nav.collectAsState()
    val bili = vm.bili
    var loginInfo by remember { mutableStateOf<Pair<String, String>?>(null) }
    var loginState by remember { mutableStateOf("") }
    var showLogin by remember { mutableStateOf(false) }
    var importOpen by remember { mutableStateOf(false) }
    var importText by remember { mutableStateOf("") }
    var crashOpen by remember { mutableStateOf(false) }
    var crashText by remember { mutableStateOf("") }
    val libRev by vm.libRevision.collectAsState()
    val stats = remember(libRev) { vm.lib.stats() }
    val busy by vm.busy.collectAsState()

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        TopBar("我的") {
            IconButton(onClick = { vm.loadFolders() }) {
                Icon(Icons.Filled.Refresh, null, tint = TextSecondary)
            }
        }

        // 账号卡片
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp).clip(RoundedCornerShape(14.dp))
                .background(BgPanel).padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier.size(52.dp).clip(CircleShape).background(Brand.copy(alpha = 0.18f)),
                contentAlignment = Alignment.Center,
            ) {
                if (nav?.isLogin == true && nav?.face?.isNotBlank() == true) {
                    Cover(nav!!.face, Modifier.size(52.dp).clip(CircleShape), placeholder = "")
                } else {
                    Icon(Icons.Filled.Person, null, tint = Brand, modifier = Modifier.size(26.dp))
                }
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    if (nav?.isLogin == true) nav!!.uname else "未登录",
                    color = TextPrimary, fontSize = 16.sp, fontWeight = FontWeight.Medium,
                )
                Text(
                    if (nav?.isLogin == true) "UID ${nav!!.mid} · Lv${nav!!.level}" else "登录后才能同步收藏夹",
                    color = TextSecondary, fontSize = 11.sp,
                )
            }
            if (nav?.isLogin == true) {
                IconButton(onClick = { vm.logout() }) {
                    Icon(Icons.Filled.ExitToApp, "退出", tint = TextSecondary)
                }
            } else {
                Button(
                    onClick = { showLogin = true },
                    colors = ButtonDefaults.buttonColors(containerColor = Brand),
                    shape = RoundedCornerShape(18.dp),
                ) { Text("扫码登录", color = Color.White, fontSize = 12.sp) }
            }
        }

        Spacer(Modifier.height(14.dp))

        // 功能入口
        CardItem("链接收藏", "粘贴 BV 号 / av 号 / b23.tv 短链", Icons.Filled.Link) { importOpen = true }
        CardItem("跨设备同步", "局域网直连，不需要服务器", Icons.Filled.Sync) { onOpenSync() }
        CardItem("崩溃日志", "上次异常时自动记录，可复制发出来", Icons.Filled.BugReport) {
            crashText = com.bilimusic.player.CrashLog.read(com.bilimusic.player.App.ctx())
            crashOpen = true
        }

        Spacer(Modifier.height(14.dp))
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp).clip(RoundedCornerShape(14.dp))
                .background(BgPanel).padding(16.dp),
        ) {
            StatCol("曲目", stats.tracks.toString())
            StatCol("歌单", stats.playlists.toString())
            StatCol("喜欢", stats.loved.toString())
            StatCol("设备", stats.device)
        }
        Spacer(Modifier.height(80.dp))
    }

    if (showLogin) {
        LoginDialog(
            onDismiss = { showLogin = false },
            onQr = { loginInfo = it },
            qr = loginInfo,
            state = loginState,
            onRefresh = {
                // 重新取码
                loginInfo = null
                loginState = "正在获取二维码…"
            },
            poll = { key ->
                val r = bili.qrPoll(key)
                loginState = r.message
                if (r.state == com.bilimusic.player.net.BiliClient.QrState.OK) {
                    vm.refreshNavSuspend()
                    showLogin = false
                }
                r.state
            },
            generate = {
                val (url, key) = bili.qrGenerate()
                loginInfo = url to key
                loginState = "打开 B 站 App 扫码"
                url to key
            },
        )
    }

    if (importOpen) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { importOpen = false },
            title = { Text("链接收藏", color = TextPrimary) },
            text = {
                Column {
                    androidx.compose.material3.OutlinedTextField(
                        value = importText,
                        onValueChange = { importText = it },
                        label = { Text("BV 号 / av 号 / 短链（可多行）") },
                        minLines = 3,
                        maxLines = 6,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (busy != null) {
                        Spacer(Modifier.height(8.dp))
                        Text(busy ?: "", color = TextSecondary, fontSize = 12.sp)
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    importOpen = false
                    val text = importText
                    importText = ""
                    // 导入成功后直接跳「我的库」：这些歌不属于任何歌单，
                    // 不跳过去用户根本不知道它们躺在哪儿（曾报「导入后没显示」）
                    vm.importLink(text)
                }) {
                    Text("导入", color = Brand)
                }
            },
            dismissButton = { TextButton(onClick = { importOpen = false }) { Text("取消", color = TextSecondary) } },
            containerColor = BgPanel,
        )
    }

    if (crashOpen) {
        val clip = androidx.compose.ui.platform.LocalClipboardManager.current
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { crashOpen = false },
            title = { Text("崩溃日志", color = TextPrimary) },
            text = {
                Column {
                    if (crashText.isBlank()) {
                        Text("没有崩溃记录，一切正常。", color = TextSecondary, fontSize = 13.sp)
                    } else {
                        androidx.compose.material3.Text(
                            crashText.take(4000),
                            color = TextSecondary,
                            fontSize = 10.sp,
                            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        clip.setText(androidx.compose.ui.text.AnnotatedString(crashText))
                        vm.toast("已复制到剪贴板")
                        crashOpen = false
                    },
                    enabled = crashText.isNotBlank(),
                ) { Text("复制", color = Brand) }
            },
            dismissButton = {
                TextButton(onClick = {
                    com.bilimusic.player.CrashLog.clear(com.bilimusic.player.App.ctx())
                    crashText = ""
                    vm.toast("已清空")
                }) { Text("清空", color = TextSecondary) }
            },
            containerColor = BgPanel,
        )
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.StatCol(label: String, value: String) {
    Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, color = Brand, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        Text(label, color = TextSecondary, fontSize = 11.sp)
    }
}

@Composable
private fun CardItem(title: String, sub: String, icon: androidx.compose.ui.graphics.vector.ImageVector, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(12.dp)).background(BgPanel).clickable(onClick = onClick)
            .padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(38.dp).clip(RoundedCornerShape(10.dp)).background(Brand.copy(alpha = 0.15f)),
            contentAlignment = Alignment.Center,
        ) { Icon(icon, null, tint = Brand, modifier = Modifier.size(18.dp)) }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = TextPrimary, fontSize = 14.sp)
            Text(sub, color = TextSecondary, fontSize = 11.sp)
        }
    }
}

/** 扫码登录对话框：拿码 → 轮询 */
@Composable
fun LoginDialog(
    onDismiss: () -> Unit,
    onQr: (Pair<String, String>) -> Unit,
    qr: Pair<String, String>?,
    state: String,
    onRefresh: () -> Unit,
    poll: suspend (String) -> com.bilimusic.player.net.BiliClient.QrState,
    generate: suspend () -> Pair<String, String>,
) {
    LaunchedEffect(Unit) {
        if (qr == null) {
            runCatching { generate() }
        }
    }
    // 每 2 秒问一次
    LaunchedEffect(qr) {
        val key = qr?.second ?: return@LaunchedEffect
        while (true) {
            delay(2000)
            val st = runCatching { poll(key) }.getOrNull() ?: continue
            if (st == com.bilimusic.player.net.BiliClient.QrState.EXPIRED) break
            if (st == com.bilimusic.player.net.BiliClient.QrState.OK) break
        }
    }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("扫码登录", color = TextPrimary) },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                if (qr != null) {
                    QrCode(qr.first, 220.dp, "登录二维码")
                } else {
                    Box(Modifier.size(220.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = Brand)
                    }
                }
                Spacer(Modifier.height(12.dp))
                Text(state.ifEmpty { "打开 B 站 App 扫码" }, color = TextSecondary, fontSize = 12.sp)
            }
        },
        confirmButton = { TextButton(onClick = onRefresh) { Text("刷新二维码", color = Brand) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("关闭", color = TextSecondary) } },
        containerColor = BgPanel,
    )
}
