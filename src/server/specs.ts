import type { ServerSpec } from "./spec";

// The server specs shipped in the image, by name. A server follows one, recorded on its first Apply.
export const SPECS: Record<string, ServerSpec> = {};
