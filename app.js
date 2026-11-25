'use strict';

/* ============================================================
   Ассистент по поиску дублей фото
   Работает полностью локально в браузере.

   Два режима сканирования:
   - "single"  — одна папка, ищем дубли внутри неё
   - "compare" — две папки: A (эталон, не меняется) и
                 B (проверяемая, дубли переносятся отсюда)

   Полный режим (сканирование + перенос файлов) требует
   File System Access API (Chrome/Edge на ПК и Android).
   На остальных браузерах (например Safari/iOS) доступен
   ограниченный режим "только отчёт".
   ============================================================ */

const REVIEW_FOLDER_NAME = 'Дубликаты_на_проверку';
const MANIFEST_FILE_NAME = '_отчёт.json';

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'heic', 'heif'
]);

const supportsFSAccess = typeof window.showDirectoryPicker === 'function';

class ScanCancelled extends Error {}
let cancelRequested = false;
function checkCancelled() {
  if (cancelRequested) throw new ScanCancelled();
}

/* ---------- состояние приложения ---------- */
const state = {
  scanMode: null,      // 'single' | 'compare'
  writeMode: null,      // 'full' | 'readonly'
  folderAHandle: null,  // эталон (только для compare), не изменяется
  folderAName: '',
  folderBHandle: null,  // проверяемая папка / единственная папка в single-режиме
  folderBName: '',
  reviewHandle: null,   // создаётся внутри folderB (только если не dry-run)
  dryRun: false,        // true = ничего не переносить и не создавать, только показать
  items: [],            // {name, path, size, lastModified, type, file, hash, parentHandle, origin, role, location, reviewName, locked}
  groups: [],
};

/* ---------- элементы экрана ---------- */
const el = {
  intro: document.getElementById('screen-intro'),
  scan: document.getElementById('screen-scan'),
  results: document.getElementById('screen-results'),

  btnModeSingle: document.getElementById('btn-mode-single'),
  btnModeCompare: document.getElementById('btn-mode-compare'),
  panelSingle: document.getElementById('panel-single'),
  panelCompare: document.getElementById('panel-compare'),

  btnPickFolder: document.getElementById('btn-pick-folder'),
  fsSupportHint: document.getElementById('fs-support-hint'),
  chkDryRunSingle: document.getElementById('chk-dry-run-single'),

  btnPickA: document.getElementById('btn-pick-a'),
  btnPickB: document.getElementById('btn-pick-b'),
  labelA: document.getElementById('label-a'),
  labelB: document.getElementById('label-b'),
  btnStartCompare: document.getElementById('btn-start-compare'),
  fsSupportHintCompare: document.getElementById('fs-support-hint-compare'),
  chkDryRunCompare: document.getElementById('chk-dry-run-compare'),

  btnPickFilesFallback: document.getElementById('btn-pick-files-fallback'),

  progressFill: document.getElementById('progress-fill'),
  scanStatus: document.getElementById('scan-status'),
  statScanned: document.getElementById('stat-scanned'),
  statPhotos: document.getElementById('stat-photos'),
  statHashed: document.getElementById('stat-hashed'),
  btnCancelScan: document.getElementById('btn-cancel-scan'),

  summaryText: document.getElementById('summary-text'),
  groupsContainer: document.getElementById('groups-container'),
  btnDownloadReport: document.getElementById('btn-download-report'),
  btnRestart: document.getElementById('btn-restart'),
};

function showScreen(name) {
  el.intro.classList.toggle('hidden', name !== 'intro');
  el.scan.classList.toggle('hidden', name !== 'scan');
  el.results.classList.toggle('hidden', name !== 'results');
}

const supportHintText = supportsFSAccess
  ? 'Полный режим доступен: ассистент сам создаст папку и перенесёт дубли на проверку.'
  : 'Ваш браузер не поддерживает полный режим (создание папок, перенос файлов). Используйте ручной выбор файлов ниже.';
el.fsSupportHint.textContent = supportHintText;
el.fsSupportHintCompare.textContent = supportHintText;
if (!supportsFSAccess) {
  el.btnPickFolder.disabled = true;
  el.btnPickA.disabled = true;
  el.btnPickB.disabled = true;
}

/* ---------- переключение режима "одна папка" / "сравнение" ---------- */
el.btnModeSingle.addEventListener('click', () => {
  el.btnModeSingle.classList.add('active');
  el.btnModeCompare.classList.remove('active');
  el.panelSingle.classList.remove('hidden');
  el.panelCompare.classList.add('hidden');
});
el.btnModeCompare.addEventListener('click', () => {
  el.btnModeCompare.classList.add('active');
  el.btnModeSingle.classList.remove('active');
  el.panelCompare.classList.remove('hidden');
  el.panelSingle.classList.add('hidden');
});

/* ============================================================
   ОПРЕДЕЛЕНИЕ "ЭТО ФОТО" — по расширению И по содержимому файла
   ============================================================ */
function hasImageExtension(name) {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function detectImageSignature(bytes) {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'JPEG';
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'PNG';
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'GIF';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4D) return 'BMP';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'WEBP';
  if (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'HEIC/HEIF';
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A && b[3] === 0x00) ||
                        (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0x00 && b[3] === 0x2A))) return 'TIFF';
  return null;
}

async function verifyIsPhoto(file) {
  if (!hasImageExtension(file.name)) return null;
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  return detectImageSignature(head);
}

/* ============================================================
   ХЕШИРОВАНИЕ СОДЕРЖИМОГО (для точных дублей)
   ============================================================ */
async function sha256Hex(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/* ============================================================
   ПОЛНЫЙ РЕЖИМ: File System Access API
   ============================================================ */
async function* walkDirectory(dirHandle, path, depth) {
  for await (const [name, handle] of dirHandle.entries()) {
    checkCancelled();
    if (depth === 0 && handle.kind === 'directory' && name === REVIEW_FOLDER_NAME) {
      continue; // не пересканируем папку с дублями
    }
    const childPath = path ? `${path}/${name}` : name;
    if (handle.kind === 'directory') {
      yield* walkDirectory(handle, childPath, depth + 1);
    } else {
      yield { name, handle, path: childPath, parentHandle: dirHandle };
    }
  }
}

function sanitizeForFilename(str) {
  return str.replace(/[\/\\:*?"<>|]/g, '_');
}

async function collectPhotosFromFolder(rootHandle, origin, onProgress) {
  const candidates = [];
  let scanned = 0;
  for await (const entry of walkDirectory(rootHandle, '', 0)) {
    checkCancelled();
    scanned++;
    const file = await entry.handle.getFile();
    const type = await verifyIsPhoto(file);
    if (type) {
      candidates.push({ ...entry, file, type, origin });
    }
    if (scanned % 10 === 0) {
      onProgress(scanned, candidates.length);
      await yieldToUI();
    }
  }
  onProgress(scanned, candidates.length);
  return candidates;
}

async function hashCandidates(candidates, onHashed) {
  const results = [];
  for (const c of candidates) {
    checkCancelled();
    const hash = await sha256Hex(c.file);
    onHashed();
    results.push({
      name: c.name,
      path: c.path,
      size: c.file.size,
      lastModified: c.file.lastModified,
      type: c.type,
      file: c.file,
      hash,
      parentHandle: c.parentHandle,
      origin: c.origin,       // 'A' | 'B'
      role: null,              // 'original' | 'duplicate'
      location: 'source',      // 'source' | 'review' | 'deleted' | 'restored'
      reviewName: null,
      locked: false,           // true = дубль внутри эталонной папки A, не трогаем
    });
  }
  return results;
}

async function runSingleScan(rootHandle) {
  state.scanMode = 'single';
  state.writeMode = 'full';
  state.folderAHandle = null;
  state.folderAName = '';
  state.folderBHandle = rootHandle;
  state.folderBName = rootHandle.name;
  state.items = [];

  updateScanStats(0, 0, 0);
  el.progressFill.style.width = '8%';
  el.scanStatus.textContent = `Обхожу «${rootHandle.name}» и подпапки…`;

  const candidates = await collectPhotosFromFolder(rootHandle, 'B', (scanned, found) => {
    updateScanStats(scanned, found, 0);
  });

  el.progressFill.style.width = '45%';
  el.scanStatus.textContent = 'Сравниваю содержимое файлов (хеширование)…';

  let h = 0;
  state.items = await hashCandidates(candidates, () => {
    h++;
    if (h % 5 === 0) {
      updateScanStats(candidates.length, candidates.length, h);
      el.progressFill.style.width = (45 + Math.min(45, (h / candidates.length) * 45)) + '%';
    }
  });
  updateScanStats(candidates.length, candidates.length, h);

  el.scanStatus.textContent = 'Группирую и переношу подозрительные копии…';
  buildGroups();
  await quarantineDuplicates();
  el.progressFill.style.width = '100%';
}

async function runCompareScan(handleA, handleB) {
  state.scanMode = 'compare';
  state.writeMode = 'full';
  state.folderAHandle = handleA;
  state.folderAName = handleA.name;
  state.folderBHandle = handleB;
  state.folderBName = handleB.name;
  state.items = [];

  updateScanStats(0, 0, 0);
  el.progressFill.style.width = '5%';
  el.scanStatus.textContent = `Обхожу папку A «${handleA.name}»…`;
  const candidatesA = await collectPhotosFromFolder(handleA, 'A', (scanned, found) => {
    updateScanStats(scanned, found, 0);
  });

  el.progressFill.style.width = '25%';
  el.scanStatus.textContent = `Обхожу папку B «${handleB.name}»…`;
  const candidatesB = await collectPhotosFromFolder(handleB, 'B', (scanned, found) => {
    updateScanStats(candidatesA.length + scanned, candidatesA.length + found, 0);
  });

  const allCandidates = [...candidatesA, ...candidatesB];
  updateScanStats(allCandidates.length, allCandidates.length, 0);

  el.progressFill.style.width = '55%';
  el.scanStatus.textContent = 'Сравниваю содержимое файлов (хеширование)…';

  let h = 0;
  state.items = await hashCandidates(allCandidates, () => {
    h++;
    if (h % 5 === 0) {
      updateScanStats(allCandidates.length, allCandidates.length, h);
      el.progressFill.style.width = (55 + Math.min(35, (h / allCandidates.length) * 35)) + '%';
    }
  });
  updateScanStats(allCandidates.length, allCandidates.length, h);

  el.scanStatus.textContent = 'Группирую и переношу подозрительные копии из папки B…';
  buildGroups();
  await quarantineDuplicates();
  el.progressFill.style.width = '100%';
}

function updateScanStats(scanned, photos, hashed) {
  el.statScanned.textContent = String(scanned);
  el.statPhotos.textContent = String(photos);
  el.statHashed.textContent = String(hashed);
}

/**
 * Группировка по хешу с учётом происхождения (A/B).
 * Если хотя бы одна копия есть в эталонной папке A — она считается
 * оригиналом, все копии в B помечаются дублями (и переносятся).
 * Если у A внутри себя больше одной копии — лишние копии в A
 * помечаются дублями, но НЕ трогаются (locked = true).
 * Если совпадений в A нет — обычная логика: самая старая копия
 * в B считается оригиналом, остальные в B — дублями.
 */
function buildGroups() {
  const byHash = new Map();
  for (const item of state.items) {
    if (!byHash.has(item.hash)) byHash.set(item.hash, []);
    byHash.get(item.hash).push(item);
  }
  state.groups = [];
  for (const [hash, items] of byHash.entries()) {
    if (items.length < 2) continue;

    const fromA = items.filter(i => i.origin === 'A');
    const fromB = items.filter(i => i.origin === 'B');

    if (fromA.length > 0) {
      fromA.sort((a, b) => a.lastModified - b.lastModified || a.path.length - b.path.length);
      fromA[0].role = 'original';
      for (let i = 1; i < fromA.length; i++) {
        fromA[i].role = 'duplicate';
        fromA[i].locked = true; // внутри эталонной папки — не переносим
      }
      for (const b of fromB) b.role = 'duplicate';
    } else {
      items.sort((a, b) => a.lastModified - b.lastModified || a.path.length - b.path.length);
      items[0].role = 'original';
      for (let i = 1; i < items.length; i++) items[i].role = 'duplicate';
    }

    state.groups.push({ hash, items });
  }
  state.groups.sort((a, b) => b.items[0].size - a.items[0].size);
}

async function quarantineDuplicates() {
  if (state.dryRun) return; // режим "только отчёт" — ничего не создаём и не переносим

  const duplicates = state.groups.flatMap(g => g.items.filter(i => i.role === 'duplicate' && !i.locked));
  if (duplicates.length === 0) return;

  let reviewHandle;
  try {
    reviewHandle = await state.folderBHandle.getDirectoryHandle(REVIEW_FOLDER_NAME, { create: true });
  } catch (e) {
    console.error('Не удалось создать папку для карантина:', e);
    return; // остаёмся в режиме "только отчёт" для этого запуска
  }
  state.reviewHandle = reviewHandle;

  let idx = 0;
  for (const group of state.groups) {
    if (cancelRequested) break; // уже перенесённые файлы остаются в карантине как есть
    idx++;
    let dupIdx = 0;
    for (const item of group.items) {
      if (cancelRequested) break;
      if (item.role !== 'duplicate' || item.locked) continue;
      dupIdx++;
      const safeName = `g${idx}_${dupIdx}_${sanitizeForFilename(item.name)}`;
      try {
        const writable = await (await reviewHandle.getFileHandle(safeName, { create: true })).createWritable();
        await writable.write(item.file);
        await writable.close();
        await item.parentHandle.removeEntry(item.name);
        item.location = 'review';
        item.reviewName = safeName;
      } catch (e) {
        console.error('Не удалось перенести файл в карантин:', item.path, e);
      }
    }
  }

  await writeManifest();
}

async function writeManifest() {
  const manifest = state.groups.map(g => ({
    hash: g.hash,
    original: g.items.find(i => i.role === 'original')
      ? { path: g.items.find(i => i.role === 'original').path, origin: g.items.find(i => i.role === 'original').origin }
      : null,
    duplicates: g.items.filter(i => i.role === 'duplicate').map(i => ({
      originalPath: i.path,
      origin: i.origin,
      reviewName: i.reviewName,
      status: i.location,
      locked: i.locked,
    })),
  }));
  try {
    const fh = await state.reviewHandle.getFileHandle(MANIFEST_FILE_NAME, { create: true });
    const writable = await fh.createWritable();
    await writable.write(JSON.stringify(manifest, null, 2));
    await writable.close();
  } catch (e) {
    console.warn('Не удалось записать файл-отчёт в папку карантина:', e);
  }
}

async function deleteFromReview(item) {
  if (!confirm(`Удалить окончательно?\n\n${item.path}\n\nЭто действие нельзя отменить.`)) return;
  await state.reviewHandle.removeEntry(item.reviewName);
  item.location = 'deleted';
  renderResults();
}

async function restoreToSource(item) {
  if (!confirm(`Вернуть файл в исходную папку?\n\n${item.path}`)) return;
  try {
    const fh = await item.parentHandle.getFileHandle(item.name, { create: true });
    const writable = await fh.createWritable();
    await writable.write(item.file);
    await writable.close();
    await state.reviewHandle.removeEntry(item.reviewName);
    item.location = 'restored';
  } catch (e) {
    alert('Не удалось вернуть файл: ' + e.message);
    console.error(e);
  }
  renderResults();
}

/* ============================================================
   ОГРАНИЧЕННЫЙ РЕЖИМ (без File System Access API)
   Только поиск и отчёт, без переноса/удаления.
   ============================================================ */
async function runFallbackScan(fileList) {
  state.scanMode = 'single';
  state.writeMode = 'readonly';
  state.dryRun = true;
  state.folderAHandle = null;
  state.folderBHandle = null;
  state.items = [];

  const files = Array.from(fileList);
  el.statScanned.textContent = String(files.length);
  el.scanStatus.textContent = 'Проверяю содержимое файлов…';

  const candidates = [];
  for (const file of files) {
    checkCancelled();
    const type = await verifyIsPhoto(file);
    if (type) {
      candidates.push({ file, type, path: file.webkitRelativePath || file.name, origin: 'B' });
      el.statPhotos.textContent = String(candidates.length);
    }
  }
  el.progressFill.style.width = '50%';

  let h = 0;
  const results = [];
  for (const c of candidates) {
    checkCancelled();
    const hash = await sha256Hex(c.file);
    h++;
    if (h % 5 === 0) {
      el.statHashed.textContent = String(h);
      el.progressFill.style.width = (50 + Math.min(45, (h / candidates.length) * 45)) + '%';
      await yieldToUI();
    }
    results.push({
      name: c.file.name,
      path: c.path,
      size: c.file.size,
      lastModified: c.file.lastModified,
      type: c.type,
      file: c.file,
      hash,
      parentHandle: null,
      origin: 'B',
      role: null,
      location: 'source',
      reviewName: null,
      locked: false,
    });
  }
  state.items = results;
  el.statHashed.textContent = String(h);
  el.progressFill.style.width = '100%';

  buildGroups();
}

/* ============================================================
   UI: отрисовка результатов
   ============================================================ */
function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
  return (bytes / (1024 * 1024)).toFixed(2) + ' МБ';
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString('ru-RU');
}

function roleLabel(item) {
  if (item.location === 'deleted') return { text: 'Удалено', cls: 'deleted' };
  if (item.location === 'restored') return { text: 'Возвращено в исходную папку', cls: 'restored' };
  if (item.role === 'original') return { text: 'Оригинал', cls: 'original' };
  if (item.locked) return { text: 'Дубль внутри эталонной папки (не перемещён)', cls: 'locked' };
  const suffix = state.dryRun ? ' (файл не тронут — режим «только отчёт»)' : (state.writeMode === 'full' ? ' (в карантине)' : '');
  return { text: 'Дубль' + suffix, cls: state.dryRun ? 'locked' : 'duplicate' };
}

function originTag(item) {
  if (state.scanMode !== 'compare') return '';
  return item.origin === 'A' ? `📁 A: ${state.folderAName}` : `📁 B: ${state.folderBName}`;
}

function renderResults() {
  showScreen('results');
  const totalDuplicates = state.groups.reduce((n, g) => n + g.items.filter(i => i.role === 'duplicate' && !i.locked).length, 0);
  const totalLocked = state.groups.reduce((n, g) => n + g.items.filter(i => i.locked).length, 0);

  const scope = state.scanMode === 'compare'
    ? `папках A «${state.folderAName}» и B «${state.folderBName}»`
    : `папке «${state.folderBName || 'выбранных файлах'}»`;

  if (state.writeMode === 'full' && state.dryRun) {
    let text = `Проверено фото: ${state.items.length} в ${scope}. Найдено групп дублей: ${state.groups.length} (дублей: ${totalDuplicates + totalLocked}). Режим «только отчёт» — ни один файл не тронут, папка «${REVIEW_FOLDER_NAME}» не создавалась.`;
    if (totalDuplicates + totalLocked === 0) {
      text = `Проверено фото: ${state.items.length} в ${scope}. Точных дублей не найдено.`;
    }
    el.summaryText.textContent = text;
  } else if (state.writeMode === 'full') {
    let text = `Проверено фото: ${state.items.length} в ${scope}. Найдено групп дублей: ${state.groups.length}`;
    text += totalDuplicates > 0
      ? ` (перенесено в карантин: ${totalDuplicates}).`
      : `, все переносимые дубли отсутствуют.`;
    if (totalLocked > 0) {
      text += ` Ещё ${totalLocked} дубль(ей) найдено внутри эталонной папки A — они не тронуты (папка A не изменяется).`;
    }
    if (totalDuplicates === 0 && totalLocked === 0) {
      text = `Проверено фото: ${state.items.length} в ${scope}. Точных дублей не найдено — папка «${REVIEW_FOLDER_NAME}» не создавалась.`;
    }
    el.summaryText.textContent = text;
  } else {
    el.summaryText.textContent = (totalDuplicates + totalLocked) > 0
      ? `Проверено файлов: ${state.items.length}. Найдено групп дублей: ${state.groups.length}. Режим только для отчёта — перенос и удаление недоступны в этом браузере.`
      : `Проверено файлов: ${state.items.length}. Точных дублей не найдено.`;
  }

  el.groupsContainer.innerHTML = '';

  if (state.groups.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Дубликаты не найдены 🎉';
    el.groupsContainer.appendChild(empty);
    return;
  }

  state.groups.forEach((group, gi) => {
    const card = document.createElement('div');
    card.className = 'group-card';

    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = `Группа ${gi + 1} · ${group.items.length} файл(ов) · ${fmtSize(group.items[0].size)} каждый`;
    card.appendChild(title);

    group.items.forEach(item => {
      card.appendChild(renderFileRow(item));
    });

    el.groupsContainer.appendChild(card);
  });
}

function renderFileRow(item) {
  const row = document.createElement('div');
  const label = roleLabel(item);
  row.className = `file-row role-${label.cls}`;

  const thumb = document.createElement('img');
  thumb.className = 'thumb';
  thumb.loading = 'lazy';
  try {
    thumb.src = URL.createObjectURL(item.file);
  } catch (e) { /* ignore */ }
  row.appendChild(thumb);

  const info = document.createElement('div');
  info.className = 'file-info';

  const badge = document.createElement('span');
  badge.className = `badge badge-${label.cls}`;
  badge.textContent = label.text;
  info.appendChild(badge);

  const origin = originTag(item);
  if (origin) {
    const tag = document.createElement('span');
    tag.className = 'origin-tag';
    tag.textContent = origin;
    info.appendChild(tag);
  }

  const pathEl = document.createElement('div');
  pathEl.className = 'file-path';
  pathEl.textContent = item.path;
  info.appendChild(pathEl);

  const meta = document.createElement('div');
  meta.className = 'file-meta';
  meta.textContent = `${fmtSize(item.size)} · ${fmtDate(item.lastModified)} · ${item.type}`;
  info.appendChild(meta);

  row.appendChild(info);

  if (state.writeMode === 'full' && item.role === 'duplicate' && !item.locked && item.location === 'review') {
    const actions = document.createElement('div');
    actions.className = 'file-actions';

    const btnDelete = document.createElement('button');
    btnDelete.className = 'btn btn-danger';
    btnDelete.textContent = 'Удалить окончательно';
    btnDelete.onclick = () => deleteFromReview(item);
    actions.appendChild(btnDelete);

    const btnRestore = document.createElement('button');
    btnRestore.className = 'btn btn-secondary';
    btnRestore.textContent = 'Вернуть в исходную папку';
    btnRestore.onclick = () => restoreToSource(item);
    actions.appendChild(btnRestore);

    row.appendChild(actions);
  }

  return row;
}

/* ============================================================
   ОТЧЁТ CSV
   ============================================================ */
function downloadCsvReport() {
  const rows = [['Группа', 'Роль', 'Папка', 'Путь', 'Размер (байт)', 'Изменён', 'Хеш (SHA-256)', 'Статус']];
  state.groups.forEach((g, gi) => {
    g.items.forEach(item => {
      rows.push([
        gi + 1,
        item.role === 'original' ? 'Оригинал' : (item.locked ? 'Дубль (в эталоне, не тронут)' : 'Дубль'),
        state.scanMode === 'compare' ? (item.origin === 'A' ? `A: ${state.folderAName}` : `B: ${state.folderBName}`) : (state.folderBName || ''),
        item.path,
        item.size,
        fmtDate(item.lastModified),
        item.hash,
        item.location,
      ]);
    });
  });
  const csv = rows.map(row => row.map(value => {
    const text = String(value);
    // Spreadsheet programs interpret some text values as formulas.
    const safe = typeof value === 'string' && /^\s*[=+\-@]/.test(text) ? "'" + text : text;
    return '"' + safe.replace(/"/g, '""') + '"';
  }).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'отчёт_дубли_фото.csv';
  a.click();
}

/* ============================================================
   ВСПОМОГАТЕЛЬНОЕ
   ============================================================ */
function yieldToUI() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/* ============================================================
   ОБРАБОТЧИКИ КНОПОК
   ============================================================ */
function onScanCancelled() {
  el.scanStatus.textContent = 'Сканирование отменено.';
  showScreen('intro');
}

el.btnCancelScan.addEventListener('click', () => {
  cancelRequested = true;
  el.btnCancelScan.disabled = true;
  el.btnCancelScan.textContent = 'Отменяю…';
  el.scanStatus.textContent = 'Останавливаю сканирование (может занять пару секунд, идёт текущая файловая операция)…';
});

el.btnPickFolder.addEventListener('click', async () => {
  try {
    const dryRun = el.chkDryRunSingle.checked;
    const dirHandle = await window.showDirectoryPicker();
    const perm = await dirHandle.requestPermission({ mode: dryRun ? 'read' : 'readwrite' });
    if (!dryRun && perm !== 'granted') {
      alert('Без разрешения на запись ассистент не сможет переносить файлы. Работаю в режиме чтения — покажу только отчёт.');
    }
    state.dryRun = dryRun;
    cancelRequested = false;
    el.btnCancelScan.disabled = false;
    el.btnCancelScan.textContent = '⏹ Отменить сканирование';
    showScreen('scan');
    await runSingleScan(dirHandle);
    renderResults();
  } catch (e) {
    if (e instanceof ScanCancelled) {
      onScanCancelled();
    } else if (e.name !== 'AbortError') {
      console.error(e);
      alert('Не удалось открыть папку: ' + e.message);
    }
  }
});

function updateCompareLabels() {
  el.labelA.textContent = state.folderAHandle ? state.folderAHandle.name : 'не выбрана';
  el.labelA.classList.toggle('picked', !!state.folderAHandle);
  el.labelB.textContent = state.folderBHandle ? state.folderBHandle.name : 'не выбрана';
  el.labelB.classList.toggle('picked', !!state.folderBHandle);
  el.btnStartCompare.disabled = !(state.folderAHandle && state.folderBHandle);
}

el.btnPickA.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker();
    await handle.requestPermission({ mode: 'read' });
    state.folderAHandle = handle;
    updateCompareLabels();
  } catch (e) {
    if (e.name !== 'AbortError') console.error(e);
  }
});

el.btnPickB.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker();
    const dryRun = el.chkDryRunCompare.checked;
    const perm = await handle.requestPermission({ mode: dryRun ? 'read' : 'readwrite' });
    if (!dryRun && perm !== 'granted') {
      alert('Без разрешения на запись ассистент не сможет переносить дубли из папки B.');
    }
    state.folderBHandle = handle;
    updateCompareLabels();
  } catch (e) {
    if (e.name !== 'AbortError') console.error(e);
  }
});

el.btnStartCompare.addEventListener('click', async () => {
  if (!state.folderAHandle || !state.folderBHandle) return;
  state.dryRun = el.chkDryRunCompare.checked;
  cancelRequested = false;
  el.btnCancelScan.disabled = false;
  el.btnCancelScan.textContent = '⏹ Отменить сканирование';
  showScreen('scan');
  try {
    await runCompareScan(state.folderAHandle, state.folderBHandle);
    renderResults();
  } catch (e) {
    if (e instanceof ScanCancelled) {
      onScanCancelled();
    } else {
      console.error(e);
      alert('Ошибка при сравнении папок: ' + e.message);
      showScreen('intro');
    }
  }
});

el.btnPickFilesFallback.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'image/*';
  input.webkitdirectory = true; // если поддерживается — позволит выбрать папку целиком
  input.onchange = async () => {
    if (!input.files || input.files.length === 0) return;
    cancelRequested = false;
    el.btnCancelScan.disabled = false;
    el.btnCancelScan.textContent = '⏹ Отменить сканирование';
    showScreen('scan');
    try {
      await runFallbackScan(input.files);
      renderResults();
    } catch (e) {
      if (e instanceof ScanCancelled) {
        onScanCancelled();
      } else {
        console.error(e);
        alert('Ошибка при сканировании: ' + e.message);
        showScreen('intro');
      }
    }
  };
  input.click();
});

el.btnDownloadReport.addEventListener('click', downloadCsvReport);

el.btnRestart.addEventListener('click', () => {
  state.scanMode = null;
  state.writeMode = null;
  state.dryRun = false;
  state.folderAHandle = null;
  state.folderAName = '';
  state.folderBHandle = null;
  state.folderBName = '';
  state.reviewHandle = null;
  state.items = [];
  state.groups = [];
  updateCompareLabels();
  showScreen('intro');
});
