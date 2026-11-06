/**
 * Host companion for the UI annotator.
 *
 * There is no Host-side state: picking happens in the Client half against the live DOM
 * (the guest page of the sidebar browser, or the Harness document itself), and the result
 * leaves through the composer the user already has. This row exists so the Client bundle
 * is composed into the page.
 */
export function apply() {}