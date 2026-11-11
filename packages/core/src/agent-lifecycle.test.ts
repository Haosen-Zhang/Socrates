import {test,expect} from 'bun:test';
import {projectAgentAvailability,projectAgentWorkload,type AvailabilityFacts} from './agent-lifecycle';
const facts:AvailabilityFacts={configured:true,providerEnabled:true,credential:'present',runtime:'ready',toolCalling:true,evidence:null,now:1000};
test('availability requires fresh connection evidence and is independent of idle workload',()=>{
 expect(projectAgentAvailability(facts).state).toBe('unknown');
 const recent={outcome:'ok' as const,checkedAt:new Date(0).toISOString(),expiresAt:new Date(2000).toISOString()};
 expect(projectAgentAvailability({...facts,evidence:recent}).state).toBe('ready');
 expect(projectAgentAvailability({...facts,evidence:recent,now:2000}).state).toBe('unknown');
 expect(projectAgentAvailability({...facts,evidence:recent,toolCalling:'unknown'}).state).toBe('degraded');
 for(const patch of [{credential:'missing' as const},{providerEnabled:false},{runtime:'unavailable' as const}])expect(projectAgentAvailability({...facts,...patch,evidence:recent}).state).toBe('unavailable');
 expect(projectAgentWorkload([])).toMatchObject({state:'idle',items:[]});
});

test('workspace queue evidence replays into the existing room UI without changing its Run identity',async()=>{
 const {executionEventToRuntimeEvent}=await import('./execution-events');
 expect(executionEventToRuntimeEvent({schemaVersion:1,eventId:'waiting',sessionId:'room',runId:'run',agentId:'a',seq:2,type:'run.workspace_waiting',coordinates:{turnId:'turn'},payload:{reason:'workspace_write_lease_busy'},occurredAt:new Date().toISOString()})).toEqual({type:'extension',name:'workspace_queued',payload:{runId:'run',reason:'workspace_write_lease_busy'}});
});
