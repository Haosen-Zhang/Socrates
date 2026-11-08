import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync,existsSync,symlinkSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ToolContext} from '@socrates/core';
import {createMacOsSandboxCommandRunner} from './workspace-command-runner';
const macTest=process.platform==='darwin'&&existsSync('/usr/bin/sandbox-exec')?test:test.skip;
macTest('actual macOS approved command cannot overwrite/delete frozen checks or rename their parent but can write source',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'socrates-arena-boundary-')));mkdirSync(join(root,'tests'));mkdirSync(join(root,'src'));writeFileSync(join(root,'tests/frozen.ts'),'immutable acceptance');
 const context:ToolContext={callId:'call',sessionId:'room',taskId:'task',turnId:'turn',agentId:'a',workspaceId:'w',mode:'single_agent',phase:'executing',signal:new AbortController().signal,protectedPaths:['tests/frozen.ts']};
 const runner=createMacOsSandboxCommandRunner(new Map([['bun',realpathSync(process.execPath)]]));
 try{const script=`const f=require('node:fs');const results={};for(const [name,fn] of Object.entries({overwrite:()=>f.writeFileSync('tests/frozen.ts','bad'),unlink:()=>f.unlinkSync('tests/frozen.ts'),rename:()=>f.renameSync('tests','moved'),rmdir:()=>f.rmSync('tests',{recursive:true,force:true}),source:()=>f.writeFileSync('src/output.ts','allowed')})){try{fn();results[name]='allowed'}catch(e){results[name]='denied'}}console.log(JSON.stringify(results));`;
 const result=await runner.run(root,{executable:'bun',argv:['-e',script],timeoutMs:5000},context);expect(result.exitCode).toBe(0);const outcomes=JSON.parse(result.stdout);expect(outcomes).toEqual({overwrite:'denied',unlink:'denied',rename:'denied',rmdir:'denied',source:'allowed'});expect(readFileSync(join(root,'tests/frozen.ts'),'utf8')).toBe('immutable acceptance');expect(readFileSync(join(root,'src/output.ts'),'utf8')).toBe('allowed');
 }finally{rmSync(root,{recursive:true,force:true});}
});
macTest('actual macOS protected checks cannot be modified through workspace symlink or hardlink aliases',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'socrates-arena-alias-')));mkdirSync(join(root,'tests'));writeFileSync(join(root,'tests/frozen.ts'),'immutable acceptance');symlinkSync('tests/frozen.ts',join(root,'soft'));linkSync(join(root,'tests/frozen.ts'),join(root,'hard'));
 const context:ToolContext={callId:'call',sessionId:'room',taskId:'task',turnId:'turn',agentId:'a',workspaceId:'w',mode:'single_agent',phase:'executing',signal:new AbortController().signal,protectedPaths:['tests/frozen.ts']};
 try{const runner=createMacOsSandboxCommandRunner(new Map([['bun',realpathSync(process.execPath)]]));const result=await runner.run(root,{executable:'bun',argv:['-e',`const f=require('node:fs');const r={};for(const path of ['soft','hard']){try{f.writeFileSync(path,'bypass');r[path]='allowed'}catch{r[path]='denied'}}console.log(JSON.stringify(r));`],timeoutMs:5000},context);expect(result.exitCode).toBe(0);expect(JSON.parse(result.stdout)).toEqual({soft:'denied',hard:'denied'});expect(readFileSync(join(root,'tests/frozen.ts'),'utf8')).toBe('immutable acceptance');}finally{rmSync(root,{recursive:true,force:true});}
});
