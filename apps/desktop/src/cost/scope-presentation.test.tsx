import { test, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import CostScopePanel from './CostScopePanel';
test('unloaded scoped accounting does not render fictitious zero prices or completion',()=>{
 const html=renderToStaticMarkup(<CostScopePanel handshake={{port:1234,token:'fixture'}} scope={{workItemId:'item'}}/>);
 expect(html).toContain('data-cost-scope="workItemId=item"');expect(html).not.toContain('$0.00');expect(html).not.toContain('USD');
});
