// Run: bun scripts/readme/generate-assets.ts. No external images, fonts or services.
import { mkdirSync, writeFileSync } from 'node:fs';
import { agentAvatarFromSeed, renderAgentAvatarSvg } from '../../packages/core/src/agent-identity';
const output = new URL('../../doc/assets/readme/', import.meta.url);
mkdirSync(output, { recursive: true });
const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const text = (x: number, y: number, size: number, value: string, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" ${extra}>${esc(value)}</text>`;
const line = (x1: number, y1: number, x2: number, y2: number, extra = '') => `<path d="M${x1} ${y1}L${x2} ${y2}" fill="none" stroke="#34443b" ${extra}/>`;
function avatar(seed: string, x: number, y: number, size: number) {
  return renderAgentAvatarSvg(agentAvatarFromSeed(seed))!.replace('<svg ', `<svg x="${x}" y="${y}" width="${size}" height="${size}" `);
}
function svg(width: number, height: number, label: string, body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title><defs><radialGradient id="glow"><stop stop-color="#294432" stop-opacity=".65"/><stop offset="1" stop-color="#111913" stop-opacity="0"/></radialGradient><pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#556450" opacity=".22"/></pattern></defs><rect width="${width}" height="${height}" rx="18" fill="#111813"/><rect width="${width}" height="${height}" rx="18" fill="url(#grid)"/><g fill="#f2f3e9" font-family="'Avenir Next', 'Segoe UI', 'PingFang SC', sans-serif">${body}</g></svg>`;
}
for (const zh of [false, true]) {
  const locale = zh ? 'zh-CN' : 'en';
  let body = '<ellipse cx="1240" cy="350" rx="480" ry="390" fill="url(#glow)"/>';
  for (const [x,y] of [[72,54],[84,54],[96,54],[72,66],[96,78],[84,78],[72,90],[84,90],[96,90]]) body += `<rect x="${x}" y="${y}" width="9" height="9" fill="#c4f778"/>`;
  body += text(130, 84, 29, 'SOCRATES', 'letter-spacing="7" font-weight="600"');
  body += text(1520, 82, 16, zh ? '多模型讨论 · 多 AGENT 协作' : 'THE MULTI-AI DESKTOP WORKSPACE', 'text-anchor="end" letter-spacing="2" fill="#a0b19b"');
  body += line(72, 124, 1528, 124);
  body += text(72, 218, 17, zh ? '让每一种智慧，都有自己的声音。' : 'BETTER QUESTIONS. MORE PERSPECTIVES.', 'fill="#b7ccab" letter-spacing="2"');
  body += text(68, 340, zh ? 103 : 102, zh ? '一起思考。' : 'Think together.', 'font-weight="600" letter-spacing="-5"');
  body += text(68, 460, zh ? 103 : 110, zh ? '一起创造。' : 'Build together.', zh ? 'fill="#c4f778" font-weight="600" letter-spacing="-5"' : 'fill="#c4f778" font-family="Georgia, serif" font-style="italic" letter-spacing="-5"');
  body += text(74, 532, 24, zh ? '把不同模型请进同一个房间，' : 'Your favourite models, in the same room.', 'fill="#adbca5"');
  body += text(74, 568, 24, zh ? '让观点碰撞，让协作落地。' : 'From a lively discussion to work that gets done.', 'fill="#adbca5"');
  body += '<g stroke="#6b885e" fill="none"><circle cx="1240" cy="358" r="219" opacity=".4"/><circle cx="1240" cy="358" r="151" stroke-dasharray="3 10" opacity=".5"/><path d="M1240 170V288M1070 438L1192 369M1400 444L1284 370" stroke-width="2"/><path d="M1060 208L1416 516M1050 520L1400 208" opacity=".18"/></g>';
  body += '<circle cx="1240" cy="350" r="55" fill="#c4f778"/>';
  body += '<path d="M1214 331h52v32h-30l-14 12v-12h-8z" fill="none" stroke="#18251b" stroke-width="4"/><path d="M1225 343h30M1225 352h20" stroke="#18251b" stroke-width="3"/>';
  for (const [seed,x,y,label] of [['aurora',1188,154,zh?'架构师':'ARCHITECT'],['cobalt',1000,418,zh?'探索者':'EXPLORER'],['moss',1360,418,zh?'审阅者':'REVIEWER']] as const) {
    body += `<rect x="${x-8}" y="${y-8}" width="120" height="120" rx="10" fill="#111813" stroke="#5a7250"/>${avatar(seed,x,y,104)}`;
    body += text(x+52,y+139,15,label,'text-anchor="middle" fill="#b5c9a9" letter-spacing="2"');
  }
  body += '<circle cx="1104" cy="186" r="4" fill="#c4f778"/><circle cx="1450" cy="311" r="4" fill="#ffc49a"/><circle cx="1183" cy="571" r="4" fill="#8dccda"/>';
  body += line(72, 635, 1528, 635);
  body += text(74, 685, 20, zh ? '01  多 AI 讨论     /     02  多 Agent 协作     /     03  自定义角色' : '01  CHAT     /     02  WORK     /     03  YOUR CAST', 'letter-spacing="2"');
  body += text(1524, 685, 16, zh ? '你的模型。你的团队。你的决定。' : 'YOUR MODELS. YOUR TEAM. YOUR CALL.', 'text-anchor="end" fill="#a0b19b" letter-spacing="1"');
  writeFileSync(new URL(`hero-${locale}.svg`, output), svg(1600,740,zh?'Socrates：一起思考，一起创造':'Socrates: Think together. Build together.',body));

  const stages = zh ? ['讨论','拆分工作包','批准计划','成员执行','可选审核'] : ['DISCUSS','PLAN','APPROVE','EXECUTE','REVIEW'];
  body = text(64, 60, 15, zh ? 'WORK / 从想法到交付' : 'WORK / FROM INTENT TO DELIVERY', 'fill="#b7ccab" letter-spacing="3"');
  body += line(84, 143, 1504, 143, 'stroke-width="2"');
  const descriptions = zh ? ['汇集成员意见','Manager 分配责任','由你掌握决定权','在本地工作区处理','检查结果与返工'] : ['Compare perspectives','Manager assigns ownership','You stay in control','Agents work on local files','Check and refine'];
  stages.forEach((label,i)=>{const x=84+i*350;body+=`<circle cx="${x}" cy="143" r="23" fill="${i===2?'#c4f778':'#1d2a20'}" stroke="#6f8f5e"/>`;body+=text(x,150,18,`${i+1}`,'text-anchor="middle" fill="'+(i===2?'#111813':'#c4f778')+'"');const anchor=i===4?'end':i===0?'start':'middle';body+=text(x,207,25,label,`text-anchor="${anchor}" font-weight="600"`);body+=text(x,243,17,descriptions[i],`text-anchor="${anchor}" fill="#adbca5"`);});
  writeFileSync(new URL(`workflow-${locale}.svg`,output),svg(1600,290,zh?'讨论、计划、审批、执行、审核':'Discussion, planning, approval, execution and review',body));

  body=text(64,70,15,zh?'属于你的 AI 角色阵容':'A CAST THAT IS ENTIRELY YOURS','letter-spacing="3" fill="#b7ccab"');
  body+=text(60,165,zh?62:65,zh?'为智慧，赋予个性。':'Intelligence with', 'font-weight="600" letter-spacing="-2"');
  body+=text(60,245,76,zh?'不止一种面孔。':'a little character.', 'font-family="Georgia, PingFang SC, serif" font-style="italic" fill="#c4f778" letter-spacing="-2"');
  body+=text(64,310,22,zh?'自定义名字、头像、模型、角色与提示词。':'A name. A face. A model. A point of view.','fill="#b7c5ad"');
  body+=text(64,348,22,zh?'像素图案、经典角色，或上传你喜欢的图片。':'Generate a pixel identity, or upload your own.','fill="#b7c5ad"');
  for(const [i,seed,name,role] of [[0,'aurora',zh?'月影智者':'Lunar Sage',zh?'规划 · 架构':'PLANNING / ARCHITECTURE'],[1,'cobalt',zh?'晴空灵狐':'Azure Fox',zh?'研究 · 探索':'RESEARCH / EXPLORATION'],[2,'moss',zh?'青苔斥候':'Moss Scout',zh?'审阅 · 质疑':'REVIEW / CRITIQUE']] as const){const x=850+i*238;body+=avatar(seed,x,122,154);body+=text(x+77,315,23,name,'text-anchor="middle" font-weight="600"');body+=text(x+77,347,11,role,'text-anchor="middle" fill="#a8bda0" letter-spacing="1"');}
  body+=line(64,414,1536,414);
  for(let i=0;i<16;i++)body+=avatar(`gallery-${i}`,64+i*93,455,72);
  body+=text(64,587,17,zh?'2,048 种英文名字 + 2,048 种中文名字 · 图案与配色同时变化 · 本地生成':'2,048 English names + 2,048 Chinese names · Distinct shapes and colours · Generated locally','fill="#b7c5ad" letter-spacing="1"');
  writeFileSync(new URL(`personas-${locale}.svg`,output),svg(1600,630,zh?'自定义 AI 角色和独特的像素头像':'Custom AI characters with distinctive pixel avatars',body));
}
console.log('Generated six self-contained README illustrations.');
