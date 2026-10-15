export interface TrustedDeliveryCheckout {
  readonly gitDir: string
  readonly workTree: string
  cleanup(): Promise<void>
}
/** Filesystem-only preparation. No Git process sees worker configuration. */
export declare function prepareDeliveryGitCheckout(workDir: string): Promise<TrustedDeliveryCheckout>
export declare function deliveryGitEnvironment(checkout: Pick<TrustedDeliveryCheckout, 'gitDir' | 'workTree'>): Readonly<Record<string, string>>
