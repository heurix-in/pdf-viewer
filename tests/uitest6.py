import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':1280,'height':900},accept_downloads=True)
        pg.on('pageerror',lambda e:print('PAGEERR',e)); pg.on('console',lambda m: print('LOG',m.text) if m.type=='error' and 'TUNNEL' not in m.text else None)
        await pg.add_init_script("localStorage.setItem('hx-author','Tester');localStorage.setItem('hx-edtip','1');delete window.showSaveFilePicker"); await pg.goto('file:///home/claude/w/out.html')
        await pg.wait_for_selector('#start .start-logo'); await pg.wait_for_timeout(800)
        await pg.set_input_files('#fileInput','edtest/ch.pdf')
        await pg.wait_for_selector('.page canvas',timeout=30000); await pg.wait_for_timeout(1200)
        pe=await pg.query_selector('.page'); bb=await pe.bounding_box(); W=bb['width']/612.0
        def pt(x,y): return (bb['x']+x*W, bb['y']+y*W)   # top-left coords in pt
        await pg.click('.rb-m[data-mode=edit]'); await pg.wait_for_timeout(1500)
        # erase "confidential" (x 32..102, y 50..64)
        await pg.click('[data-tool=etext]')
        a=pt(30,50); c=pt(104,65)
        await pg.mouse.move(*a); await pg.mouse.down(); await pg.mouse.move(*c,steps=6); await pg.mouse.up(); await pg.wait_for_timeout(2200)
        # select the picture and delete it (picture at 160..235, 614..689 pdf coords: top-left y=792-689=103..178)
        await pg.click('[data-tool=osel]')
        await pg.mouse.click(*pt(200,140)); await pg.wait_for_timeout(300)
        print('picked',await pg.evaluate('[...window.__hx.A.edSel]'))
        await pg.keyboard.press('Delete'); await pg.wait_for_timeout(2200)
        # circle teal select by click at (120,106)?? circle centre pdf (150,...)
        await pg.screenshot(path='h1.png')
        await pg.click('.rb-m[data-mode=comment]'); await pg.wait_for_timeout(500)
        await pg.click('#searchBtn'); await pg.fill('#searchInput','confidential'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(1200)
        print('search count',await pg.inner_text('#searchCount'))
        await pg.fill('#searchInput','budget'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(1200)
        print('search budget',await pg.inner_text('#searchCount'))
        await b.close()
asyncio.run(main())
