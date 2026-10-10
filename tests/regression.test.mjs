import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawn} from 'node:child_process';
import {HttpClient} from '../dist/core/http.js';
import {SogouClient} from '../dist/core/sogou.js';
import {ArticleClient} from '../dist/core/article.js';
import {WechatMpService} from '../dist/core/service.js';
import {DEFAULT_CONFIG} from '../dist/core/config.js';
import {WechatError} from '../dist/core/errors.js';
import {RequestGate} from '../dist/core/safety.js';
const dirs=[];
const config=(extra={})=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-test-'));dirs.push(dir);return {...DEFAULT_CONFIG,proxy:undefined,minIntervalMs:0,retries:0,safetyDir:dir,cache:{enabled:false,dir:path.join(dir,'cache'),ttlMinutes:10},...extra}};
const originalFetch=globalThis.fetch;
test.after(()=>{globalThis.fetch=originalFetch;for(const d of dirs)fs.rmSync(d,{recursive:true,force:true})});
const body='<h1 id="activity-name">fixture</h1><div id="js_content">正文</div>';
test('reject spoofed URL without sending a request',async()=>{
 let n=0;globalThis.fetch=async()=>{n++;return new Response(body)};const c=config({wxmpCookie:'FAKE=1'});const a=new ArticleClient(new HttpClient(c),c);
 for(const url of ['https://example.invalid/mp.weixin.qq.com/s/x','https://mp.weixin.qq.com.evil.invalid/s/x','https://mp.weixin.qq.com@evil.invalid/s/x','http://mp.weixin.qq.com/s/x'])await assert.rejects(()=>a.fetch(url),{code:'BAD_URL'});
 assert.equal(n,0);
});
test('image requests never carry wx cookie',async()=>{
 const seen=[];globalThis.fetch=async(u,o)=>{seen.push(o.headers);return new Response('image')};const c=config({wxmpCookie:'FAKE=1'});
 await new HttpClient(c).get('https://mmbiz.qpic.cn/a',{cookieFrom:'wxmp'});assert.equal(seen[0].Cookie,undefined);
});
test('unsafe redirect is rejected before following',async()=>{
 let n=0;globalThis.fetch=async()=>{n++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/'}})};
 await assert.rejects(()=>new HttpClient(config()).get('https://mp.weixin.qq.com/s/x'),{code:'BAD_URL'});assert.equal(n,1);
});
test('Sogou link JS is parsed without search-page requirement',async()=>{
 const sg=new SogouClient({get:async()=>({url:'https://weixin.sogou.com/link?url=x',text:`<script>url += 'https://mp.weixin.qq.com/s/demo';</script>`})});
 assert.equal(await sg.resolveLink('https://weixin.sogou.com/link?url=x'),'https://mp.weixin.qq.com/s/demo');
});
test('search cache preserves all results when first count is one',async()=>{
 const svc=new WechatMpService(config());const cache=new Map();svc.cache.get=k=>cache.get(k);svc.cache.set=(k,v)=>cache.set(k,v);
 svc.sogou.searchArticles=async()=>Array.from({length:10},(_,i)=>({title:`T${i}`,url:`https://mp.weixin.qq.com/s/${i}`}));
 assert.equal((await svc.searchArticles({query:'x',count:1,engine:'sogou'})).count,1);
 assert.equal((await svc.searchArticles({query:'x',count:10,engine:'sogou'})).count,10);
});
test('same-process parallel calls are paced',async()=>{
 const times=[];globalThis.fetch=async()=>{times.push(Date.now());return new Response('ok')};const http=new HttpClient(config({minIntervalMs:50}));
 await Promise.all(Array.from({length:4},()=>http.get('https://mp.weixin.qq.com/s/x')));
 for(let i=1;i<times.length;i++)assert.ok(times[i]-times[i-1]>=40,JSON.stringify(times));
});
test('independent processes share limiter state',async()=>{
 const c=config({minIntervalMs:80});const module=new URL('../dist/core/safety.js',import.meta.url).href;
 const run=()=>new Promise((resolve,reject)=>{const s=spawn(process.execPath,['--input-type=module','-e',`import {RequestGate} from ${JSON.stringify(module)}; await new RequestGate(${JSON.stringify(c)}).enter('https://mp.weixin.qq.com/s/x');console.log(Date.now())`]);let out='';s.stdout.on('data',d=>out+=d);s.on('error',reject);s.on('exit',code=>code?reject(Error('child '+code)):resolve(Number(out.trim())))});
 const times=(await Promise.all([run(),run(),run()])).sort();for(let i=1;i<times.length;i++)assert.ok(times[i]-times[i-1]>=65,JSON.stringify(times));
});
test('429 cooldown is shared and no retry is made',async()=>{
 let n=0;globalThis.fetch=async()=>{n++;return new Response('limited',{status:429,headers:{'retry-after':'3600'}})};const c=config({retries:2});
 await assert.rejects(()=>new HttpClient(c).get('https://weixin.sogou.com/'),{code:'RATE_LIMITED'});
 await assert.rejects(()=>new HttpClient(c).get('https://www.sogou.com/web'),{code:'RATE_LIMITED'});assert.equal(n,1);
 const state=JSON.parse(fs.readFileSync(path.join(c.safetyDir,'sogou.json')));assert.ok(state.until-Date.now()>3599000);
});
test('body read timeout remains active after headers',async()=>{
 globalThis.fetch=async(u,o)=>new Response(new ReadableStream({start(controller){o.signal.addEventListener('abort',()=>controller.error(new DOMException('aborted','AbortError')))}}));
 await assert.rejects(()=>new HttpClient(config({timeoutMs:30})).get('https://mp.weixin.qq.com/s/x'),{code:'TIMEOUT'});
});
test('verification stops UA retries and next batch item',async()=>{
 let n=0;globalThis.fetch=async()=>{n++;return new Response('环境异常 去验证')};const svc=new WechatMpService(config());
 await assert.rejects(()=>svc.fetchBatch(['https://mp.weixin.qq.com/s/a','https://mp.weixin.qq.com/s/b']),{code:'WX_VERIFY_REQUIRED'});assert.equal(n,1);
});
test('blocked link resolution terminates batch',async()=>{
 let n=0;const sg=new SogouClient({});sg.resolveLink=async()=>{n++;throw new WechatError('SOGOU_BLOCKED','blocked')};
 await assert.rejects(()=>sg.resolveAll(Array.from({length:5},()=>({title:'x',url:'',sogouLink:'x'})),5),{code:'SOGOU_BLOCKED'});assert.equal(n,1);
});
test('request budget is enforced',async()=>{
 const gate=new RequestGate(config({maxRequestsPerHour:1}));await gate.enter('https://mp.weixin.qq.com/s/a');await assert.rejects(()=>gate.enter('https://mp.weixin.qq.com/s/b'),{code:'RATE_LIMITED'});
});
test('web fallback cannot silently ignore requested time range',async()=>{
 await assert.rejects(()=>new WechatMpService(config()).searchArticles({query:'x',engine:'bing',timeRange:'week'}),{code:'BAD_URL'});
});
test('backend page offset and nextBegin are preserved',async()=>{
 const svc=new WechatMpService(config({backend:{cookie:'FAKE',token:'FAKE'}}));svc.backend.searchAccount=async()=>[{nickname:'fixture',fakeid:'1'}];
 svc.backend.listArticles=async(fakeid,begin,count)=>{assert.equal(begin,20);assert.equal(count,20);return {total:50,items:Array.from({length:20},()=>({title:'x',link:'https://mp.weixin.qq.com/s/x'}))}};
 const r=await svc.listAccountArticles('fixture',{begin:20,count:30});assert.equal(r.nextBegin,40);assert.equal(r.count,20);
});
test('bundled program reads config beside bin folder',()=>{
 const file=new URL('../config.json',import.meta.url);assert.equal(fs.existsSync(file),false);
 try{fs.writeFileSync(file,JSON.stringify({minIntervalMs:4567}));const r=JSON.parse(execFileSync(process.execPath,[new URL('../bin/wechat-mp-cli.mjs',import.meta.url).pathname,'status'],{encoding:'utf8'}));assert.equal(r.config.minIntervalMs,4567)}finally{fs.rmSync(file,{force:true})}
});
test('bundled MCP server initializes and exposes all seven tools', async()=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
 const client=new Client({name:'regression',version:'1'});
 try {
  await client.connect(new StdioClientTransport({command:process.execPath,args:[new URL('../bin/wechat-mp.mjs',import.meta.url).pathname]}));
  assert.equal((await client.listTools()).tools.length,7);
  const r=await client.callTool({name:'wechat_status',arguments:{}});assert.equal(JSON.parse(r.content[0].text).ok,true);
 }finally{await client.close()}
});
