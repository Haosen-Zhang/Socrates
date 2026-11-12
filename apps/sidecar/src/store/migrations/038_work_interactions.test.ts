import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {migrations} from './index';
import {runMigrations} from '../migrations';
import {SessionStore} from '../session-store';
import {EventStore} from '../event-store';
test('M05 migration marks historical member reports consumed without replaying paid evaluations',()=>{
 const db=new Database(':memory:');try{
  runMigrations(db,migrations.filter(m=>m.version<38));
  const room=new SessionStore(db).create({title:'Historical Chat',mode:'chat',primaryAgentId:'a',agents:[{agentId:'a',snapshot:{nickname:'A'},executionEligible:false}]});
  new EventStore(db).append({eventId:'old-report',sessionId:room.id,type:'multi.package_finished',payload:{id:'old'}});
  expect(runMigrations(db,migrations)).toEqual([38,39,40]);
  expect(db.query('SELECT * FROM leader_report_receipts').all()).toEqual([{event_id:'old-report',evaluation_id:null}]);
  expect(db.query('SELECT * FROM leader_evaluations').all()).toEqual([]);
  expect(new EventStore(db).listAfter(room.id,0)).toHaveLength(1);
  expect(runMigrations(db,migrations)).toEqual([]);
 }finally{db.close();}
});
