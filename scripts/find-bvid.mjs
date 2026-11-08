// 找一个真实存在的音乐分区视频，用于 CDN 探测
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const H = {
  'User-Agent': UA,
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
};

const main = async () => {
  // 音乐区 tid=3 的热门
  const r = await fetch(
    'https://api.bilibili.com/x/web-interface/ranking/v2?rid=3&type=all',
    { headers: H }
  );
  const t = await r.text();
  console.log('http=', r.status, 'len=', t.length);
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    console.log('not json:', t.slice(0, 400));
    return;
  }
  console.log('code=', j.code, 'msg=', j.message);
  const list = j.data?.list || [];
  console.log('count=', list.length);
  for (const v of list.slice(0, 8)) {
    console.log(`  ${v.bvid}  ${v.title?.slice(0, 40)}  cid=${v.cid}`);
  }
};
main().catch((e) => console.error('FATAL', e.message));
