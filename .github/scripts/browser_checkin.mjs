// GLaDOS 浏览器自动签到（Cloudflare Turnstile 由真实 Chromium 完成）
// 依赖：playwright + chromium。环境变量：GLADOS_COOKIES、SERVERCHAN_SENDKEY（可选）、HEADLESS=1 可切无头
import { chromium } from 'playwright';

const COOKIE_RAW = (process.env.GLADOS_COOKIES || '').trim();
const SENDKEY = (process.env.SERVERCHAN_SENDKEY || '').trim();
const HEADLESS = process.env.HEADLESS === '1';
const DOMAINS = ['glados.cloud', 'glados.space', 'railgun.info', 'glados.network', 'glados.rocks'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';

function log(...a) { console.log(new Date().toISOString(), ...a); }

function parseCookies() {
  const pairs = [];
  const push = (name, value) => { if (name && value !== undefined) pairs.push([name.trim(), String(value).trim()]); };
  const s = COOKIE_RAW;
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      const arr = JSON.parse(s);
      for (const c of Array.isArray(arr) ? arr : [arr]) {
        if (c.name) push(c.name, c.value);
        else if (c.cookie) for (const kv of String(c.cookie).split(';')) { const i = kv.indexOf('='); if (i > 0) push(kv.slice(0, i), kv.slice(i + 1)); }
      }
      return pairs;
    } catch (e) { log('cookie JSON 解析失败，回退文本解析', e.message); }
  }
  const str = s.includes('&') && !s.includes(';') ? s.split('&').join('; ') : s;
  for (const kv of str.split(';')) { const i = kv.indexOf('='); if (i > 0) push(kv.slice(0, i), kv.slice(i + 1)); }
  return pairs;
}

async function push(title, desp) {
  if (!SENDKEY) { log('未配置 SERVERCHAN_SENDKEY，跳过推送'); return; }
  try {
    const body = new URLSearchParams({ title, desp });
    const r = await fetch(`https://sctapi.ftqq.com/${SENDKEY}.send`, { method: 'POST', body });
    log('Server酱推送', r.status, (await r.text()).slice(0, 200));
  } catch (e) { log('Server酱推送失败', e.message); }
}

const pairs = parseCookies();
log(`解析到 ${pairs.length} 个 Cookie 键: ${pairs.map(p => p[0]).join(', ')}`);
if (!pairs.length) { log('FATAL: 没有可用 Cookie'); process.exit(1); }

const browser = await chromium.launch({
  headless: HEADLESS,
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const ctx = await browser.newContext({
  userAgent: UA, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
  viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1,
});
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
});

for (const domain of DOMAINS) {
  await ctx.clearCookies();
  await ctx.addCookies(pairs.map(([name, value]) => ({ name, value, domain: '.' + domain, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' })));
  const page = await ctx.newPage();
  let api = null, challenge = null, checkinReq = null;
  page.on('response', async (r) => {
    const u = r.url();
    if (!u.includes('/api/')) return;
    const m = r.request().method();
    if (u.includes('/user/checkin/challenge') && m === 'GET') { try { challenge = await r.json(); } catch {} }
    if (/\/user\/checkin$/.test(new URL(u).pathname) && m === 'POST') {
      try { api = await r.json(); } catch { api = { parse: 'failed' }; }
      try { checkinReq = JSON.parse(r.request().postData() || '{}'); } catch {}
    }
  });

  log(`→ 尝试域名 ${domain}`);
  try {
    await page.goto(`https://${domain}/console/checkin`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) { log(`  打开失败: ${e.message}`); await page.close().catch(() => {}); continue; }
  await page.waitForTimeout(4000);

  const url = page.url();
  const text = (await page.evaluate(() => document.body.innerText).catch(() => '')) || '';
  if (/\/login|\/signin/i.test(url) || /登录|Sign in|Log in/i.test(text.slice(0, 400))) {
    log(`  未登录（${url}），换下一个域名`);
    await page.close().catch(() => {});
    continue;
  }
  log(`  页面已加载: ${url}`);

  // 等 Turnstile 出现并自动完成（managed 模式通常无需点击）
  const hasTurnstile = async () => page.evaluate(() => !!document.querySelector('iframe[src*="challenges.cloudflare.com"]')).catch(() => false);
  for (let i = 0; i < 12 && !(await hasTurnstile()); i++) await page.waitForTimeout(2000);
  log(`  发现 Turnstile: ${await hasTurnstile()}`);

  const clickCheckin = async () => {
    for (const sel of ['button:has-text("签到")', 'button:has-text("Check in")', 'button:has-text("立即签到")', 'text=签到']) {
      const loc = page.locator(sel).first();
      try { if (await loc.count() && await loc.isVisible()) { await loc.click({ timeout: 5000 }); log(`  已点击 ${sel}`); return true; } } catch {}
    }
    return false;
  };

  // 有时页面加载即自动签到
  for (let round = 0; round < 6 && !api; round++) {
    if (round > 0) { await clickCheckin(); }
    for (let i = 0; i < 15 && !api; i++) {
      await page.waitForTimeout(2000);
      // 尝试点一下 Turnstile 的复选框（若它要求交互）
      if (!api && await hasTurnstile()) {
        try {
          const fr = page.frameLocator('iframe[src*="challenges.cloudflare.com"]');
          const cb = fr.locator('input[type="checkbox"], label, #challenge-stage').first();
          if (await cb.count()) { await cb.click({ timeout: 1500 }); }
        } catch {}
      }
    }
    if (!api) log(`  第 ${round + 1} 轮未拿到签到响应，继续重试`);
  }

  log('  challenge:', JSON.stringify(challenge));
  log('  请求体:', JSON.stringify(checkinReq));
  log('  响应:', JSON.stringify(api));
  await page.screenshot({ path: `checkin-${domain}.png`, fullPage: false }).catch(() => {});

  if (api) {
    const ok = api.code === 0;
    const title = ok ? `GLaDOS 签到成功 · ${api.points ?? '?'} 积分` : `GLaDOS 签到失败 · code=${api.code}`;
    const desp = [
      ok ? '浏览器模式签到完成 ✅' : '浏览器模式签到失败 ❌',
      `域名: ${domain}`,
      `响应: ${JSON.stringify(api)}`,
      api.breakdown ? `明细: ${JSON.stringify(api.breakdown)}` : '',
      `时间: ${new Date().toISOString()}`,
    ].filter(Boolean).join('\n\n');
    console.log(`RESULT ${title}`);
    await push(title, desp);
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    process.exit(ok ? 0 : 1);
  }
  await page.close().catch(() => {});
}

log('所有域名均失败');
await push('GLaDOS 签到失败 · 浏览器模式未取到响应', '所有候选域名都没能完成签到，请看 Actions 日志。');
await browser.close().catch(() => {});
process.exit(1);
