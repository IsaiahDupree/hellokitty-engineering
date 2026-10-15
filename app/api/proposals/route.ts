import {current,impact,write,json} from '../data';
export const dynamic='force-dynamic';
export async function POST(request:Request){
 const origin=request.headers.get('origin');if(!origin||origin!==new URL(request.url).origin)return json({error:'Same-origin request required'},403);
 try{const raw=await request.text();if(raw.length>16000)return json({error:'Proposal exceeds limit'},413);
 const b=JSON.parse(raw),kind=b.kind;
 if(!['iteration_proposal','requirement_proposal','review_note'].includes(kind))return json({error:'Unknown proposal type'},400);
 const text=(x:any,max:number)=>{if(typeof x!=='string'||!x.trim()||x.length>max)throw Error('Complete the requested fields within the character limit');return x.trim();};
 const rationale=text(b.rationale,4000),{ledger}=await current();
 let p:any={id:'proposal-'+crypto.randomUUID(),kind,rationale,status:'proposed',created_at:new Date().toISOString(),basis_ledger_sha256:ledger.ledger_sha256,execution_started:false,automatic_rebaseline:false};
 if(kind==='iteration_proposal')p={...p,...impact(ledger,b.changed_nodes||[])};
 if(kind==='requirement_proposal')p={...p,title:text(b.title,160),subsystem:text(b.subsystem,80),target:text(b.target,1000),verification:text(b.verification,1000)};
 if(kind==='review_note'){if(!ledger.requirements.some((r:any)=>r.id===b.requirement_id))throw Error('Unknown requirement');p.requirement_id=b.requirement_id;}
 const saved=await write(kind==='iteration_proposal'?'iterations':'decisions',p);return json({saved:true,proposal:saved.payload},201);
 }catch(e){return json({error:e instanceof Error?e.message:'Proposal could not be saved'},400);}}
