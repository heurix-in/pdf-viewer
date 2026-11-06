import asyncio, base64
from playwright.async_api import async_playwright
open('/tmp/pic.png','wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC'))
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':1280,'height':900},accept_downloads=True)
        pg.on('pageerror',lambda e:print('PAGEERR',e)); pg.on('console',lambda m: print('LOG',m.text) if m.type=='error' and 'TUNNEL' not in m.text else None)
        await pg.add_init_script("localStorage.setItem('hx-author','Tester');localStorage.setItem('hx-edtip','1');delete window.showSaveFilePicker"); await pg.goto('file:///home/claude/w/out.html#hxdebug')
        await pg.wait_for_selector('#start .start-logo'); await pg.wait_for_timeout(800)
        await pg.set_input_files('#fileInput','edtest/rl90.pdf')
        await pg.wait_for_selector('.page canvas',timeout=30000); await pg.wait_for_timeout(1200)
        # comment first: highlight tool can't easily; add a rectangle in comment mode
        await pg.click('[data-tool=rect]')
        pe=await pg.query_selector('.page'); bb=await pe.bounding_box(); print(bb)
        await pg.mouse.move(bb['x']+100,bb['y']+100); await pg.mouse.down(); await pg.mouse.move(bb['x']+200,bb['y']+160,steps=4); await pg.mouse.up(); await pg.wait_for_timeout(300)
        await pg.click('.rb-m[data-mode=edit]'); await pg.wait_for_timeout(1500)
        await pg.screenshot(path='g0.png')
        # select all text lines
        await pg.click('#edSelAll'); await pg.click('#menu .menu-item:nth-child(3)'); await pg.wait_for_timeout(300)
        print('sel',await pg.evaluate('window.__hx.A.edSel.size'))
        await pg.keyboard.press('Delete'); await pg.wait_for_timeout(2000)
        await pg.screenshot(path='g1.png')
        await pg.keyboard.press('Control+z'); await pg.wait_for_timeout(2000)
        print('after undo del',await pg.evaluate('window.__hx.A.ed.del.length'))
        await pg.keyboard.press('Control+y'); await pg.wait_for_timeout(2000)
        print('after redo del',await pg.evaluate('window.__hx.A.ed.del.length'))
        # add image on rotated page
        async with pg.expect_file_chooser() as fc: await pg.click('[data-tool=addimg]')
        await (await fc.value).set_files('/tmp/pic.png'); await pg.wait_for_timeout(500)
        await pg.mouse.click(bb['x']+bb['width']/2,bb['y']+bb['height']/2); await pg.wait_for_timeout(2000)
        await pg.screenshot(path='g2.png')
        async with pg.expect_download() as dl: await pg.click('#ribbonSaveBtn')
        d=await dl.value; await d.save_as('/tmp/saved2.pdf'); print(d.suggested_filename)
        await b.close()
asyncio.run(main())
