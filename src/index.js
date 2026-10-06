import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderOverlay } from './overlay.js';

const PROFILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.browser-profile');
const SPEEDS = new Set([0.5, 1, 1.25, 1.5, 2]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function options(argv) {
  const result = { speed: 1, limit: Infinity, cdp: 'http://127.0.0.1:9339' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') result.list = true;
    else if (['--url', '--speed', '--limit', '--cdp'].includes(arg)) result[arg.slice(2)] = argv[++i];
    else if (arg === '--help') result.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  result.speed = Number(result.speed);
  result.limit = result.limit === Infinity ? Infinity : Number(result.limit);
  if (!SPEEDS.has(result.speed)) throw new Error('--speed 只能是 0.5、1、1.25、1.5 或 2');
  if (!Number.isInteger(result.limit) && result.limit !== Infinity || result.limit < 1) throw new Error('--limit 必须是正整数');
  if (result.url && (!result.url.startsWith('https://') || !new URL(result.url).hostname.endsWith('.yuketang.cn'))) {
    throw new Error('--url 必须是雨课堂 HTTPS 课程链接');
  }
  return result;
}

function courseId(url) {
  return url.match(/\/lms\/[^/]+\/(\d+)\/studycontent/)?.[1] ?? url.match(/\/lms-graph\/(\d+)\//)?.[1];
}

async function connect(endpoint) {
  try {
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 2500 });
    return { browser, context: browser.contexts()[0], close: () => browser.close() };
  } catch {
    const context = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: false });
    return { context, close: () => context.close() };
  }
}

async function findPages(context, url) {
  const id = url && courseId(url);
  const matching = (page) => !id || courseId(page.url()) === id;
  let course = context.pages().find((page) => page.url().includes('/studycontent') && matching(page));
  let video = context.pages().find((page) => page.url().includes('/lms-graph/') && matching(page));
  if (!course && !video && url) {
    course = await context.newPage();
    await course.goto(url, { waitUntil: 'domcontentloaded' });
  }
  return { course, video };
}

async function courseItems(page) {
  return page.locator('.leaf-detail').evaluateAll((rows) => rows.map((row) => ({
    title: row.querySelector('.leaf-title .title')?.textContent?.trim(),
    type: row.querySelector('.leaf-title .icon--shipin') ? '视频' : '其他',
    status: row.querySelector('.progress-wrap')?.textContent?.trim(),
  })).filter((row) => row.title));
}

async function videoItems(page) {
  return page.locator('.leaf-item').evaluateAll((rows) => rows.map((row, index) => ({
    index,
    title: row.querySelector('.leaf-item-title')?.textContent?.trim(),
    type: row.querySelector('.leaf-item-tag')?.textContent?.trim(),
    // 已完成的视频：状态位里是对勾图标；进行中的是进度环（--p 为百分比）。
    done: !!row.querySelector('.leaf-item-status .icon-yuanquangou-mianzhuang'),
    marked: row.querySelector('.leaf-item-status .icon-yuanquangou-mianzhuang, .leaf-item-status .status-pie') !== null,
    active: row.classList.contains('is-active'),
  })).filter((row) => row.title));
}

// 侧边栏是异步渲染的：行先出现、状态位后填充。
// 若在状态位填充前读取，就会把“未开始”误读成“已完成”，导致直接放弃播放。
async function sidebarItems(page, round = 1) {
  await page.locator('.leaf-item').first().waitFor({ timeout: 30000 });
  let items = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    items = await videoItems(page);
    if (items.length && items.every((item) => item.marked)) return items;
    await sleep(1000);
  }
  if (round < 2) {
    // 状态位迟迟不填充：刷新一次视频页后重试，避免用半成品数据下结论。
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('video').waitFor({ timeout: 30000 }).catch(() => {});
    return sidebarItems(page, round + 1);
  }
  return items;
}

async function openVideo(context, course) {
  console.log('等待课程目录；如果浏览器显示登录页，请先手动登录。');
  await course.locator('.leaf-detail').first().waitFor({ timeout: 0 });
  const notice = course.getByRole('button', { name: '我知道了' });
  if (await notice.isVisible().catch(() => false)) await notice.click();
  const rows = await courseItems(course);
  const first = rows.find((row) => row.type === '视频' && row.status !== '已完成');
  if (!first) throw new Error('课程页没有未完成视频');
  const newPage = context.waitForEvent('page', { timeout: 15000 });
  await course.locator('.leaf-detail').filter({ has: course.locator('.leaf-title .title', { hasText: first.title }) }).first().click();
  const page = await newPage;
  await page.waitForURL(/\/lms-graph\//, { timeout: 15000 });
  return page;
}

async function setSpeed(page, speed) {
  const current = await page.locator('video').evaluate((el) => el.playbackRate);
  if (current === speed) return;
  const control = page.locator('xt-speedbutton');
  await control.hover();
  await control.locator(`li[data-speed="${speed}"]`).click();
  await sleep(1000);
  const actual = await page.locator('video').evaluate((el) => el.playbackRate);
  if (Math.abs(actual - speed) > 0.01) console.warn(`课程将 ${speed} 倍速重置为 ${actual} 倍，继续按实际速度播放。`);
}

async function state(page) {
  return page.locator('video').evaluate((video) => ({
    currentTime: video.currentTime,
    duration: video.duration,
    paused: video.paused,
    ended: video.ended,
    readyState: video.readyState,
    playbackRate: video.playbackRate,
  }));
}

async function isDone(page, title) {
  const row = (await videoItems(page)).find((item) => item.title === title && item.type === '视频');
  if (row?.done) return true;
  const progress = await page.locator('.learning-space-control-unit .rate-detail').innerText().catch(() => '');
  return row?.active && /完成度：\s*100%/.test(progress);
}

async function watch(page, item, speed, counts) {
  await page.bringToFront();
  await renderOverlay(page, { title: item.title, status: '加载视频', ...counts });
  await page.locator('video').waitFor({ timeout: 30000 });
  await setSpeed(page, speed);
  let previous = -1;
  let stalledAt = Date.now();
  let lastLog = 0;
  while (true) {
    if (await isDone(page, item.title)) {
      await renderOverlay(page, { title: item.title, status: '平台已确认完成', ...counts, done: counts.done + 1 });
      return;
    }
    const s = await state(page);
    await renderOverlay(page, {
      title: item.title,
      status: s.ended ? '等待平台确认' : s.readyState < 2 ? '缓冲中' : s.paused ? '恢复播放中' : '播放中',
      currentTime: s.currentTime, duration: s.duration, rate: s.playbackRate,
      ...counts,
    });
    if (s.ended) break;
    if (s.paused && s.readyState >= 2) await page.locator('video').evaluate((video) => video.play());
    if (s.currentTime > previous + 0.5) {
      previous = s.currentTime;
      stalledAt = Date.now();
    } else if (Date.now() - stalledAt > 90000) {
      throw new Error(`视频停滞超过 90 秒：${item.title}`);
    }
    if (Date.now() - lastLog > 30000) {
      console.log(`[播放] ${item.title} ${Math.floor(s.currentTime)}/${Math.floor(s.duration)} 秒`);
      lastLog = Date.now();
    }
    await sleep(5000);
  }
  for (let i = 0; i < 12; i++) {
    if (await isDone(page, item.title)) {
      await renderOverlay(page, { title: item.title, status: '平台已确认完成', ...counts, done: counts.done + 1 });
      return;
    }
    await renderOverlay(page, { title: item.title, status: '等待平台确认', ...counts });
    await sleep(5000);
  }
  throw new Error(`播放结束，但页面没有确认完成：${item.title}。请检查网页提示。`);
}

async function startVideo(page, item) {
  if (item.active) return;
  const before = page.url();
  await page.locator('.leaf-item').nth(item.index).click();
  if (/\/video\/\d+/.test(before)) await page.waitForURL((url) => url.href !== before, { timeout: 30000 });
  else await page.waitForURL(/\/video\//, { timeout: 30000 });
  // 切换视频后侧边栏会重新渲染，等状态位填充完再进入播放判断。
  await page.locator('video').waitFor({ timeout: 30000 });
  await sidebarItems(page).catch(() => {});
}

async function runWatch(page, item, speed, counts) {
  try {
    await watch(page, item, speed, counts);
  } catch (error) {
    await renderOverlay(page, { title: item.title, status: `已停止：${error.message}`, ...counts }).catch(() => {});
    throw error;
  }
}

async function main() {
  const opts = options(process.argv.slice(2));
  if (opts.help) {
    console.log('用法：npm start -- [--url 课程链接] [--speed 1] [--limit 1] [--list] [--cdp http://127.0.0.1:9339]');
    return;
  }
  const connection = await connect(opts.cdp);
  try {
    let { course, video } = await findPages(connection.context, opts.url);
    if (!course && !video) throw new Error('未找到课程页面。请用 --url 提供学习内容链接。');
    if (opts.list) {
      if (!video) await course.locator('.leaf-detail').first().waitFor({ timeout: 0 });
      const items = video ? await videoItems(video) : await courseItems(course);
      console.table(items.filter((item) => item.type === '视频'));
      return;
    }
    if (!video) video = await openVideo(connection.context, course);
    let count = 0;
    while (count < opts.limit) {
      const items = await sidebarItems(video);
      const videos = items.filter((item) => item.type === '视频');
      const next = videos.find((item) => !item.done);
      if (!next) {
        // 侧边栏说“全完成”时，用课程目录复核一次，避免因渲染竞态而误判。
        if (course) {
          const expected = (await courseItems(course)).filter((row) => row.type === '视频').length;
          if (videos.length !== expected) {
            console.warn(`侧边栏读到 ${videos.length} 个视频，课程目录有 ${expected} 个，重新同步一次。`);
            await video.reload({ waitUntil: 'domcontentloaded' });
            await video.locator('video').waitFor({ timeout: 30000 }).catch(() => {});
            const retry = (await sidebarItems(video)).filter((item) => item.type === '视频');
            const pending = retry.find((item) => !item.done);
            if (!pending) {
              console.log(`目录中的视频均显示已完成（共 ${retry.length} 段）。`);
              break;
            }
            await startVideo(video, pending);
            const counts = {
              done: retry.filter((item) => item.done).length,
              total: retry.length,
            };
            await runWatch(video, pending, opts.speed, counts);
            count++;
            continue;
          }
        }
        console.log(`目录中的视频均显示已完成（共 ${videos.length} 段）。`);
        break;
      }
      await startVideo(video, next);
      console.log(`[开始] ${next.title}`);
      const counts = {
        done: videos.filter((item) => item.done).length,
        total: videos.length,
      };
      await runWatch(video, next, opts.speed, counts);
      console.log(`[完成] ${next.title}`);
      count++;
    }
    console.log(`本次完成 ${count} 段视频。`);
  } finally {
    await connection.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
