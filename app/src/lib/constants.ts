/**
 * Application-wide constants and configuration values
 */

export const FILE_LIMITS = {
  MAX_SIZE: 10 * 1024 * 1024, // 10MB
  MAX_COUNT: 5000,
} as const;

export const SCHEMA_LIMITS = {
  MAX_SIZE: 1 * 1024 * 1024, // 1MB for schema DDL
} as const;

export const ANALYSIS_CACHE_LIMITS = {
  MAX_SIZE_MB: 250,
} as const;

export const ANALYSIS_CACHE_MAX_BYTES = ANALYSIS_CACHE_LIMITS.MAX_SIZE_MB * 1024 * 1024;

export const ANALYSIS_SQL_PREVIEW_LIMITS = {
  MAX_CHARS: 250_000,
  MAX_FILES: 50,
} as const;

export const KEYBOARD_SHORTCUTS = {
  RUN_ANALYSIS: { key: 'Enter', modifiers: ['metaKey', 'ctrlKey'] },
  TOGGLE_SIDEBAR: { key: 'b', modifiers: ['metaKey', 'ctrlKey'] },
  NEW_FILE: { key: 'n', modifiers: ['metaKey', 'ctrlKey'] },
  SAVE: { key: 's', modifiers: ['metaKey', 'ctrlKey'] },
} as const;

export const STORAGE_KEYS = {
  PROJECTS: 'flowscope-projects',
  ACTIVE_PROJECT_ID: 'flowscope-active-project-id',
  VIEW_MODE: 'flowscope-view-mode',
  WELCOME_SHOWN: 'flowscope-welcome-shown',
} as const;

export const UI_CONFIG = {
  HEADER_HEIGHT: 48,
  EDITOR_TOOLBAR_HEIGHT: 50,
  DEFAULT_PANEL_SIZES: {
    SIDEBAR: 20,
    EDITOR: 40,
    ANALYSIS: 40,
  },
  PANEL_SIZE_LIMITS: {
    SIDEBAR: { min: 15, max: 30 },
    EDITOR: { min: 20, max: 80 },
    ANALYSIS: { min: 20, max: 80 },
  },
} as const;

export const FILE_EXTENSIONS = {
  SQL: '.sql',
  HQL: '.hql',
  JSON: '.json',
  TEXT: '.txt',
} as const;

export const ACCEPTED_FILE_TYPES_ARRAY = [FILE_EXTENSIONS.SQL, FILE_EXTENSIONS.HQL] as const;

export const ACCEPTED_FILE_TYPES = ACCEPTED_FILE_TYPES_ARRAY.join(',');

// Binary extensions to skip when uploading folders — everything else is treated as text.
// Lets any text file (.py, .md, .yaml, .sh, .ddl, ...) be uploaded, not just SQL-ish ones.
export const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.bmp',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.tgz',
  '.rar',
  '.7z',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.class',
  '.jar',
  '.war',
  '.pyc',
  '.o',
  '.a',
  '.wasm',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.webm',
  '.ogg',
  '.wav',
  '.flac',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.lock',
  '.bin',
  '.dat',
  '.ds_store',
]);

export const DEFAULT_FILE_NAMES = {
  NEW_QUERY: 'new_query.sql',
  SCRATCHPAD: 'scratchpad.sql',
} as const;

export const SHARE_LIMITS = {
  URL_SOFT_LIMIT: 6000, // Warning threshold
  URL_HARD_LIMIT: 32000, // Error threshold
  MAX_FILES: 100,
  MAX_FILE_NAME_LENGTH: 255,
  MAX_FILE_CONTENT_SIZE: 1 * 1024 * 1024, // 1MB per file
  MAX_PROJECT_NAME_LENGTH: 100,
  MAX_NAME_COLLISION_ATTEMPTS: 100,
} as const;

export const DEFAULT_FILE_LANGUAGE = 'sql' as const;
