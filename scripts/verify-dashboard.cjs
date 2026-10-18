const fs=require('node:fs');
const path=require('node:path');
const {webkit}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const origin=process.env.DASHBOARD_URL||'http://127.0.0.1:5173';
const out=path.resolve(process.env.QA_OUTPUT||'outputs/dashboard-qa');
async function main(){
 fs.mkdirSync(out,{recursive:true});const browser=await webkit.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
 await page.goto(origin);await page.getByRole('heading',{name:'Engineering overview',exact:true}).waitFor();
 await page.screenshot({path:path.join(out,'overview.png'),fullPage:true});
 const api=await page.request.get(origin+'/api/ledger');if(!api.ok())throw Error('Ledger API unavailable');const initial=await api.json();
 await page.getByRole('button',{name:'Requirements',exact:false}).first().click();
 await page.getByRole('heading',{name:'Requirements register'}).waitFor();
 await page.getByLabel('Search requirements').fill('ARCH-001');
 if(await page.locator('tbody tr').count()!==1)throw Error('Requirement search must return the exact real row');
 await page.locator('tbody tr').first().click();await page.getByRole('dialog',{name:'Requirement details'}).waitFor();
 const note='Installation geometry does not establish connector engagement, harness flex life, fastener preload or repeated-assembly performance; retain the physical verification gates.';
 if(!initial.decisions.some(d=>d.kind==='review_note'&&d.rationale===note)){
  await page.getByLabel('Requirement review note').fill(note);await page.getByRole('button',{name:'Save review note',exact:true}).click();await page.getByText('Saved to the requirements database.',{exact:false}).waitFor();
 }
 await page.getByRole('button',{name:'Close requirement details'}).click();
 await page.getByLabel('Search requirements').fill('');await page.getByLabel('Status filter').selectOption('open');
 if(await page.locator('tbody tr').count()!==initial.ledger.counts.open)throw Error('Status filter count differs from the evaluated ledger');
 await page.screenshot({path:path.join(out,'requirements.png'),fullPage:true});
 await page.getByRole('button',{name:'Evidence',exact:false}).first().click();await page.getByRole('heading',{name:'Evidence & revisions'}).waitFor();
 await page.getByRole('button',{name:'Iteration lab',exact:false}).first().click();
 await page.getByRole('heading',{name:'Iteration lab',exact:true}).waitFor();await page.getByLabel('electrical_requirements',{exact:true}).check();
 const rationale='Investigate propulsion bus voltage and distributed power architecture to reduce the candidate feeder copper mass; preserve component voltage limits and rerun wire-drop, thermal, mass/CG and mounting-load checks before selection.';
 if(!initial.iterations.some(i=>i.rationale===rationale)){
  await page.locator('textarea').first().fill(rationale);await page.getByRole('button',{name:'Save iteration proposal',exact:true}).click();await page.getByText('Saved to the requirements database.',{exact:false}).waitFor();
 }
 await page.screenshot({path:path.join(out,'iteration.png'),fullPage:true});
 await page.getByRole('button',{name:'CAD & integration',exact:false}).first().click();await page.getByRole('heading',{name:'CAD & installation evidence'}).waitFor();
 const images=await page.locator('.asset-grid img').evaluateAll(images=>images.every(i=>i.complete&&i.naturalWidth>0));if(!images)throw Error('Native CAD views failed to load');
 await page.screenshot({path:path.join(out,'cad.png'),fullPage:true});
 const download=await page.request.get(origin+'/assets/integrated-structures.step');if(!download.ok()||(await download.body()).length<1000)throw Error('STEP download missing');
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Overview',exact:false}).first().click();await page.getByRole('heading',{name:'Engineering overview',exact:true}).waitFor();await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1))throw Error('Mobile page overflows horizontally');
 const finalResponse=await page.request.get(origin+'/api/ledger'),final=await finalResponse.json();
 if(!final.decisions.some(d=>d.rationale===note)||!final.iterations.some(i=>i.rationale===rationale))throw Error('Actual database write/readback not confirmed');
 if(errors.length)throw Error('Browser runtime errors: '+errors.join('; '));
 const result={passed:true,browser:'WebKit',url:origin,requirements:final.ledger.requirements.length,counts:final.ledger.counts,snapshot:final.ledger.ledger_sha256,search_verified:true,status_filter_verified:true,actual_review_note_readback:true,actual_iteration_readback:true,native_images_loaded:true,step_download_verified:true,mobile_horizontal_overflow:false,errors};
 fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
 }finally{await browser.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
