const {PL,HX}=require('./load.js');const fs=require('fs');
// usage: file words as "name:xMin,yMin,xMax,yMax" in pdftotext top-left coords
(async()=>{
const [f,out,...rects]=process.argv.slice(2);
const doc=await PL.PDFDocument.load(fs.readFileSync(f),{updateMetadata:false});
const H=doc.getPage(0).getHeight();
const A=await HX.analyzePage(PL,doc,0);
const ed=HX.emptyEd();
for(const r of rects){const [x0,y0,x1,y1]=r.split(',').map(Number);
 const g=HX.glyphsInRect(A,[x0,H-y1,x1,H-y0]);console.log(r,'glyphs',g.count);
 HX.mergeCut(ed.cut,g.cut);}
await HX.applyEdits(PL,doc,ed,new Map());
fs.writeFileSync(out,await doc.save({useObjectStreams:false}));
})().catch(e=>console.error(e));
