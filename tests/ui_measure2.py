import asyncio, os
from playwright.async_api import async_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML='file://'+ROOT+'/dist/heurix-pdf-viewer.html'
MM=72/25.4
fails=[]
def check(n,c,x=''):
    print(('PASS ' if c else 'FAIL ')+n,x)
    if not c: fails.append(n)
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':1280,'height':1500})
        errs=[]; pg.on('pageerror',lambda e:(errs.append(str(e)),print('PAGEERR',e)))
        await pg.add_init_script("localStorage.setItem('hx-author','Tester');delete window.showSaveFilePicker")
        await pg.goto(HTML); await pg.wait_for_selector('#start .start-logo'); await pg.wait_for_timeout(400)
        await pg.set_input_files('#fileInput',ROOT+'/tests/data/measure.pdf'); await pg.wait_for_selector('.page canvas'); await pg.wait_for_timeout(1200)
        labels=lambda: pg.eval_on_selector_all('.an-meas','els=>els.map(e=>e.textContent)')
        async def geom():
            pe=await pg.query_selector('.page'); bb=await pe.bounding_box(); return bb
        bb=await geom(); W=bb['width']/595.2756
        pt=lambda x,y:(bb['x']+x*W,bb['y']+(841.89-y)*W)
        # scale menu preset: 1:100  -> 100mm on page = 10 m
        await pg.click('#msScaleBtn'); await pg.wait_for_timeout(200)
        items=await pg.eval_on_selector_all('#menu .menu-item','els=>els.map(e=>e.textContent.trim())'); print(items[:6])
        await pg.click('#menu .menu-item:has-text("1 : 100")'); await pg.wait_for_timeout(300)
        await pg.click('[data-tool=dist]'); x0=40*MM;x1=140*MM
        await pg.mouse.move(*pt(x0,200*MM)); await pg.mouse.down(); await pg.mouse.move(*pt(x1,200*MM),steps=5); await pg.mouse.up(); await pg.wait_for_timeout(300)
        l=await labels(); check('1:100 preset gives 10 m',l==['10.00 m'],l)
        # perimeter: shift-lock a wobbly path, backspace, enter
        await pg.click('[data-tool=peri]')
        await pg.mouse.click(*pt(x0,150*MM)); 
        await pg.keyboard.down('Shift'); await pg.mouse.move(*pt(x0+3,200*MM)); await pg.mouse.click(*pt(x0+3,200*MM)); await pg.mouse.move(*pt(x1,200*MM+4)); await pg.mouse.click(*pt(x1,200*MM+4)); await pg.keyboard.up('Shift')
        await pg.mouse.click(*pt(x1,170*MM)); await pg.wait_for_timeout(200)
        await pg.keyboard.press('Backspace'); await pg.wait_for_timeout(200)
        await pg.keyboard.press('Enter'); await pg.wait_for_timeout(400)
        l=await labels(); check('perimeter with shift-lock, backspace and Enter', any(x.startswith('Perimeter 15.00 m') for x in l), l)   # 50 + 100 mm at 1:100 = 15 m
        # Esc cancels
        await pg.click('[data-tool=area]'); await pg.mouse.click(*pt(x0,120*MM)); await pg.mouse.click(*pt(x0+20,125*MM)); await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)
        l2=await labels(); check('Esc cancelled the draft', l2==l, l2)
        # undo removes the perimeter
        await pg.click('[data-tool=select]'); await pg.keyboard.press('Control+z'); await pg.wait_for_timeout(300)
        l3=await labels(); check('undo removed last measurement', l3==['10.00 m'], l3)
        await pg.keyboard.press('Control+y'); await pg.wait_for_timeout(300)
        # rotate and measure again
        await pg.click('#rotateBtn'); await pg.wait_for_timeout(1500)
        bb=await geom()
        print('rotated page box',bb)
        l4=await labels(); check('labels stay after rotate', len(l4)==2, l4)
        await pg.click('[data-tool=dist]')
        # pick two screen points; compute their page distance via the same label: use the rect: after 90deg rotation the rect long edge is vertical on screen
        # measure by dragging along the long rectangle edge: find edge screen coords from the existing 10 m measurement's svg endpoints
        pts=await pg.eval_on_selector('.an-svg g path','p=>p.getAttribute("d")'); print('svg d',pts)
        print('errors',errs, 'FAILS',fails)
        await b.close()
asyncio.run(main())
