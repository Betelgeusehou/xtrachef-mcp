import {localParts} from './order-pace-model.mjs';
export function inRefreshWindow(now=new Date()){const p=localParts(now),hour=Number(p.hour);return hour>=5&&hour<=23;}
export function nextRefresh(now=new Date()){let at=new Date(Math.floor(now.getTime()/3600000)*3600000+3600000);for(let n=0;n<30;n++,at=new Date(at.getTime()+3600000)){if(inRefreshWindow(at))return at.toISOString();}throw Error('No refresh slot');}
