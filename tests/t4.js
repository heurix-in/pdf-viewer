const {PL,HX}=require('./load.js');const fs=require('fs');
(async()=>{
const doc=await PL.PDFDocument.load(fs.readFileSync('ch.pdf'),{updateMetadata:false});
const A=await HX.analyzePage(PL,doc,0);
const ed=HX.emptyEd();
const img=A.objs.find(o=>o.kind==='image'); const circ=A.objs.find(o=>o.stroke===null&&o.fill==='#008080');
ed.xf[img.uid]=[1.5,0,0,1.5,-30,-60];            // scale 1.5 about page origin + shift
ed.sty[circ.uid]={f:'#9933cc'};
ed.del.push(A.objs.find(o=>o.fill==='#ffa500').uid);
// add an image
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC','base64');
const assets=new Map([['a1',{mime:'image/png',bytes:png}]]);
ed.add.push({id:'n1',page:1,asset:'a1',x0:300,y0:300,x1:400,y1:360});
await HX.applyEdits(PL,doc,ed,assets);
fs.writeFileSync('ch_out2.pdf',await doc.save({useObjectStreams:false}));
})().catch(e=>console.error(e));
