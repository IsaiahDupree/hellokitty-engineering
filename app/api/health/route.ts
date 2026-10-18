import {database,json} from '../data';
export const dynamic='force-dynamic';
export async function GET(){try{const r=await database('revisions',{id:'eq.current',select:'id',limit:'1'});return json({status:r.length?'ok':'awaiting_evaluated_revision',database_connected:true,project:'hellokitty-rf-lab',write_scope:'proposals_only'},r.length?200:503);}catch{return json({status:'unavailable',database_connected:false},503);}}
