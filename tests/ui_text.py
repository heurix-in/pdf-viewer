import asyncio, os, subprocess, sys
from playwright.async_api import async_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML='file://'+ROOT+'/dist/heurix-pdf-viewer.html'
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':1280,'height':900},accept_downloads=True)
        errs=[]
        pg.on('pageerror',lambda e:(errs.append(str(e)),print('PAGEERR',e))); pg.on('console',lambda m: print('LOG',m.text) if m.type=='error' and 'TUNNEL' not in m.text else None)
        await pg.add_init_script("localStorage.setItem('hx-author','Tester');localStorage.setItem('hx-edtip','1');delete window.showSaveFilePicker")
        await pg.goto(HTML); await pg.wait_for_selector('#start .start-logo'); await pg.wait_for_timeout(500)
        await pg.set_input_files('#fileInput',ROOT+'/tests/data/std.pdf')
        await pg.wait_for_selector('.page canvas',timeout=30000); await pg.wait_for_timeout(1200)
        # top save button
        sb=await pg.query_selector('#saveBtn'); vis=await sb.is_visible(); txt=(await sb.inner_text()).strip(); print('top save visible',vis,repr(txt))
        await pg.screenshot(path='/tmp/s_top.png',clip={'x':0,'y':0,'width':1280,'height':120})
        await pg.click('.rb-m[data-mode=edit]'); await pg.wait_for_timeout(800)
        await pg.click('[data-tool=etxt]'); await pg.wait_for_timeout(300)
        pe=await pg.query_selector('.page'); bb=await pe.bounding_box(); W=bb['width']/595.0
        pt=lambda x,y:(bb['x']+x*W,bb['y']+(842-y)*W)
        await pg.mouse.click(*pt(150,764)); await pg.wait_for_timeout(500)
        vis=await pg.is_visible('#edTxtEd'); val=await pg.input_value('#edTxtIn'); print('editor open',vis,repr(val))
        await pg.screenshot(path='/tmp/s_ed.png')
        await pg.fill('#edTxtIn','Pump P-101 relief valve set pressure 12 barg (revised)')
        await pg.keyboard.press('Enter'); await pg.wait_for_timeout(2500)
        print('dirty',await pg.evaluate("document.getElementById('saveBtn').classList.contains('dirty')"))
        await pg.screenshot(path='/tmp/s_after.png')
        # change second line to bold sans in blue
        await pg.mouse.click(*pt(200,733)); await pg.wait_for_timeout(500)
        await pg.click('#edTxtB'); await pg.fill('#edTxtCol','#0044aa'); await pg.fill('#edTxtIn','Isolation ✓ required – see 4.2'); 
        print('note',await pg.inner_text('#edTxtNote'))
        await pg.click('#edTxtOk'); await pg.wait_for_timeout(2500)
        # undo / redo
        await pg.keyboard.press('Control+z'); await pg.wait_for_timeout(1800)
        await pg.keyboard.press('Control+y'); await pg.wait_for_timeout(1800)
        async with pg.expect_download() as dl: await pg.click('#saveBtn')
        d=await dl.value; await d.save_as('/tmp/ui_text_out.pdf'); print('saved as',d.suggested_filename)
        print('errors',errs)
        await b.close()
asyncio.run(main())
