/**
 * Ambient typings for razorpay's internal utility subpath.
 *
 * The razorpay package (v2) ships no `exports` map, so Node resolves
 * `razorpay/dist/utils/razorpay-utils` at runtime via legacy resolution,
 * but TypeScript's `nodenext` module resolution cannot see past the
 * package root. Only the signature used in this codebase is declared.
 */
declare module 'razorpay/dist/utils/razorpay-utils' {
  export function validateWebhookSignature(
    body: string,
    signature: string,
    secret: string,
  ): boolean;
}
