import asyncio, os, sys
from playwright.async_api import async_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML='file://'+ROOT+'/dist/heurix-pdf-viewer.html'
MM=72/25.4
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':1280,'height':1500},accept_downloads=True)
        errs=[]
        pg.on('pageerror',lambda e:(errs.append(str(e)),print('PAGEERR',e))); pg.on('console',lambda m: print('LOG',m.text) if m.type=='error' and 'TUNNEL' not in m.text else None)
        await pg.add_init_script("localStorage.setItem('hx-author','Tester');delete window.showSaveFilePicker")
        await pg.goto(HTML); await pg.wait_for_selector('#start .start-logo'); await pg.wait_for_timeout(500)
        await pg.set_input_files('#fileInput',ROOT+'/tests/data/measure.pdf')
        await pg.wait_for_selector('.page canvas',timeout=30000); await pg.wait_for_timeout(1200)
        pe=await pg.query_selector('.page'); bb=await pe.bounding_box(); W=bb['width']/595.2756
        pt=lambda x,y:(bb['x']+x*W,bb['y']+(841.89-y)*W)   # pdf pts -> screen
        labels=lambda: pg.eval_on_selector_all('.an-meas','els=>els.map(e=>e.textContent)')
        # 1 distance along top edge of rectangle (100mm)
        await pg.click('[data-tool=dist]'); await pg.wait_for_timeout(200)
        print('scale boxes visible',await pg.is_visible('#msScale'))
        y=200*MM; x0=40*MM; x1=140*MM
        await pg.mouse.move(*pt(x0,y)); await pg.mouse.down(); await pg.mouse.move(*pt(x0+100,y),steps=4); await pg.mouse.move(*pt(x1,y),steps=4); await pg.mouse.up(); await pg.wait_for_timeout(500)
        print('dist drag:',await labels())
        # 2 two-click distance with shift lock: 50mm vertical but cursor drifts in x
        await pg.mouse.click(*pt(x0,150*MM)); await pg.mouse.move(*pt(x0+8,200*MM)); await pg.keyboard.down('Shift'); await pg.mouse.move(*pt(x0+9,200*MM)); await pg.wait_for_timeout(150); await pg.mouse.click(*pt(x0+9,200*MM)); await pg.keyboard.up('Shift'); await pg.wait_for_timeout(500)
        print('dist shift:',await labels())
        # 3 calibrate on the 100mm line at y=120mm: real 5 m
        await pg.keyboard.press('Control+Shift+C'); await pg.wait_for_timeout(300)
        print('tool after ctrl+shift+c',await pg.evaluate("document.body.dataset.tool"))
        await pg.mouse.click(*pt(x0,120*MM)); await pg.mouse.move(*pt(x1,120*MM),steps=3); await pg.mouse.click(*pt(x1,120*MM)); await pg.wait_for_timeout(400)
        print('cal dialog',await pg.is_visible('#calDlg'),await pg.inner_text('#calLen'))
        await pg.screenshot(path='/tmp/m_cal.png')
        await pg.fill('#calReal','5'); await pg.select_option('#calUnit','m'); await pg.click('#calOk'); await pg.wait_for_timeout(500)
        print('after calibrate (existing updated):',await labels())
        print('scale boxes',[await pg.input_value(i) for i in ('#msPv','#msPu','#msRv','#msRu')])
        # 4 perimeter around rectangle (3 sides) then area around rectangle
        await pg.click('[data-tool=peri]')
        for q in [(x0,150*MM),(x0,200*MM),(x1,200*MM)]: await pg.mouse.click(*pt(*q)); 
        await pg.mouse.dblclick(*pt(x1,150*MM)); await pg.wait_for_timeout(500)
        print('peri:',await labels())
        await pg.click('[data-tool=area]')
        for q in [(x0,150*MM),(x0,200*MM),(x1,200*MM),(x1,150*MM)]: await pg.mouse.click(*pt(*q))
        await pg.mouse.click(*pt(x0,150*MM)); await pg.wait_for_timeout(500)
        print('area:',await labels())
        await pg.screenshot(path='/tmp/m_all.png')
        # select the area and change its scale to 1 cm = 1 ft
        await pg.keyboard.press('Escape'); await pg.click('[data-tool=select]')
        await pg.mouse.click(*pt(x0+0.5,175*MM)); await pg.wait_for_timeout(300)
        print('selected sel scale boxes',[await pg.input_value(i) for i in ('#msPv','#msPu','#msRv','#msRu')], await pg.is_visible('#msScale'))
        await pg.select_option('#msPu','cm'); await pg.fill('#msRv','1'); await pg.select_option('#msRu','ft'); await pg.keyboard.press('Tab'); await pg.wait_for_timeout(400)
        print('after unit change:',await labels())
        await pg.screenshot(path='/tmp/m_sel.png')
        # save
        async with pg.expect_download() as dl: await pg.click('#saveBtn')
        d=await dl.value; await d.save_as('/tmp/ui_measure_out.pdf'); print('saved',d.suggested_filename)
        # reopen the saved file
        await pg.goto(HTML); await pg.wait_for_selector('#start .start-logo'); await pg.wait_for_timeout(400)
        await pg.set_input_files('#fileInput','/tmp/ui_measure_out.pdf'); await pg.wait_for_selector('.page canvas',timeout=30000); await pg.wait_for_timeout(1500)
        print('reloaded labels:',await labels(), 'scale',[await pg.input_value(i) for i in ('#msPv','#msPu','#msRv','#msRu')] if await pg.is_visible('#msScale') else 'hidden')
        # undo works?
        print('errors',errs)
        await b.close()
asyncio.run(main())
