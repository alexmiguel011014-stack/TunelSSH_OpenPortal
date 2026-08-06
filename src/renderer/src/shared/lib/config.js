const STORAGE_KEY = 'openportal-machines';

export function loadMachines() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveMachines(machines) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(machines));
}

export function clearMachines() {
  localStorage.removeItem(STORAGE_KEY);
}
