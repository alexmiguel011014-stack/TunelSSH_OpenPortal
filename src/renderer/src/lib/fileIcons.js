const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff', 'heic', 'raw'];
const VIDEO_EXT = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts'];
const AUDIO_EXT = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus'];
const DOC_EXT = ['doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'log'];
const SHEET_EXT = ['xls', 'xlsx', 'ods', 'csv'];
const SLIDE_EXT = ['ppt', 'pptx', 'odp'];
const PDF_EXT = ['pdf'];
const CODE_EXT = ['js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'php', 'html', 'css', 'scss', 'json', 'xml', 'yml', 'yaml', 'sh', 'bat', 'ps1', 'sql', 'vue', 'svelte'];
const ARCHIVE_EXT = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'];
const EXE_EXT = ['exe', 'msi', 'app', 'bat', 'cmd'];
const DB_EXT = ['db', 'sqlite', 'sqlite3', 'mdb', 'accdb'];

export function getFileIcon(fileName, isDir) {
  if (isDir) return { icon: '📁', color: '#fbbf24' };
  const ext = (fileName || '').split('.').pop().toLowerCase();
  if (IMAGE_EXT.includes(ext)) return { icon: '🖼️', color: '#a78bfa' };
  if (VIDEO_EXT.includes(ext)) return { icon: '🎬', color: '#f472b6' };
  if (AUDIO_EXT.includes(ext)) return { icon: '🎵', color: '#34d399' };
  if (PDF_EXT.includes(ext)) return { icon: '📕', color: '#f87171' };
  if (DOC_EXT.includes(ext)) return { icon: '📝', color: '#60a5fa' };
  if (SHEET_EXT.includes(ext)) return { icon: '📊', color: '#34d399' };
  if (SLIDE_EXT.includes(ext)) return { icon: '📽️', color: '#fb923c' };
  if (CODE_EXT.includes(ext)) return { icon: '💻', color: '#facc15' };
  if (ARCHIVE_EXT.includes(ext)) return { icon: '🗜️', color: '#cbd5e1' };
  if (EXE_EXT.includes(ext)) return { icon: '⚙️', color: '#94a3b8' };
  if (DB_EXT.includes(ext)) return { icon: '🗄️', color: '#fbbf24' };
  return { icon: '📄', color: '#94a3b8' };
}

export function isDirEntry(entry) {
  return !!(entry && entry.d);
}
