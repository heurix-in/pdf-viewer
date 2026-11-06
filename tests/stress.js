const {PL,HX}=require('./load.js');const fs=require('fs');
let seed=7;const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647;};
(async()=>{
for(const f of process.argv.slice(2)){
  const t0=Date.now();
  try{
  const doc=await PL.PDFDocument.load(fs.readFileSync(f),{updateMetadata:false});
  const n=Math.min(doc.getPageCount(),6); const ed=HX.emptyEd(); let objs=0,texts=0,glyphs=0,paths=0,imgs=0,forms=0;
  for(let i=0;i<n;i++){
    const A=await HX.analyzePage(PL,doc,i); objs+=A.objs.length;
    for(const o of A.objs){
      if(o.kind==='text'){texts++;for(const r of o.runs)glyphs+=r.glyphs.length;}
      if(o.kind==='path')paths++; if(o.kind==='image')imgs++; if(o.kind==='form')forms++;
      const r=rnd();
      if(o.kind==='text'){ if(r<0.3) ed.del.push(o.uid); else if(r<0.6){ const run=o.runs[0]; const L=run.glyphs.length; ed.cut[A.prefix+run.id]=[[0,Math.max(1,L>>1)]]; } }
      else if(!(o.kind==='path'&&o.clip)){ if(r<0.2) ed.del.push(o.uid); else if(r<0.4) ed.xf[o.uid]=[1,0,0,1,10,-10]; else if(r<0.5&&o.kind==='path') ed.sty[o.uid]={f:'#00ff00',s:'#ff0000',w:2}; }
    }
  }
  const t1=Date.now();
  await HX.applyEdits(PL,doc,ed,new Map());
  const out=await doc.save({useObjectStreams:false});
  fs.writeFileSync('stress_out.pdf',out);
  console.log(f.split('/').pop(),'pages',n,'objs',objs,'text',texts,'glyphs',glyphs,'paths',paths,'img',imgs,'forms',forms,'analyze ms',t1-t0,'apply ms',Date.now()-t1,'edits',ed.del.length,Object.keys(ed.cut).length,Object.keys(ed.xf).length);
  require('child_process').execSync('qpdf --check stress_out.pdf >/dev/null 2>&1 || echo QPDF_FAIL; pdftoppm -r 20 -f 1 -l 2 -png stress_out.pdf /tmp/stress_pg >/dev/null 2>&1 || echo RENDER_FAIL',{stdio:'inherit',shell:'/bin/bash'});
  }catch(e){console.log(f.split('/').pop(),'ERROR',e.stack.split('\n').slice(0,4).join(' | '));}
}
})();
