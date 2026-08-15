// login.js —— 登录页交互
// 先查 /_api/status:若未设 ADMIN_PASSWORD 则免密直接进面板,否则显示密码框。

const $ = (id) => document.getElementById(id);

(async () => {
  const errEl = $('login-err');
  try {
    const r = await fetch('/_api/status');
    const st = await r.json();
    if (!st.passwordRequired) {
      location.replace('/');
      return;
    }
  } catch { /* 状态接口挂了也照常显示密码框 */ }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    const btn = $('btn-login');
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const r = await fetch('/_api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('f-pass').value }),
      });
      if (r.ok) { location.replace('/'); return; }
      const j = await r.json().catch(() => ({}));
      errEl.textContent = j.error?.message || `登录失败 (HTTP ${r.status})`;
      errEl.hidden = false;
    } catch (err) {
      errEl.textContent = '请求失败:' + err.message;
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = '进入面板';
    }
  });
})();
