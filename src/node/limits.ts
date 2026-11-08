// Resource limits shared by every entry point that accepts a PDF or manifest.
export const maxPdfBytes = 25 * 1024 * 1024;
/** Largest JSON request the local server accepts: a manifest plus a base64 PDF. */
export const maxJsonBytes = 40 * 1024 * 1024;
