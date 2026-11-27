#!/usr/bin/env node
import {main} from './measure-indexing-coverage.mjs';
// An ordinary one-shot invocation: schedule it externally only after selecting
// a provider, reviewing its terms, and configuring the operator's credentials.
if(!process.argv.includes('--history')&&!process.argv.includes('--help')){
  console.error('Provide --history FILE; snapshot collection is never scheduled automatically.');process.exitCode=1;
}else main().catch(error=>{console.error(error.message);process.exitCode=1;});
