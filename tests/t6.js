const {PL,HX}=require('./load.js');const fs=require('fs');
(async()=>{
const f=process.argv[2];
const doc=await PL.PDFDocument.load(fs.readFileSync(f),{updateMetadata:false});
let A=await HX.analyzePage(PL,doc,0);
const forms=A.objs.filter(o=>o.kind==='form'); console.log('forms',forms.length);
const expand=new Set(forms.map(o=>o.id));
A=await HX.analyzePage(PL,doc,0,expand);
const kids=A.objs.filter(o=>o.parentUid); console.log('children',kids.length, kids.slice(0,5).map(o=>o.uid+':'+o.kind));
const ed=HX.emptyEd();
// delete first path child inside forms, recolour another, move another
const pk=kids.filter(o=>o.kind==='path'&&!o.clip);
if(pk[0]) ed.del.push(pk[0].uid); if(pk[1]) ed.sty[pk[1].uid]={f:'#ff00ff'}; if(pk[2]) ed.xf[pk[2].uid]=[1,0,0,1,20,0];
const txt=kids.filter(o=>o.kind==='text'); if(txt[0]) ed.del.push(txt[0].uid);
await HX.applyEdits(PL,doc,ed,new Map());
fs.writeFileSync('t6_out.pdf',await doc.save({useObjectStreams:false}));
console.log('edits',JSON.stringify(ed).slice(0,200));
})().catch(e=>console.log(e.stack));
