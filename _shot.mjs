import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = process.argv[2] ?? '/tmp/shots';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('PAGE ERROR', m.text()); });
page.on('pageerror', (e) => console.log('PAGE EXCEPTION', e.message));
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.trackBuilder, null, { timeout: 30000 });
await page.waitForTimeout(2500);

const info = await page.evaluate(() => {
  const tb = window.trackBuilder;
  const r = tb.world.rebuild();
  const props = {};
  for (const p of r.props) props[p.kind] = (props[p.kind] ?? 0) + 1;
  const crossing = tb.world.crossings.find((c) => c.kind === 'level');
  let junction = null;
  for (const [, j] of tb.world.junctions) if (j.kind === 'intersection') junction = j;
  const node = junction ? tb.network.getNode(junction.node).pos : null;
  const pole = r.props.find((p) => p.kind === 'utilityPole');
  return {
    props,
    warnings: r.warnings.map((w) => `${w.severity}: ${w.message}`),
    crossing: crossing ? { x: crossing.point.x, z: crossing.point.z } : null,
    junction: node ? { x: node.x, z: node.z } : null,
    pole: pole ? { x: pole.position.x, z: pole.position.z } : null,
  };
});
console.log(JSON.stringify(info, null, 2));

const views = [
  ['overview', 0, 0, 620, Math.PI * 0.28],
  ...(info.junction ? [['junction-close', info.junction.x, info.junction.z, 34, Math.PI * 0.55]] : []),
  ...(info.crossing ? [
    ['crossing-near', info.crossing.x, info.crossing.z, 42, Math.PI * 0.2],
    ['crossing-low', info.crossing.x, info.crossing.z, 24, Math.PI * 0.95],
  ] : []),
  ...(info.junction ? [
    ['junction', info.junction.x, info.junction.z, 55, Math.PI * 0.35],
    ['junction-low', info.junction.x, info.junction.z, 30, Math.PI * 1.1],
  ] : []),
  ...(info.pole ? [['poles', info.pole.x, info.pole.z, 45, Math.PI * 0.6]] : []),
];

for (const [name, x, z, dist, az] of views) {
  await page.evaluate(([x, z, d, a]) => window.trackBuilder.lookAt(x, z, d, a), [x, z, dist, az]);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('shot', name);
}
// 接続の色分けを ON にしてもう一度。
await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('input[type=checkbox]')];
  const target = boxes.find((b) => b.parentElement?.textContent?.includes('接続'));
  if (target && !target.checked) target.click();
});
await page.waitForTimeout(900);
await page.evaluate(() => window.trackBuilder.lookAt(-250, 40, 420, Math.PI * 0.3));
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/connectivity.png` });
console.log('shot connectivity');
await browser.close();
