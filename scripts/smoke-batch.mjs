import { WechatMpService } from '../dist/core/service.js';

const svc = new WechatMpService();
const r = await svc.searchArticles({ query: '量子计算', count: 2 });
const urls = r.hits.filter((h) => h.url).map((h) => h.url);
console.log('搜索到的链接数:', urls.length);

// 混入一条必然失败的链接，验证失败隔离
const batch = await svc.fetchBatch([...urls, 'https://mp.weixin.qq.com/s?__biz=fake&mid=1&idx=1&sn=x']);
console.log(`requested=${batch.requested} ok=${batch.ok} failed=${batch.failed}`);
for (const it of batch.items) {
  console.log(it.ok ? `  OK   ${it.article.title} (${it.article.wordCount} 字)` : `  FAIL ${it.error.code}: ${it.error.message}`);
}

// 缓存命中验证：第二次应显著更快
const t0 = Date.now();
await svc.fetch(urls[0]);
console.log('缓存命中耗时:', Date.now() - t0, 'ms');
