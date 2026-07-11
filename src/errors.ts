export type MarketingOpsErrorCode =
  | 'ADAPTER_UNAVAILABLE'
  | 'CHALLENGE_REQUIRED'
  | 'INVALID_INPUT'
  | 'REAUTH_REQUIRED'
  | 'STORAGE_CORRUPTED'
  | 'UNKNOWN_PAGE';

export class MarketingOpsError extends Error {
  readonly code: MarketingOpsErrorCode;

  constructor(code: MarketingOpsErrorCode, message: string) {
    super(message);
    this.name = 'MarketingOpsError';
    this.code = code;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message };
  }
}
