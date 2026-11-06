const {PL,HX}=require('./load.js');const fs=require('fs');
(async()=>{
const doc=await PL.PDFDocument.load(fs.readFileSync(process.argv[2]),{updateMetadata:false});
const A=await HX.analyzePage(PL,doc,0);
for(const o of A.objs) console.log(o.uid,o.kind,o.bbox.map(v=>Math.round(v)).join(','),o.kind==='text'?o.runs.map(r=>r.glyphs.length).join('/'):'' ,o.fill||'',o.stroke||'');
})().catch(e=>console.error(e));
