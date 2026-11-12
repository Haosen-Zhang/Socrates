import {test,expect} from 'bun:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {projectAgentAvailability,projectAgentWorkload} from '@socrates/core';
import AgentPresence from './AgentPresence';
test('compact presence keeps unavailable and idle as independent visible axes',()=>{
 const availability=projectAgentAvailability({configured:true,providerEnabled:false,credential:'present',runtime:'ready',toolCalling:true,evidence:null,now:Date.now()});
 const html=renderToStaticMarkup(<AgentPresence availability={availability} workload={projectAgentWorkload([])} en/>);
 expect(html).toContain('data-availability="unavailable"');expect(html).toContain('data-workload="idle"');expect(html).toContain('Availability');expect(html).toContain('Current work');
});
