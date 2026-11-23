// Safe bounded retry for Chrome evaluation during ordinary page navigation.
// Retry evaluate_script in the same owned tab, NEVER reopen a tab or repeat Eagle operations.
export function isNavigationContextRace(error){
 const message=String(error?.message||error||'');
 return /Execution context was destroyed|Cannot find context with specified id/i.test(message);
}
export async function evaluateInNavigatedTab(evaluate,{delays=[350,800,1600,2600],wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),onRetry=()=>{}}={}){
 if(typeof evaluate!=='function')throw Error('Missing browser evaluator');
 for(let attempt=0;attempt<=delays.length;attempt++){
  try{return await evaluate();}
  catch(error){
   if(!isNavigationContextRace(error)||attempt===delays.length)throw error;
   onRetry(attempt+1,error);
   await wait(delays[attempt]);
  }
 }
 throw Error('Unreachable browser evaluation state');
}
