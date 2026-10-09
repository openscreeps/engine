/*
 * Minimal declaration of the `buffer@4` npm package (feross/buffer), the Buffer polyfill webpack 3
 * bundled into the upstream driver runtime. Only `Buffer.from(base64, 'base64')` is used: binary
 * player modules are returned to `require()` as such Buffer instances, exactly like upstream.
 */
declare module 'buffer/' {
  /** A polyfilled Buffer (a `Uint8Array` subclass with Node-style methods). */
  export const Buffer: {
    from(data: string, encoding: 'base64'): Uint8Array;
  };
}
