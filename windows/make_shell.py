import re,base64,hashlib
s=open('shell.src.html').read()
m=re.search(r'<script>(.*?)</script>',s,re.S)
h=base64.b64encode(hashlib.sha256(m.group(1).encode()).digest()).decode()
fav=base64.b64encode(open('/home/claude/w/assets/icon64.png','rb').read()).decode()
open('shell.html','w').write(s.replace('__HASH__',h).replace('__FAVICON__',fav)); print('shell built',h[:12])
