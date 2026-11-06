const {PL,HX}=require('./load.js');const fs=require('fs');
(async()=>{
const doc=await PL.PDFDocument.load(fs.readFileSync('rl.pdf'),{updateMetadata:false});
const A=await HX.analyzePage(PL,doc,0);
const t=A.objs.find(o=>o.uid==='p1:85');
const r=t.runs[0];
const txt='Hello CONFIDENTIAL World';
const i0=txt.indexOf('CONFIDENTIAL');
const ed=HX.emptyEd();
ed.cut[r.id? 'p1:'+r.id:'']=[[i0,i0+'CONFIDENTIAL '.length]];
ed.del.push('p1:166');           // whole second line
ed.del.push('p1:358');           // line C
ed.xf['p1:223']=[1,0,0,1,100,-50]; ed.sty['p1:223']={f:'#00ff00',s:'#000000',w:4};
ed.del.push('p1:254');
await HX.applyEdits(PL,doc,ed,new Map());
fs.writeFileSync('out1.pdf',await doc.save({useObjectStreams:false}));
})().catch(e=>console.error(e));
