import { Buffer } from 'buffer';

// isomorphic-git uses Buffer in a few places.
if (!globalThis.Buffer) globalThis.Buffer = Buffer;
