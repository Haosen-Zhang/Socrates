// Preview GitHub-rendered HTML saved as /tmp/socrates-readme-{en,zh}.html.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.SOCRATES_PLAYWRIGHT_MODULE ?? 'playwright');
const root=resolve('.'), out=resolve('output/playwright/personas');
const css=`*{box-sizing:border-box}body{margin:0;background:#fff;color:#1f2328;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}article{max-width:1012px;margin:24px auto;padding:32px;border:1px solid #d1d9e0;border-radius:8px}h2{font-size:24px;margin:40px 0 16px;padding-bottom:8px;border-bottom:1px solid #d1d9e0}p,ul,table,details{margin:16px 0}li+li{margin-top:8px}a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}img{max-width:100%;height:auto;border-radius:6px}pre{padding:16px;border-radius:6px;background:#f6f8fa;overflow:auto;font-size:14px;line-height:1.5}code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:85%}p code,li code{background:#eff1f3;padding:2px 5px;border-radius:4px}table{display:block;max-width:100%;overflow:auto;border-collapse:collapse}td,th{padding:10px 16px;border:1px solid #d1d9e0}tr:nth-child(2n){background:#f6f8fa}summary{cursor:pointer}sub{font-size:12px;color:#656d76}hr{border:0;height:1px;background:#d1d9e0;margin:32px 0}@media(max-width:600px){article{margin:0;padding:16px;border:0;border-radius:0}h2{font-size:22px}body{font-size:15px}}`;
for(const locale of ['en','zh']){
 let html=readFileSync(`/tmp/socrates-readme-${locale}.html`,'utf8');
 html=html.replaceAll('href="README.zh-CN.md"',`href="${pathToFileURL(`${out}/readme-zh.html`)}"`).replaceAll('href="README.md"',`href="${pathToFileURL(`${out}/readme-en.html`)}"`);
 writeFileSync(`${out}/readme-${locale}.html`,`<!doctype html><html lang="${locale==='en'?'en':'zh-CN'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><base href="${pathToFileURL(`${root}/`)}"><title>Socrates — ${locale==='en'?'English':'中文'}</title><style>${css}</style><article>${html}</article></html>`);
}
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1180,height:950},deviceScaleFactor:1});
const checks=[];
try{
 for(const locale of ['en','zh']){
  for(const width of [1180,390]){
   await page.setViewportSize({width,height:950});
   await page.goto(pathToFileURL(`${out}/readme-${locale}.html`).href);
   await page.evaluate(()=>Promise.all([...document.images].map(img=>img.decode().catch(()=>{}))));
   const state=await page.evaluate(()=>({images:[...document.images].every(i=>i.complete&&i.naturalWidth>0),overflow:document.documentElement.scrollWidth>innerWidth}));
   checks.push({locale,width,...state});
   if(!state.images||state.overflow)throw Error(JSON.stringify(state));
   await page.screenshot({path:`${out}/readme-${locale}-${width}.png`,fullPage:true});
   if(width===1180)await page.screenshot({path:`${out}/readme-${locale}-top.png`});
  }
 }
 await page.goto(pathToFileURL(`${out}/readme-en.html`).href);
 await page.getByRole('link',{name:'简体中文',exact:true}).first().click();
 checks.push({languageSwitch:await page.locator('html').getAttribute('lang')==='zh-CN'});
 await page.getByRole('link',{name:'English',exact:true}).first().click();
 checks.push({switchBack:await page.locator('html').getAttribute('lang')==='en'});
 for(const name of ['hero-en','hero-zh-CN','personas-en','personas-zh-CN','workflow-en']){
  await page.setViewportSize({width:1600,height:name.startsWith('hero')?740:name.startsWith('personas')?630:290});
  await page.goto(pathToFileURL(`${root}/doc/assets/readme/${name}.svg`).href);
  await page.screenshot({path:`${out}/${name}.png`});
 }
 for(const file of ['README.md','README.zh-CN.md']){
  const source=readFileSync(file,'utf8');
  const links=[...source.matchAll(/(?:href|src)="([^"]+)"|\]\(([^)]+)\)/g)].map(m=>m[1]??m[2]).filter(s=>!/^https?:|^#/.test(s));
  const missing=links.filter(s=>!existsSync(resolve(root,s.split('#')[0])));
  checks.push({file,localLinks:links.length,missing});if(missing.length)throw Error(missing.join(', '));
 }
 writeFileSync(`${out}/readme-checks.json`,JSON.stringify(checks,null,2));console.log(JSON.stringify(checks,null,2));
}finally{await browser.close();}
