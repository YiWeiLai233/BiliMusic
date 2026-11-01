// 验证「本应用内隐藏收藏夹条目」的数据层行为
const path = require('node:path');
const fs = require('node:fs');
const { Library } = require('../src/library');

const tmp = path.join(__dirname, '..', '.userdata', 'hidden-test.json');
try { fs.unlinkSync(tmp); } catch {}

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name); } };

const lib = new Library(tmp);

// 1. 初始为空
ok(lib.hiddenCount() === 0, '初始隐藏数为 0');
ok(Array.isArray(lib.hiddenKeys(1001)) && lib.hiddenKeys(1001).length === 0, 'hiddenKeys 返回空数组');

// 2. 隐藏单 P 条目
lib.hideFavItem(1001, { key: 'BVaaa', bvid: 'BVaaa', page: 1, title: '单P视频' });
ok(lib.hiddenCount() === 1, '隐藏一个后计数 1');
ok(lib.hiddenKeys(1001).join() === 'BVaaa', 'hiddenKeys 含 BVaaa');
ok(lib.hiddenKeys(1002).length === 0, '别的收藏夹不受影响');

// 3. 隐藏分 P 条目（key 带 :pN，与视频本身解耦）
lib.hideFavItem(1001, { key: 'BVbbb:p2', bvid: 'BVbbb', page: 2, title: '多P第2P' });
ok(lib.hiddenCount() === 2, '隐藏分 P 后计数 2');
ok(lib.hiddenKeys(1001).includes('BVbbb:p2'), 'hiddenKeys 含分 P 键');
ok(!lib.hiddenKeys(1001).includes('BVbbb'), '分 P 隐藏不连带整个视频');

// 4. 记录内容完整
const items = lib.hiddenItems(1001);
ok(items.length === 2, 'hiddenItems 返回 2 条');
ok(items.every((h) => h.folderId === '1001'), 'folderId 统一成字符串');
ok(items.some((h) => h.title === '多P第2P' && h.page === 2), '保存了标题和分 P 号');
ok(typeof items[0].hiddenAt === 'number' && items[0].hiddenAt > 0, '记录了隐藏时间');

// 5. 持久化：重开文件还在
const lib2 = new Library(tmp);
ok(lib2.hiddenCount() === 2, '重开库文件后隐藏记录还在');
ok(lib2.hiddenKeys(1001).length === 2, '重开后 hiddenKeys 正确');

// 6. 单体取消隐藏
lib2.unhideFavItem(1001, 'BVaaa');
ok(lib2.hiddenCount() === 1, '取消一个后计数 1');
ok(lib2.hiddenKeys(1001).join() === 'BVbbb:p2', '只剩分 P 那个');

// 7. 清空某个收藏夹
lib2.hideFavItem(1002, { key: 'BVccc', bvid: 'BVccc', title: '二号夹' });
ok(lib2.hiddenCount() === 2, '两个收藏夹各有隐藏');
lib2.clearHidden(1001);
ok(lib2.hiddenCount() === 1, '只清 1001 后还剩 1002 的');
ok(lib2.hiddenKeys(1002).length === 1, '1002 的仍在');

// 8. 全清
lib2.clearHidden();
ok(lib2.hiddenCount() === 0, 'clearHidden() 全清');

// 9. stats 带 hidden
lib2.hideFavItem(1001, { key: 'BVddd', bvid: 'BVddd' });
ok(lib2.stats().hidden === 1, 'stats().hidden 正确');

// 10. 老库（没有 favHidden 字段）也能读
fs.writeFileSync(tmp, JSON.stringify({ version: 2, folders: [], local: {}, bili: {}, playlists: {} }), 'utf8');
const lib3 = new Library(tmp);
ok(lib3.hiddenCount() === 0, '缺少 favHidden 字段的老库能正常读');
lib3.hideFavItem(9, { key: 'BVeee', bvid: 'BVeee' });
ok(lib3.hiddenCount() === 1, '老库也能写入隐藏记录');

try { fs.unlinkSync(tmp); } catch {}
console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURE'}  ${pass} passed, ${fail} failed`);
console.log('HIDDEN_LIB_OK:', fail === 0);
