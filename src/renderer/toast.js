const $ = (id) => document.getElementById(id);
const api = window.pitaya;

function reportSize() {
  requestAnimationFrame(() => api.send('toast:resize', $('app').offsetHeight + 2));
}

// { state: 'busy' | 'done' | 'error', title, sub, progress, canUndo, openLabel }
api.on('toast:show', (t) => {
  const icon = $('icon');
  icon.className = `icon ${t.state === 'done' ? 'ok' : t.state === 'error' ? 'error' : ''}`;
  icon.textContent = t.state === 'busy' ? '…' : t.state === 'error' ? '!' : t.undone ? '↩' : '✓';
  $('title').textContent = t.title || '';
  $('title').title = t.title || '';
  const sub = $('sub');
  sub.textContent = t.sub || '';
  sub.title = t.sub || '';
  sub.classList.toggle('error', !!t.subError);
  $('bar').hidden = t.state !== 'busy';
  $('fill').style.width = `${Math.round((t.progress || 0) * 100)}%`;
  $('undo').hidden = !t.canUndo;
  $('open').hidden = !t.openLabel;
  $('open').textContent = t.openLabel || '';
  $('buttons').hidden = !t.canUndo && !t.openLabel;
  $('close').hidden = t.state === 'busy';
  reportSize();
});

$('undo').addEventListener('click', () => api.send('toast:undo'));
$('open').addEventListener('click', () => api.send('toast:open'));
$('close').addEventListener('click', () => api.send('toast:close'));
