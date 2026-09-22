// Moved to @holydeck/renderer/layout-selection (Decision D08-3, spec v1c-08): its only imports are
// browser-safe, and TMPL-05's guarantees must be the same code the web canvas uses, not a copy. This
// file exists only so the one existing test at this path, and any future server-side caller, need not
// change their import.
export * from '@holydeck/renderer/layout-selection';
