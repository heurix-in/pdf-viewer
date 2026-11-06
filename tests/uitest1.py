import asyncio, sys
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':1280,'height':800},accept_downloads=True)
        errs=[]; pg.on('pageerror',lambda e:errs.append('PAGEERR '+str(e))); pg.on('console',lambda m: errs.append(m.text) if m.type in('error','warning') else None)
        await pg.add_init_script("localStorage.setItem('hx-author','Tester')"); await pg.goto('file:///home/claude/w/out.html')
        await pg.wait_for_selector('#start .start-logo'); await pg.wait_for_timeout(800)
        await pg.set_input_files('#fileInput','edtest/rl.pdf')
        await pg.wait_for_selector('.page canvas',timeout=30000); await pg.wait_for_timeout(1200)
        await pg.click('.rb-m[data-mode=edit]'); await pg.wait_for_timeout(1500)
        print('mode',await pg.evaluate('document.body.dataset.mode+" "+document.body.dataset.tool'))
        await pg.screenshot(path='e1.png')
        pe=await pg.query_selector('.page'); bb=await pe.bounding_box(); print(bb)
        # page is A4 595x842 at zoom z: compute from bbox
        W=bb['width']/595.0
        def pt(x,y): return (bb['x']+x*W, bb['y']+(842-y)*W)
        # click on the second line (Times, y~730..739), x ~100
        x,y=pt(120,733); await pg.mouse.click(x,y); await pg.wait_for_timeout(300)
        await pg.screenshot(path='e2.png')
        print('sel boxes', await pg.eval_on_selector_all('.ed-box.sel','e=>e.length'), 'bar', await pg.evaluate('!document.getElementById("objbar").hidden'))
        await pg.keyboard.press('Delete'); await pg.wait_for_timeout(2500)
        await pg.screenshot(path='e3.png')
        print('errs',errs)
        await b.close()
asyncio.run(main())
