# Edited text must keep the font, size and colour of the original line (not a standard preset)
import asyncio, os, re, subprocess, sys
from playwright.async_api import async_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML='file://'+ROOT+'/dist/heurix-pdf-viewer.html'
def find(pdf, needle):
    out=subprocess.run(['pdftotext','-bbox-layout',pdf,'-'],capture_output=True,text=True).stdout
    for m in re.finditer(r'<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</line>',out,re.S):
        words=re.findall(r'>([^<]+)</word>',m.group(5))
        if needle in ' '.join(words): return [float(m.group(i)) for i in range(1,5)]
    raise SystemExit('no line '+needle)
def pagew(pdf):
    out=subprocess.run(['pdftotext','-bbox-layout',pdf,'-'],capture_output=True,text=True).stdout
    return float(re.search(r'<page width="([\d.]+)"',out).group(1))
def fonts(pdf): return subprocess.run(['pdffonts',pdf],capture_output=True,text=True).stdout
async def edit(pg, pdf, needle, newtext, out, page_h=842):
    x0,y0,x1,y1=find(pdf,needle)
    await pg.goto(HTML); await pg.wait_for_selector('#start .start-logo'); await pg.wait_for_timeout(400)
    await pg.set_input_files('#fileInput',pdf)
    await pg.wait_for_selector('.page canvas',timeout=30000); await pg.wait_for_timeout(1200)
    await pg.click('.rb-m[data-mode=edit]'); await pg.wait_for_timeout(600)
    await pg.click('[data-tool=etxt]'); await pg.wait_for_timeout(300)
    bb=await (await pg.query_selector('.page')).bounding_box(); W=bb['width']/pagew(pdf)
    await pg.mouse.click(bb['x']+(x0+x1)/2*W, bb['y']+(y0+y1)/2*W); await pg.wait_for_timeout(600)
    cur=await pg.input_value('#edTxtIn'); print(' editor text:',repr(cur), '| font select:',repr(await pg.input_value('#edTxtFam')))
    await pg.fill('#edTxtIn',newtext); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(2500)
    async with pg.expect_download() as dl: await pg.click('#saveBtn')
    d=await dl.value; await d.save_as(out)
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':1280,'height':1500},accept_downloads=True)
        errs=[]; pg.on('pageerror',lambda e:(errs.append(str(e)),print('PAGEERR',e)))
        await pg.add_init_script("localStorage.setItem('hx-author','T');localStorage.setItem('hx-edtip','1');delete window.showSaveFilePicker")
        cases=[('chrome.pdf','Overpressure of','Overpressure of vessel V-102 due to blocked outlet line'),('chrome.pdf','Relief valve PSV','Relief valve PSV-1002 lifts at 12 barg'),('h.pdf','Relief valve PSV-1001','Relief valve PSV-1001 set at 12 barg, inspected 2027.'),
               ('lo.pdf','Plant shutdown','Plant start-up procedure'),
               ('lo.pdf','Step 1','Step 1: Open inlet valve XV-101 and verify pressure is zero.'),
               ('std.pdf','Pump P-101','Pump P-101 relief valve set pressure 12 barg (revised)'),
               ('std.pdf','Isolation required','Isolation required before maintenance (see section 4.3)')]
        for i,(f,needle,new) in enumerate(cases):
            src=ROOT+'/tests/data/'+f; out=f'/tmp/tf_{i}.pdf'; print(f,needle)
            await edit(pg,src,needle,new,out)
            txt=subprocess.run(['pdftotext',out,'-'],capture_output=True,text=True).stdout
            print(' new text present:',new.split(',')[0] in txt.replace('\n',' '))
            print(' fonts before:',[l.split()[0] for l in fonts(src).splitlines()[2:]]); print(' fonts after: ',[l.split()[0] for l in fonts(out).splitlines()[2:]])
            subprocess.run(['pdftoppm','-r','110','-png','-f','1','-l','1',out,f'/tmp/tf_{i}'])
        print('errors',errs); await b.close()
asyncio.run(main())
