const {PL,HX}=require('./load.js');const fs=require('fs');
(async()=>{
const doc=await PL.PDFDocument.load(fs.readFileSync('ch.pdf'),{updateMetadata:false});
const A=await HX.analyzePage(PL,doc,0);
const ed=HX.emptyEd(); ed.del.push(A.objs.find(o=>o.kind==='image').uid);
await HX.applyEdits(PL,doc,ed,new Map());
fs.writeFileSync('ch_noimg.pdf',await doc.save({useObjectStreams:false}));
})();
