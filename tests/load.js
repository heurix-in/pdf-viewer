const vm=require('vm'),fs=require('fs');
const ctx={console,TextEncoder,TextDecoder,setTimeout,clearTimeout,Uint8Array,ArrayBuffer};
ctx.window=ctx;ctx.self=ctx;vm.createContext(ctx);
vm.runInContext(fs.readFileSync('/home/claude/w/node/pdflib-src.js','utf8'),ctx);
const PL=ctx.PDFLib;
const src=fs.readFileSync('/home/claude/w/src/pdfedit.js','utf8')+';this.HXEdit=HXEdit;';
vm.runInContext(src,ctx);
module.exports={PL,HX:ctx.HXEdit};
