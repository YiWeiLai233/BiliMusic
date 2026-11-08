# 无服务器两端歌单同步 —— 设计说明

> 目标：电脑端（Electron）和手机端（Android）各自离线改歌单，**不经过任何服务器**也能收敛到同一份数据。

## 为什么难

普通做法是「服务器存一份权威数据，两端都往它上面改」。没有服务器就没有权威副本，于是两个问题立刻冒出来：

1. **冲突**：A 把歌单改名为「通勤」，B 同时改成「早班车」，谁是最终值？
2. **删除会复活**：A 删掉了某首歌，B 还留着，下次同步时 B 会把这首歌当作「新数据」推回来。

第二个问题比第一个更阴险，只要用「取并集」的朴素同步就一定会踩到。

## 解法：CRDT 状态合并

核心思路只有一句：**不让两端交换「改动」，而是交换「整份状态」，并且让合并函数满足交换律、结合律、幂等。**

满足这三条，就得到：

- 谁先同步、谁后同步，结果一样（交换律）
- 同步两次、三次，结果还是一样（幂等）
- 三台设备 A↔B、B↔C，A 和 C 从没直连过，也能通过 B 收敛（结合律）

也就是说 **不需要服务器，也不需要「谁是对的」这种判决**。

### 三个原语

| 原语 | 用途 | 合并方式 |
|---|---|---|
| `Reg<T>` 末次写入胜（LWW） | 歌单标题、曲目元信息、喜欢/取消 | 比较 `(ts, by)`，大者胜 |
| `TrackEntry` / `MarkEntry` | 曲目表、喜欢表 | `present` 布尔也是 LWW，`false` 就是墓碑 |
| `ItemEntry` + 分数位置 | 歌单里的曲目与顺序 | 位置是字符串坐标，删一条不影响别人的坐标 |

### 时间戳：混合逻辑时钟（HLC）

单纯用设备本地时间是错的——手机时间比电脑慢 5 分钟，那手机上的每次修改都会被电脑上更早的修改覆盖。

`Hlc(wall, counter)`：

```
tick(now):
    if now > wall: wall = now; counter = 0
    else:          counter += 1
```

每次本地写入 `tick()` 一次；收到对方文档时用 `observe(remote)` 把本地时钟推到不小于对方。这样即使设备时间倒退，「新写入」依然严格大于此前见过的一切时间戳。

两个时间戳完全相同时（两台设备同一毫秒写入），用 `deviceId` 字符串比大小定序——**任意两端算出来的胜者必须一致**，否则合并就不对称了。

### 删除：墓碑

删除不是从 map 里 `remove`，而是把 `present` 置 `false` 并打上新时间戳。

这样一来：

- B 还留着这首歌 → 合并时 `present` 比较，墓碑更新 → 删除生效，不会复活
- 用户后悔了 → 再置 `true` 打新时间戳即可「撤销删除」，比另一个设备的墓碑新，于是复活

墓碑会一直留着（很小，一个 bool + 时间戳）。`vacuum(maxAgeDays = 90)` 可以清掉超过 90 天的墓碑，前提是**确保所有设备在此期间至少同步过一次**。

### 顺序：分数位置键

歌单顺序不能存数组下标。因为两端各自删了不同的歌，下标就错位了，合并时 `pos` 全变，顺序会乱成一团。

改成给每个成员一个可比较的坐标，新插入时取前后两个坐标的中间值：

```
between(a, b):          # a 是前一个，b 是后一个，null 表示该侧无界
    逐位比较 a[i] 和 b[i]
    找到第一个差 >= 2 的位置 → 取中点
    没有空隙 → 在 a 后面追加一位再取中点
```

坐标编码成 base36 字符串（`"12.5.z"`），作为普通字符串参与 LWW 合并。删除一条不影响任何其他条的坐标，插到中间也不需要重排别人。

## 落地形态

### 数据流

```
用户操作 → AppLibrary（内存里唯一一份 SyncDoc）
              ↓ tick() 打时间戳
           写各原语
              ↓
      library.json（.tmp + rename 原子写）
```

`AppLibrary` 只维护**一份** `SyncDoc`，不额外维护「方便 UI 的镜像结构」。两份结构一定会不同步，那是 bug 的温床。

### 并发

`SyncServer` 是固定 4 线程池，主动同步（`syncNow`）和「吃同步码」（`importCode`）又各起裸线程——两台设备同时连过来时会有多个线程一起 merge。所以 `AppLibrary` 上所有会改 `doc` 或落盘的方法都是 `@Synchronized`。

这不是防御性编程：没有锁就是「读 doc → 算 → 写 doc」的经典丢更新，而且两个线程会往同一个 `.tmp` 里写，能把库文件写坏。回归测试 `concurrent_writes_do_not_lose_updates` 用 8 线程 × 50 次写入钉住了这条。

（桌面端不需要：Node 是单线程事件循环，`mergeRemote` 全程同步，请求天然串行。）

### 三种传输通道

| 通道 | 适用 | 实现 |
|---|---|---|
| 局域网直连 | 两台设备在同一 Wi-Fi | `SyncServer`（HTTP POST /sync）+ `SyncDiscovery`（UDP 广播发现） |
| 配对二维码 | 扫一下就配对 | 二维码内容是 `bilimusic://pair?ip=..&port=..&token=..`；桌面端渲染（`qrcode`），手机端用 CameraX + zxing 扫（`ScanPairScreen`） |
| 文本同步码 | 不在同一网络（异地） | 整份状态 → deflate → base64url，直接粘微信/QQ |

三者共用同一份二进制载荷，所以**任何一条通道同步过的数据，都能被另一条通道继续接力**。

配对串解析走了独立的一层 `PairUri`（纯函数，12 个单测钉住），因为扫码能扫到任何东西：

- 兼容带/不带 scheme、只贴参数、`host=1.2.3.4:5678` 内嵌端口、key 大小写、`ip|host|addr` 与 `token|pass|key` 别名、`%XX` 转义；
- 只认 IPv4 字面量，避免被奇怪二维码骗去连外网域名；
- **带 `://` 但不是 `bilimusic` 的一律拒绝**——B 站视频链接 `https://www.bilibili.com/video/BV..?p=2&token=x&port=1&ip=1.2.3.4` 的 query 恰好能凑齐三个字段，不设这道闸就会把它当配对串去连。

### 载荷格式

```
[0] 'B'  [1] 'M'  [2] 版本  [3] flags  [4] seq  [5] total  [6..9] CRC32
[10..] deflate(JSON) 或 原文 JSON
```

- 大于 96 字节才压缩；压缩后反而更大就不压缩
- CRC32 覆盖正文，复制粘贴丢字符能立刻发现，坏数据绝不会合进库
- `flags` 的 bit1 表示「这是分片」，`seq/total` 给二维码分片用（最多 255 片）

### HTTP 协议

```
GET /ping                  → 200 "ok"（免 token，用于探测对端在不在）
POST /sync                 → 请求体是本地整份载荷，响应体是合并后整份
     header: X-Sync-Token: <配对时生成的 12 位口令>
```

服务端收到请求就做 `merge(本地, 对方)` 并落盘，然后回发 `合并后的整份`。所以**一次 POST 就完成了双向交换**：调用方拿到响应再 merge 一次，两端都收敛了。

`token` 只是防同 Wi-Fi 下陌生设备乱发数据，不是加密。载荷里没有敏感信息（只有 bvid 和歌单标题）。

### 为什么不用 mDNS

mDNS 要额外引库，而且不少家用路由器直接拦组播。私有 UDP 广播（端口 41789）最简单：同时发 `255.255.255.255` 和子网定向广播 `x.x.x.255`，每 2 秒一次，10 秒没听到就下线。广播包内容 `BILIMUSIC1|port|token|name` —— 带 token，别人捡到也用不了。

## 与桌面端互通（已落地）

桌面端（Electron）原本用 `src/library.js` 的 JSON 结构（`folders`/`local`/`bili`/`playlists`/`favTracks`/`lovedManual`/`loveExcluded`……），是**数组下标 + 分类 map** 模型；安卓这里的是**键 + 分数位置** 模型。两端要交换同一份载荷，中间需要一个双向投影层：

- `src/sync.js` —— 与 `android/.../sync/` 逐行等价的 JS 实现（Hlc / Pos / Merger / Codec，同一套二进制格式与 CRC32）。
- `src/syncBridge.js` —— 投影层。`SyncBridge.captureLocal()` 把桌面库**差量**写进 `SyncDoc`，`applyDoc()` 把 `SyncDoc` 写回桌面库；`SyncServer` + `SyncDiscovery` + `exchange()` 与安卓端同一套 HTTP/UDP 协议。
- 桌面端连 `qrcode` 渲染 `bilimusic://pair?...`，手机端 CameraX + zxing 扫，扫完直接 `syncWith(ip, port, token)`。

两个关键坑（都踩过、都修了）：

1. **差量必须有基线**。`captureLocal()` 如果每次都拿「库的当前内容」和「doc」对比，就等于把本地状态重新断言一遍——对方刚删掉的歌单在本地还活着，就会被一个**更新的时间戳**顶回去，删除永远传播不了。所以 `SyncBridge` 维护 `baseline`（上一次同步后库应长什么样的规范化快照），只写相对基线的变化；`applyDoc()` 结束时也刷新基线。兜底值必须用 `new Set()` 而不是 `{}`，否则 `baseLoved.has` 直接 TypeError。
2. **墓碑必须随载荷发出**。`exportCompact()` 原实现调了 `.compact()`，把 `present=false` 的记录滤掉了——对端只会看到「没有这条」，它本地活着的拷贝永远删不掉。两端都改成导出时保留墓碑，回收交给 `vacuum()`。

互通是**双向实测**过的，不是纸上对齐：

- `scripts/gen-sync-fixture.js` 生成桌面端同步码 → `android/app/src/test/resources/desktop-sync-code.txt` → `SyncMergeTest.can_decode_fixture_produced_by_desktop` 断言曲目、多 P 标题、歌单键序、爱心全部正确。
- 反向：`SyncMergeTest.write_fixture_for_desktop` 产出安卓同步码 → 手工落到 `fixtures/android-sync-code.txt` → `scripts/test-sync.js` 第 9 节断言同样字段，并真的 `importCode` 进一个新的桌面 Library 验证落库。

## 测试覆盖

`SyncMergeTest.kt` 27 个用例，重点验证的是「数学性质」而不是具体例子：

- 交换律 `merge(a,b) == merge(b,a)`
- 结合律 `merge(merge(a,b),c) == merge(a,merge(b,c))`
- 幂等 `merge(a,a) == a`
- 并发编辑取新、同时间戳按 deviceId 定序
- 墓碑防复活、撤销删除、**删除跨端传播（`export_keeps_tombstones_so_deletion_propagates`）**
- 分数位置：严格有序、同一缝隙连插 40 次不乱序、编解码往返、相邻值不死循环
- 编解码：往返、压缩比、坏数据拒绝、外来文本拒绝
- 二维码分片：乱序重组、进度、缺片报错
- HLC：时钟倒退仍单调、observe 前进、同毫秒 counter 递增
- 三设备两轮往返收敛
- 与桌面端的双向 fixture 互通（2 个）
- **多线程并发写入不丢数据、不写坏文件（`concurrent_writes_do_not_lose_updates`）**

`PairUriTest.kt` 12 个用例钉住配对串解析：标准串、额外字段乱序、无 scheme、host 内嵌端口、%XX 转义、缺字段、坏端口、非 IPv4、垃圾输入、**B 站视频二维码必须拒绝**、IPv4 校验边界、roundtrip。

```
./gradlew :app:testDebugUnitTest
```
（当前 39 个用例全绿；桌面端 `node scripts/test-sync.js` 63 项、`scripts/test-sync-ui.js` 29 项同样全绿。）
