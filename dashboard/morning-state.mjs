import {shiftDate} from './order-pace-model.mjs';
export function needsMorning(cache,name,businessDate){return cache['lastService:'+name]?.date!==shiftDate(businessDate,-1);}
export function morningError(cache,name,businessDate){const expectedDate=shiftDate(businessDate,-1);return cache['lastService:'+name]?.date===expectedDate?null:{expectedDate,...cache['morningError:'+name]};}
