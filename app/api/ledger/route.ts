import {current,database,json} from '../data';
export const dynamic='force-dynamic';
export async function GET(){try{
 const [snapshot,iterations,decisions,analysis]=await Promise.all([current(),database('iterations',{select:'id,payload,updated_at',order:'updated_at.desc',limit:'100'}),database('decisions',{select:'id,payload,updated_at',order:'updated_at.desc',limit:'150'}),database('evidence',{id:'in.(analysis-current,integration-current,weather-current)',select:'id,payload,updated_at',limit:'3'})]);
 return json({...snapshot,iterations:iterations.map(x=>x.payload),decisions:decisions.map(x=>x.payload),analysis:analysis.map(x=>x.payload).filter(x=>x.ledger_sha256===snapshot.ledger.ledger_sha256),read_at:new Date().toISOString()});
 }catch(e){return json({error:e instanceof Error?e.message:'Unable to read engineering ledger'},503);}}
