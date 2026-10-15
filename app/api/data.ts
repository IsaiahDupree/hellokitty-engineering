import {env as runtimeEnv} from 'cloudflare:workers';
const PROJECT='hellokitty-rf-lab';
const BASE='https://ivhfuhxorppptyuofbgq.supabase.co';
const TABLES=new Set(['requirements','evidence','revisions','iterations','decisions']);
export function canonical(v:any):string {
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
 if(v && typeof v==='object')return '{'+Object.keys(v).sort().map(k=>canonical(k)+':'+canonical(v[k])).join(',')+'}';
 return JSON.stringify(v).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
}
export async function hash(v:any){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(v))))).map(n=>n.toString(16).padStart(2,'0')).join('');}
export async function database(group:string,query:Record<string,string>={},method='GET',body?:any){
 if(!TABLES.has(group))throw Error('Unknown engineering table');
 const key=(runtimeEnv as Record<string,string>).SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY;if(!key)throw Error('Database is not configured');
 const params=new URLSearchParams({...query,...(method==='GET'?{project_id:'eq.'+PROJECT}:{})});
 const headers:Record<string,string>={'apikey':key,'Content-Type':'application/json','Accept':'application/json'};
 if(!key.startsWith('sb_secret_'))headers.Authorization='Bearer '+key;
 if(method==='POST')headers.Prefer='resolution=merge-duplicates,return=representation';
 const res=await fetch(BASE+'/rest/v1/actp_engineering_'+group+'?'+params,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(15000),cache:'no-store'});
 if(!res.ok)throw Error('Engineering database returned HTTP '+res.status);
 const text=await res.text();if(text.length>4000000)throw Error('Database response exceeds limit');
 const result=JSON.parse(text);if(!Array.isArray(result))throw Error('Invalid database response');return result;
}
export async function write(group:string,payload:any){
 const content_sha256=await hash(payload);
 const rows=await database(group,{on_conflict:'project_id,id',select:'id,payload,content_sha256'},'POST',[{project_id:PROJECT,id:payload.id,payload,content_sha256,updated_at:new Date().toISOString()}]);
 if(rows.length!==1||rows[0].id!==payload.id||rows[0].content_sha256!==content_sha256||await hash(rows[0].payload)!==content_sha256)throw Error('Database write verification failed');
 return rows[0];
}
export async function current(){
 const rows=await database('revisions',{id:'eq.current',select:'id,payload,content_sha256,updated_at',limit:'1'});
 if(!rows.length)throw Error('No evaluated requirements revision has been published');
 const p=rows[0].payload;if(!p.ledger||p.ledger.ledger_sha256!==p.ledger_sha256)throw Error('Requirements revision binding mismatch');
 return {ledger:p.ledger,database_updated_at:rows[0].updated_at};
}
export function impact(ledger:any,changed:string[]){
 const graph=ledger.dependency_graph,known=new Set(graph.nodes.map((n:any)=>n.id));
 if(!Array.isArray(changed)||!changed.length||changed.length>25||changed.some(x=>!known.has(x)))throw Error('Select known model inputs');
 const affected=new Set(changed);let last=-1;while(last!==affected.size){last=affected.size;for(const e of graph.edges)if(affected.has(e.from))affected.add(e.to);}
 return {changed_nodes:changed,affected_nodes:[...affected].sort(),affected_requirements:ledger.requirements.filter((r:any)=>r.dependencies?.some((x:string)=>affected.has(x))).map((r:any)=>r.id).sort(),rerun_stages:[...new Set(graph.nodes.filter((n:any)=>affected.has(n.id)).flatMap((n:any)=>n.rerun_stages))].sort()};
}
export function json(v:any,status=200){return Response.json(v,{status,headers:{'Cache-Control':'no-store'}});}
