import {expect,test} from 'bun:test';
import {reserveInteraction} from './requestIdentity';
import type {WorkInteractionInput} from '@socrates/core';
test('lost-response retry retains original quote, identity and budget while changed instruction is new',()=>{
 const input:WorkInteractionInput={clientRequestId:'preview',action:'message',content:'Inspect',mentions:[{type:'agent',agentId:'a'}],delivery:'queue',quoteId:'q1',budget:{mode:'soft_limit',limitAtomic:'100'}};
 const first=reserveInteraction(null,input);
 const retry=reserveInteraction(first,{...input,quoteId:'q2'});
 expect(retry.input.clientRequestId).toBe(first.input.clientRequestId);expect(retry.input.quoteId).toBe('q1');
 input.budget!.limitAtomic='200';expect(first.input.budget!.limitAtomic).toBe('100');
 expect(reserveInteraction(first,input).input.clientRequestId).not.toBe(first.input.clientRequestId);
 expect(reserveInteraction(first,{...first.input,delivery:'stop_restart'}).input.clientRequestId).not.toBe(first.input.clientRequestId);
 expect(reserveInteraction(first,{...first.input,action:'note'}).input.clientRequestId).not.toBe(first.input.clientRequestId);
});
