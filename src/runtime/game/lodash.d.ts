/*
 * Minimal declaration of lodash 3.10.1 as used by the runtime: the player-facing `_` global is a fresh
 * `runInContext()` instance (exactly like upstream); the game API itself does not call lodash.
 */
declare module 'lodash' {
  interface LoDashStatic {
    readonly VERSION: string;
    runInContext(context?: object): LoDashStatic;
  }
  const lodash: LoDashStatic;
  export default lodash;
}
