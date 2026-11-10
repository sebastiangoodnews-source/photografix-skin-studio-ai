/**
 * The synthetic portrait generator now lives inside the plugin bundle
 * (src/core/fixtures/portrait.js) because the panel itself uses it in preview mode.
 * This re-export keeps the tools' existing import paths working.
 */
export * from '../../src/core/fixtures/portrait.js';
