import asyncio, base64
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':1280,'height':800})
        errs=[]; pg.on('pageerror',lambda e:errs.append('PAGEERR '+str(e))); pg.on('console',lambda m: print('LOG',m.text) if m.type in('log','error') and 'TUNNEL' not in m.text else None)
        await pg.add_init_script("localStorage.setItem('hx-author','Tester');localStorage.setItem('hx-edtip','1')"); await pg.goto('file:///home/claude/w/out.html#hxdebug')
        await pg.wait_for_selector('#start .start-logo'); await pg.wait_for_timeout(800)
        await pg.set_input_files('#fileInput','edtest/rl.pdf')
        await pg.wait_for_selector('.page canvas',timeout=30000); await pg.wait_for_timeout(1200)
        await pg.click('.rb-m[data-mode=edit]'); await pg.wait_for_timeout(1200)
        pe=await pg.query_selector('.page'); bb=await pe.bounding_box(); W=bb['width']/595.0
        def pt(x,y): return (bb['x']+x*W, bb['y']+(842-y)*W)
        await pg.mouse.click(*pt(150,640)); await pg.wait_for_timeout(300)
        h=await pg.query_selector('.ed-h[data-h=se]'); hb=await h.bounding_box(); print('handle',hb)
        await pg.evaluate("""()=>{window.addEventListener('pointerdown',e=>console.log('PD',e.target.className, e.target.dataset&&e.target.dataset.h),true)}""")
        await pg.mouse.move(hb['x']+5,hb['y']+5); await pg.mouse.down(); print('op',await pg.evaluate('window.__hx.A.op&&window.__hx.A.op.kind')); await pg.mouse.move(hb['x']+60,hb['y']+60,steps=5); print('nb',await pg.evaluate('JSON.stringify(window.__hx.A.op&&window.__hx.A.op.nb)')); await pg.mouse.up(); await pg.wait_for_timeout(1500)
        print('xf',await pg.evaluate('JSON.stringify(window.__hx.A.ed.xf)'))
        print(errs); await b.close()
asyncio.run(main())
