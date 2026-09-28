const formatTime = (seconds) => {
  if (!Number.isFinite(seconds)) return '--:--';
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const secs = value % 60;
  return [hours, minutes, secs].filter((_, index) => hours || index > 0).map((part) => String(part).padStart(2, '0')).join(':');
};

export async function renderOverlay(page, data) {
  const duration = data.duration ?? 0;
  const currentTime = data.currentTime ?? 0;
  const percent = duration > 0 ? Math.min(100, Math.max(0, currentTime / duration * 100)) : 0;
  const view = {
    title: data.title ?? '等待视频',
    status: data.status ?? '运行中',
    count: `${data.done ?? 0} / ${data.total ?? 0} 段已完成`,
    time: `${formatTime(currentTime)} / ${formatTime(duration)}`,
    rate: `${data.rate ?? 1}×`,
    percent: `${percent.toFixed(1)}%`,
    width: `${percent}%`,
  };
  await page.evaluate((details) => {
    let host = document.getElementById('yuketang-assistant-overlay');
    if (!host) {
      host = document.createElement('div');
      host.id = 'yuketang-assistant-overlay';
      Object.assign(host.style, {
        position: 'fixed', top: '20px', right: '20px', zIndex: '2147483647',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      });
      document.body.append(host);
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          * { box-sizing: border-box; }
          .card { width: 300px; color: #e9f2fb; background: rgba(15, 23, 42, .96); border: 1px solid #4b647d; border-radius: 12px; box-shadow: 0 12px 32px #0008; font: 13px/1.5 system-ui, sans-serif; overflow: hidden; }
          .head { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; cursor: move; background: #18283b; user-select: none; touch-action: none; }
          .brand { font-weight: 700; letter-spacing: .03em; }
          button { border: 0; border-radius: 5px; background: #314b66; color: white; width: 24px; height: 24px; cursor: pointer; font-size: 16px; }
          .body { padding: 12px; }
          .status { color: #72e4bc; font-weight: 600; }
          .course { margin-top: 7px; color: #c8d7e5; }
          .title { margin: 3px 0 10px; font-weight: 600; overflow-wrap: anywhere; max-height: 3em; overflow: hidden; }
          .bar { height: 7px; border-radius: 7px; background: #34465b; overflow: hidden; }
          .fill { height: 100%; background: #52d8a3; border-radius: 7px; transition: width .3s; }
          .meta { display: flex; justify-content: space-between; margin-top: 8px; color: #b8c9d8; font-variant-numeric: tabular-nums; }
          .card.collapsed { width: 150px; }
          .collapsed .body { display: none; }
          .stale .status { color: #f0bd6d; }
        </style>
        <div class="card">
          <div class="head"><span class="brand">雨课堂助手</span><button id="toggle" title="折叠或展开">−</button></div>
          <div class="body">
            <div class="status" id="status"></div>
            <div class="course" id="count"></div>
            <div class="title" id="title"></div>
            <div class="bar"><div class="fill" id="fill"></div></div>
            <div class="meta"><span id="time"></span><span id="rate"></span><span id="percent"></span></div>
          </div>
        </div>`;
      const card = root.querySelector('.card');
      const toggle = root.getElementById('toggle');
      toggle.addEventListener('click', () => {
        card.classList.toggle('collapsed');
        toggle.textContent = card.classList.contains('collapsed') ? '+' : '−';
      });
      const head = root.querySelector('.head');
      let drag;
      head.addEventListener('pointerdown', (event) => {
        if (event.target === toggle) return;
        const rect = host.getBoundingClientRect();
        drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        head.setPointerCapture(event.pointerId);
      });
      head.addEventListener('pointermove', (event) => {
        if (!drag) return;
        host.style.right = 'auto';
        host.style.left = `${Math.max(0, Math.min(innerWidth - host.offsetWidth, event.clientX - drag.x))}px`;
        host.style.top = `${Math.max(0, Math.min(innerHeight - host.offsetHeight, event.clientY - drag.y))}px`;
      });
      head.addEventListener('pointerup', () => { drag = undefined; });
      head.addEventListener('lostpointercapture', () => { drag = undefined; });
      setInterval(() => {
        if (Date.now() - Number(host.dataset.updatedAt || 0) > 20000) {
          card.classList.add('stale');
          root.getElementById('status').textContent = '等待脚本更新';
        }
      }, 5000);
    }
    const root = host.shadowRoot;
    root.querySelector('.card').classList.remove('stale');
    for (const key of ['title', 'status', 'count', 'time', 'rate', 'percent']) root.getElementById(key).textContent = details[key];
    root.getElementById('fill').style.width = details.width;
    host.dataset.updatedAt = String(Date.now());
  }, view);
}
