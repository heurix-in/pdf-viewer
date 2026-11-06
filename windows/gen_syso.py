import struct, io
from PIL import Image
ICON_SRC='/home/claude/w/assets/icon256.png'
def u16(s): return s.encode('utf-16-le')
def pad4(b): return b+b'\0'*((-len(b))%4)

# ---------- icons ----------
master=Image.open(ICON_SRC).convert('RGBA')
sizes=[16,24,32,48,64,128,256]
imgs=[]
for s in sizes:
    im=master.resize((s,s),Image.LANCZOS)
    if s==256:
        b=io.BytesIO(); im.save(b,'PNG'); data=b.getvalue()
    else:
        px=im.load(); rows=[]
        for y in range(s-1,-1,-1):
            rows.append(b''.join(struct.pack('<BBBB',px[x,y][2],px[x,y][1],px[x,y][0],px[x,y][3]) for x in range(s)))
        andm=b'\0'*(((s+31)//32*4)*s)
        data=struct.pack('<IiiHHIIiiII',40,s,s*2,1,32,0,0,0,0,0,0)+b''.join(rows)+andm
    imgs.append((s,data))
grp=struct.pack('<HHH',0,1,len(imgs))
for i,(s,d) in enumerate(imgs): grp+=struct.pack('<BBBBHHIH',0 if s==256 else s,0 if s==256 else s,0,0,1,32,len(d),i+1)

# ---------- version info ----------
def block(key,value=b'',vtype=0,children=b'',vlen=None):
    k=u16(key)+b'\0\0'
    hdr=struct.pack('<HHH',0,len(value) if vlen is None else vlen,vtype)
    body=pad4(hdr+k)+value
    body=pad4(body)+children
    return struct.pack('<H',len(body)+0)[:0]+struct.pack('<H',len(body))+body[2:]
def vblock(key,value=b'',vtype=0,children=b'',vlen=None):
    k=u16(key)+b'\0\0'
    head=struct.pack('<HHH',0,len(value) if vlen is None else vlen,vtype)+k
    head=pad4(head)
    body=head+value
    if children: body=pad4(body)+children
    return struct.pack('<H',len(body))+body[2:]
ver=(1,0,0,0)
ffi=struct.pack('<IIIIIIIIIIIII',0xFEEF04BD,0x10000,(ver[0]<<16)|ver[1],(ver[2]<<16)|ver[3],(ver[0]<<16)|ver[1],(ver[2]<<16)|ver[3],0x3f,0,0x40004,1,0,0,0)
strs=[('CompanyName','Heurix'),('FileDescription','Heurix PDF Viewer'),('FileVersion','1.0.0.0'),('InternalName','Heurix-PDF-Viewer'),('OriginalFilename','Heurix-PDF-Viewer.exe'),('ProductName','Heurix PDF Viewer'),('ProductVersion','1.0.0.0'),('LegalCopyright','Heurix')]
st=b''
for k,v in strs:
    val=u16(v)+b'\0\0'
    st=pad4(st)+vblock(k,val,1,vlen=len(val)//2)
stab=vblock('040904B0',b'',1,children=st)
sfi=vblock('StringFileInfo',b'',1,children=stab)
var=vblock('Translation',struct.pack('<HH',0x0409,0x04B0),0,vlen=4)
vfi=vblock('VarFileInfo',b'',1,children=var)
version=vblock('VS_VERSION_INFO',ffi,0,children=pad4(sfi)+pad4(vfi),vlen=52)

manifest=b'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
<trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo>
<compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/><supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}"/></application></compatibility>
</assembly>'''

LANG=0x0409
res=[(3,i+1,imgs[i][1]) for i in range(len(imgs))]+[(14,1,grp),(16,1,version),(24,1,manifest)]
types=sorted(set(r[0] for r in res))
# layout
off=0
root_off=0; off+=16+8*len(types)
t_dir={}; 
for t in types:
    ids=[r for r in res if r[0]==t]; t_dir[t]=off; off+=16+8*len(ids)
l_dir={}
for r in res: l_dir[(r[0],r[1])]=off; off+=16+8
d_ent={}
for r in res: d_ent[(r[0],r[1])]=off; off+=16
blob={}
for r in res:
    off+=(-off)%4; blob[(r[0],r[1])]=off; off+=len(r[2])
total=off+(-off)%4
buf=bytearray(total); relocs=[]
def dirhdr(o,nid): struct.pack_into('<IIHHHH',buf,o,0,0,0,0,0,nid)
dirhdr(root_off,len(types))
for i,t in enumerate(types): struct.pack_into('<II',buf,16+8*i,t,0x80000000|t_dir[t])
for t in types:
    ids=sorted(r for r in res if r[0]==t); dirhdr(t_dir[t],len(ids))
    for i,r in enumerate(ids): struct.pack_into('<II',buf,t_dir[t]+16+8*i,r[1],0x80000000|l_dir[(t,r[1])])
for r in res:
    k=(r[0],r[1]); dirhdr(l_dir[k],1); struct.pack_into('<II',buf,l_dir[k]+16,LANG,d_ent[k])
    struct.pack_into('<IIII',buf,d_ent[k],blob[k],len(r[2]),0,0); relocs.append(d_ent[k])
    buf[blob[k]:blob[k]+len(r[2])]=r[2]
# COFF object
nrel=len(relocs); raw_ptr=20+40; rel_ptr=raw_ptr+total; sym_ptr=rel_ptr+10*nrel
out=struct.pack('<HHIIIHH',0x8664,1,0,sym_ptr,1+1,0,0)
out+=struct.pack('<8sIIIIIIHHI',b'.rsrc',0,0,total,raw_ptr,rel_ptr,0,nrel,0,0xC0000040)
out+=bytes(buf)
for o in relocs: out+=struct.pack('<IIH',o,0,3)   # symbol 0 = .rsrc, ADDR32NB
out+=struct.pack('<8sIhHBB',b'.rsrc',0,1,0,3,1)+struct.pack('<IHHIHBxxx',total,nrel,0,0,1,0)
out+=struct.pack('<I',4)
open('resource_windows_amd64.syso','wb').write(out); print('syso',len(out))
