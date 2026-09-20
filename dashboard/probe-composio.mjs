// Read-only discovery: initialize + tools/list only. Never call a discovered tool.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const key=process.env.COMPOSIO_CONSUMER_API_KEY;
if(!key){console.log(JSON.stringify({ok:false,reason:'missing_consumer_key'}));process.exit(1);}
const redact=value=>JSON.parse(JSON.stringify(value).split(key).join('[REDACTED]'));
let client;let timer;
try{
 client=new Client({name:'store-pulse-discovery',version:'1.0.0'});
 timer=setTimeout(()=>{console.log(JSON.stringify({ok:false,reason:'timeout'}));process.exit(1);},90000);
 const transport=new StreamableHTTPClientTransport(new URL('https://connect.composio.dev/mcp'),{requestInit:{headers:{'x-consumer-api-key':key}},reconnectionOptions:{maxRetries:0}});
 await client.connect(transport);
 const tools=[];let cursor;const seen=new Set();
 for(let page=0;page<10;page++){
  const result=await client.listTools(cursor?{cursor}:undefined,{timeout:30000});
  for(const tool of result.tools)tools.push({name:tool.name,inputSchema:tool.inputSchema});
  cursor=result.nextCursor;if(!cursor)break;if(seen.has(cursor))throw Error('Repeated pagination');seen.add(cursor);
 }
 if(cursor)throw Error('Incomplete discovery');
 console.log(JSON.stringify(redact({ok:true,toolCount:tools.length,tools}),null,2));
}catch{console.log(JSON.stringify({ok:false,reason:'discovery_failed'}));process.exitCode=1;}
finally{clearTimeout(timer);if(client)await client.close().catch(()=>{});}
