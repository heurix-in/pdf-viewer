import asyncio, base64
from playwright.async_api import async_playwright
open('/tmp/pic.png','wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC'))
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':1280,'height':800})
        pg.on('pageerror',lambda e:print('PAGEERR',e)); pg.on('console',lambda m: print('LOG',m.text) if m.type in('log','error') and 'TUNNEL' not in m.text else None)
        await pg.add_init_script("localStorage.setItem('hx-author','Tester');localStorage.setItem('hx-edtip','1')"); await pg.goto('file:///home/claude/w/out.html#hxdebug')
        await pg.wait_for_selector('#start .start-logo'); await pg.wait_for_timeout(800)
        await pg.set_input_files('#fileInput','edtest/rl.pdf')
        await pg.wait_for_selector('.page canvas',timeout=30000); await pg.wait_for_timeout(1200)
        await pg.click('.rb-m[data-mode=edit]'); await pg.wait_for_timeout(1200)
        pe=await pg.query_selector('.page'); bb=await pe.bounding_box(); W=bb['width']/595.0
        def pt(x,y): return (bb['x']+x*W, bb['y']+(842-y)*W)
        # resize via handle
        await pg.mouse.click(*pt(150,640)); await pg.wait_for_timeout(300)
        h=await pg.query_selector('.ed-h[data-h=se]'); hb=await h.bounding_box()
        await pg.mouse.move(hb['x']+5,hb['y']+5); await pg.mouse.down(); await pg.mouse.move(hb['x']+60,hb['y']+60,steps=5); await pg.mouse.up(); await pg.wait_for_timeout(1800)
        print('xf',await pg.evaluate('JSON.stringify(window.__hx.A.ed.xf)'))
        # image
        async with pg.expect_file_chooser() as fc: await pg.click('[data-tool=addimg]')
        await (await fc.value).set_files('/tmp/pic.png'); await pg.wait_for_timeout(600)
        print('pending',await pg.evaluate('JSON.stringify(window.__hx.A.edPending)'), await pg.evaluate('document.body.dataset.tool'))
        x0,y0=pt(350,520); x1,y1=pt(450,470)
        print('mode',await pg.evaluate('window.__hx.A.mode+" "+window.__hx.A.tool+" "+window.__hx.A.op'))
        await pg.mouse.move(x0,y0); await pg.mouse.down(); print('op',await pg.evaluate('window.__hx.A.op&&window.__hx.A.op.kind')); await pg.mouse.move(x1,y1,steps=5); await pg.mouse.up(); await pg.wait_for_timeout(2000)
        print('adds',await pg.evaluate('JSON.stringify(window.__hx.A.ed.add)'), await pg.evaluate('document.body.dataset.tool'))
        await pg.screenshot(path='f5.png'); await b.close()
asyncio.run(main())
