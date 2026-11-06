import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':1280,'height':900},accept_downloads=True)
        pg.on('pageerror',lambda e:print('PAGEERR',e)); pg.on('console',lambda m: print('LOG',m.text) if m.type=='error' and 'TUNNEL' not in m.text else None)
        await pg.add_init_script("localStorage.setItem('hx-author','Tester');delete window.showSaveFilePicker"); await pg.goto('file:///home/claude/w/out.html')
        await pg.wait_for_selector('#start .start-logo'); await pg.wait_for_timeout(800)
        await pg.set_input_files('#fileInput','edtest/rl.pdf')
        await pg.wait_for_selector('.page canvas',timeout=30000); await pg.wait_for_timeout(1500)
        pe=await pg.query_selector('.page'); bb=await pe.bounding_box(); W=bb['width']/595.0
        pt=lambda x,y:(bb['x']+x*W,bb['y']+(842-y)*W)
        # highlight: select text by dragging over first line, press H tool
        await pg.click('[data-tool=highlight]')
        await pg.mouse.move(*pt(70,766)); await pg.mouse.down(); await pg.mouse.move(*pt(200,766),steps=5); await pg.mouse.up(); await pg.wait_for_timeout(800)
        await pg.click('[data-tool=note]'); await pg.mouse.click(*pt(400,700)); await pg.wait_for_timeout(500)
        print('comments badge',await pg.inner_text('#commentsBadge'))
        await pg.keyboard.type('check note'); await pg.wait_for_timeout(300)
        await pg.click('[data-tool=select]'); await pg.mouse.click(*pt(300,300)); await pg.wait_for_timeout(300)
        print('badge now',await pg.inner_text('#commentsBadge'))
        async with pg.expect_download() as dl: await pg.click('#ribbonSaveBtn')
        d=await dl.value; await d.save_as('/tmp/saved3.pdf'); print(d.suggested_filename)
        await b.close()
asyncio.run(main())
