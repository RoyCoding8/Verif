// Checkpoint stub. desktop/public is owned by the desktop-ui job.
async function boot() {
  const state = await (await fetch('/api/state')).json();
  document.getElementById('host').textContent = state.hostname;
}
boot();
