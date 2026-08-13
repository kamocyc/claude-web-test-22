import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message));
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.trackBuilder, null, { timeout: 30000 });
await page.waitForTimeout(1500);

const status = () => page.evaluate(() => ({
  segments: window.trackBuilder.network.segments.size,
  blockers: window.trackBuilder.tool.status().blockers,
}));

// 平坦な地形にして、道路を 1 本引く
await page.evaluate(() => {
  const tb = window.trackBuilder;
  tb.network.clear();
  tb.field.base.fill(20);
  tb.field.resetWork();
  tb.world.rebuild();
  tb.lookAt(0, 0, 260, Math.PI * 0.25);
});
await page.waitForTimeout(400);
const click = async (x, y) => { await page.mouse.click(x, y); await page.waitForTimeout(280); };
await click(400, 480);
await click(900, 300);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
console.log('1 本目:', JSON.stringify(await status()));

// 既存道路の端のすぐ近くを横切る → 交差点が近すぎるので拒否されるはず
await click(880, 200);
await page.mouse.move(890, 400);
await page.waitForTimeout(400);
console.log('端の近くを横切る:', JSON.stringify(await status()));
await click(890, 400);
console.log('クリック後:', JSON.stringify(await status()));
await page.screenshot({ path: '/tmp/v2/blocked.png' });

// 真ん中を直角に横切る → 許可されるはず
await page.keyboard.press('Escape');
await click(650, 200);
await page.mouse.move(600, 520);
await page.waitForTimeout(400);
console.log('真ん中を横切る:', JSON.stringify(await status()));
await click(600, 520);
console.log('クリック後:', JSON.stringify(await status()));
await browser.close();
