export interface LinkSpendRequest {
  id: string;
  status: string;
  [key: string]: unknown;
}

export interface LinkApproval {
  id: string;
  approval_url: string;
  [key: string]: unknown;
}

/** Card-credential spend request. SPT and Link Pay Token flows are out of scope for v1. */
export interface CreateSpendRequestParams {
  paymentMethodId?: string;
  merchantName: string;
  merchantUrl: string;
  context: string;
  amountCents: number;
  currency: string;
  lineItems: string[];
  totals: string[];
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface RetrieveOptions {
  /** Write the full card to this file (0600); only redacted card data is returned. */
  cardOutputFile?: string;
  /** Poll until a terminal status or this many seconds elapse. */
  waitSeconds?: number;
}

export interface LinkClient {
  createSpendRequest(params: CreateSpendRequestParams): Promise<LinkSpendRequest>;
  retrieveSpendRequest(id: string, options?: RetrieveOptions): Promise<LinkSpendRequest>;
  requestApproval(id: string): Promise<LinkApproval>;
  cancelSpendRequest(id: string): Promise<LinkSpendRequest>;
  listPaymentMethods(): Promise<unknown>;
}

export class LinkCliError extends Error {
  override name = "LinkCliError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
