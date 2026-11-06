import asyncio, sys, base64
from playwright.async_api import async_playwright
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC')
open('/tmp/pic.png','wb').write(PNG)
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':1280,'height':800},accept_downloads=True)
        errs=[]; pg.on('pageerror',lambda e:errs.append('PAGEERR '+str(e))); pg.on('console',lambda m: errs.append(m.text) if m.type=='error' and 'TUNNEL' not in m.text else None)
        await pg.add_init_script("localStorage.setItem('hx-author','Tester');localStorage.setItem('hx-edtip','1')"); await pg.add_init_script("delete window.showSaveFilePicker"); await pg.goto('file:///home/claude/w/out.html')
        await pg.wait_for_selector('#start .start-logo'); await pg.wait_for_timeout(800)
        await pg.set_input_files('#fileInput','edtest/rl.pdf')
        await pg.wait_for_selector('.page canvas',timeout=30000); await pg.wait_for_timeout(1200)
        await pg.click('.rb-m[data-mode=edit]'); await pg.wait_for_timeout(1200)
        pe=await pg.query_selector('.page'); bb=await pe.bounding_box(); W=bb['width']/595.0
        def pt(x,y): return (bb['x']+x*W, bb['y']+(842-y)*W)
        # 1. erase text: drag box over "CONFIDENTIAL" in first line (x 72+ ... )
        await pg.click('[data-tool=etext]')
        x0,y0=pt(118,764); x1,y1=pt(190,755)
        await pg.mouse.move(x0,y0); await pg.mouse.down(); await pg.mouse.move((x0+x1)/2,(y0+y1)/2,steps=4); await pg.mouse.move(x1,y1,steps=4)
        await pg.screenshot(path='f1.png'); await pg.mouse.up(); await pg.wait_for_timeout(2000)
        # 2. select rectangle, change fill
        await pg.click('[data-tool=osel]')
        x,y=pt(150,640); await pg.mouse.click(x,y); await pg.wait_for_timeout(300)
        print('style panel hidden?',await pg.evaluate('document.getElementById("edStyle").hidden'))
        await pg.fill('#edWidth','4'); await pg.wait_for_timeout(300)
        await pg.evaluate('''()=>{const i=document.getElementById('edFill'); i.value='#22aa55'; i.dispatchEvent(new Event('input',{bubbles:true}));}''')
        await pg.wait_for_timeout(2000)
        # 3. move rect by drag
        await pg.mouse.move(*pt(150,640)); await pg.mouse.down(); await pg.mouse.move(*pt(250,600),steps=6); await pg.screenshot(path='f2.png'); await pg.mouse.up(); await pg.wait_for_timeout(2000)
        await pg.screenshot(path='f3.png')
        # 4. resize with handle se
        h=await pg.query_selector('.ed-h[data-h=se]'); hb=await h.bounding_box()
        await pg.mouse.move(hb['x']+5,hb['y']+5); await pg.mouse.down(); await pg.mouse.move(hb['x']+60,hb['y']+60,steps=5); await pg.mouse.up(); await pg.wait_for_timeout(2000)
        # 5. add image
        async with pg.expect_file_chooser() as fc:
            await pg.click('[data-tool=addimg]')
        await (await fc.value).set_files('/tmp/pic.png'); await pg.wait_for_timeout(600)
        print('tool',await pg.evaluate('document.body.dataset.tool'))
        x0,y0=pt(350,520); x1,y1=pt(450,470)
        await pg.mouse.move(x0,y0); await pg.mouse.down(); await pg.mouse.move(x1,y1,steps=5); await pg.mouse.up(); await pg.wait_for_timeout(2200)
        await pg.screenshot(path='f4.png')
        print('tool after',await pg.evaluate('document.body.dataset.tool'), 'sel',await pg.eval_on_selector_all('.ed-box.sel','e=>e.length'))
        # 6. save (download)
        async with pg.expect_download() as dl:
            await pg.click('#ribbonSaveBtn')
        d=await dl.value; await d.save_as('/tmp/saved1.pdf'); print('saved',d.suggested_filename)
        print('errs',errs)
        await b.close()
asyncio.run(main())
