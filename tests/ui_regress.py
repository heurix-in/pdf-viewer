import asyncio, os, subprocess
from playwright.async_api import async_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML='file://'+ROOT+'/dist/heurix-pdf-viewer.html'
fails=[]
def check(name,cond,extra=''):
    print(('PASS ' if cond else 'FAIL ')+name, extra)
    if not cond: fails.append(name)
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':1280,'height':1500},accept_downloads=True)
        errs=[]
        pg.on('pageerror',lambda e:(errs.append(str(e)),print('PAGEERR',e))); pg.on('console',lambda m: print('LOG',m.text) if m.type=='error' and 'TUNNEL' not in m.text else None)
        await pg.add_init_script("localStorage.setItem('hx-author','Tester');localStorage.setItem('hx-edtip','1');delete window.showSaveFilePicker")
        await pg.goto(HTML); await pg.wait_for_selector('#start .start-logo'); await pg.wait_for_timeout(500)
        await pg.set_input_files('#fileInput',ROOT+'/tests/data/shapes.pdf')
        await pg.wait_for_selector('.page canvas',timeout=30000); await pg.wait_for_timeout(1200)
        pe=await pg.query_selector('.page'); bb=await pe.bounding_box(); W=bb['width']/595.2756
        pt=lambda x,y:(bb['x']+x*W,bb['y']+(841.89-y)*W)
        # --- comment mode: highlight, note, text box
        await pg.click('[data-tool=highlight]')
        await pg.mouse.move(*pt(74,783)); await pg.mouse.down(); await pg.mouse.move(*pt(200,783),steps=6); await pg.mouse.up(); await pg.wait_for_timeout(500)
        await pg.click('[data-tool=note]'); await pg.mouse.click(*pt(400,700)); await pg.wait_for_timeout(400); await pg.keyboard.type('a note'); 
        await pg.click('[data-tool=text]'); await pg.mouse.move(*pt(300,650)); await pg.mouse.down(); await pg.mouse.move(*pt(450,630),steps=4); await pg.mouse.up(); await pg.wait_for_timeout(400); await pg.keyboard.type('Box text'); await pg.keyboard.press('Escape'); await pg.wait_for_timeout(300)
        n=await pg.inner_text('#commentsBadge'); check('comments badge >=2', int(n or 0)>=2, n)
        # --- edit mode
        await pg.click('.rb-m[data-mode=edit]'); await pg.wait_for_timeout(1000)
        # select the rectangle and recolor, move it
        await pg.click('[data-tool=osel]'); await pg.mouse.click(*pt(175,550)); await pg.wait_for_timeout(300)
        check('edit style box shown', await pg.is_visible('#edStyle'))
        await pg.fill('#edFill','#22aa44'); await pg.wait_for_timeout(200)
        await pg.mouse.move(*pt(175,550)); await pg.mouse.down(); await pg.mouse.move(*pt(175,500),steps=5); await pg.mouse.move(*pt(275,500),steps=5); await pg.mouse.up(); await pg.wait_for_timeout(500)
        # erase part of the second text line via erase tool
        await pg.click('[data-tool=etext]'); await pg.mouse.move(*pt(180,772)); await pg.mouse.down(); await pg.mouse.move(*pt(300,753),steps=5); await pg.mouse.up(); await pg.wait_for_timeout(500)
        # delete the line
        await pg.click('[data-tool=osel]'); await pg.mouse.click(*pt(250,400+ (250-100)*20/300)); await pg.wait_for_timeout(300); await pg.keyboard.press('Delete'); await pg.wait_for_timeout(500)
        # add image
        async with pg.expect_file_chooser() as fc: await pg.click('[data-tool=addimg]')
        await (await fc.value).set_files(ROOT+'/tests/data/pic.png'); await pg.wait_for_timeout(500)
        await pg.mouse.click(*pt(300,300)); await pg.wait_for_timeout(1200)
        # edit text of first line
        await pg.click('[data-tool=etxt]'); await pg.mouse.click(*pt(150,783)); await pg.wait_for_timeout(400)
        await pg.fill('#edTxtIn','Shapes sample: CHANGED first line'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(2500)
        # undo / redo sequence
        for _ in range(2): await pg.keyboard.press('Control+z'); await pg.wait_for_timeout(1500)
        for _ in range(2): await pg.keyboard.press('Control+y'); await pg.wait_for_timeout(1500)
        async with pg.expect_download() as dl: await pg.click('#saveBtn')
        d=await dl.value; await d.save_as('/tmp/ui_regress_out.pdf'); print('saved',d.suggested_filename)
        check('no page errors', not errs, errs)
        await b.close()
    txt=subprocess.run(['pdftotext','-layout','/tmp/ui_regress_out.pdf','-'],capture_output=True,text=True).stdout
    print(txt)
    check('text changed present','CHANGED first line' in txt)
    check('old first line gone','first line of text' not in txt)
    check('erased words gone', 'ALPHA' not in txt)
    q=subprocess.run(['qpdf','--check','/tmp/ui_regress_out.pdf'],capture_output=True,text=True)
    check('qpdf ok','No syntax or stream encoding errors found' in q.stdout, q.stdout[-120:])
    raw=open('/tmp/ui_regress_out.pdf','rb').read()
    check('old text not in raw bytes', b'first line of text' not in raw)
    print('FAILS',fails)
asyncio.run(main())
