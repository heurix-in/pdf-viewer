import re,base64,hashlib,sys,os
d=os.path.dirname(os.path.abspath(__file__))
head=open(d+'/head.html').read(); mid=open(d+'/mid.html').read(); tail=open(d+'/tail.html').read()
parts=['module.js']+([p for p in sys.argv[1:]] or ['pdfedit.js','edit-ui.js','measure.js'])
# extra modules are concatenated BEFORE the final bootstrap marker in module.js
mod=open(d+'/module.js').read()
extra=''.join(open(d+'/'+p).read()+'\n' for p in parts[1:])
MARK='/*@@EXTRA@@*/'
assert MARK in mod, 'marker missing'
mod=mod.replace(MARK,extra)
h=base64.b64encode(hashlib.sha256(mod.encode()).digest()).decode()
head,n=re.subn(r"script-src 'sha256-[^']*'",f"script-src 'sha256-{h}'",head,count=1); assert n==1
out=head+mid+'<script type="module">'+mod+tail
os.makedirs(d+'/../dist',exist_ok=True); open(d+'/../dist/heurix-pdf-viewer.html','w').write(out); print('built',len(out))
