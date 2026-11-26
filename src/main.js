import {Store,createGMAdapter} from './storage.js';
import {DiscoveryApp} from './app.js';

// No globals or credentials are exposed to the page. All DOM additions are removable.
if (window.top===window.self) {
  const store=new Store(createGMAdapter());
  const app=new DiscoveryApp(store);
  app.initialize().catch(error=>{
    console.error('[arXiv Discovery]',error);
    if(typeof GM_registerMenuCommand==='function')GM_registerMenuCommand('arXiv Discovery startup error',()=>alert(`arXiv Discovery could not start: ${error.message}`));
  });
}
