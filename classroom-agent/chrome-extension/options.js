const endpoint = document.getElementById('endpoint');
const token = document.getElementById('token');
const status = document.getElementById('status');
const save = document.getElementById('save');
const test = document.getElementById('test');

document.addEventListener('DOMContentLoaded', async () => {
  const config = await chrome.storage.local.get({ endpoint: '', token: '' });
  endpoint.value = config.endpoint;
  token.value = config.token;
});

save.addEventListener('click', async () => {
  const config = readForm();
  await chrome.storage.local.set(config);
  status.textContent = 'Configuración guardada.';
});

test.addEventListener('click', async () => {
  status.textContent = 'Probando conexión…';
  try {
    const config = readForm();
    const url = new URL(config.endpoint);
    url.searchParams.set('token', config.token);
    url.searchParams.set('action', 'health');
    const response = await fetch(url.toString(), {
      redirect: 'follow',
      cache: 'no-store',
      credentials: 'include',
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || 'El agente no respondió correctamente.');
    status.textContent = 'Conexión correcta.';
  } catch (error) {
    status.textContent = error.message || String(error);
  }
});

function readForm() {
  const config = {
    endpoint: endpoint.value.trim(),
    token: token.value.trim(),
  };
  if (!/^https:\/\//i.test(config.endpoint)) throw new Error('La URL debe comenzar con https://');
  if (config.token.length < 20) throw new Error('El token no parece válido.');
  return config;
}
