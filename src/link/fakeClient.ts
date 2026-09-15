import {
  LinkCliError,
  type CreateSpendRequestParams,
  type LinkApproval,
  type LinkClient,
  type LinkSpendRequest,
  type RetrieveOptions,
} from "./client.js";

export type FakeCall =
  | { method: "createSpendRequest"; params: CreateSpendRequestParams }
  | { method: "retrieveSpendRequest"; id: string; options: RetrieveOptions }
  | { method: "requestApproval"; id: string }
  | { method: "cancelSpendRequest"; id: string }
  | { method: "listPaymentMethods" };

/** In-memory LinkClient for tests and dry runs. Records every call. */
export class FakeLinkClient implements LinkClient {
  readonly calls: FakeCall[] = [];
  readonly requests = new Map<string, LinkSpendRequest>();
  failNextCreate?: LinkCliError;
  private seq = 0;

  async createSpendRequest(params: CreateSpendRequestParams): Promise<LinkSpendRequest> {
    this.calls.push({ method: "createSpendRequest", params });
    if (this.failNextCreate) {
      const err = this.failNextCreate;
      this.failNextCreate = undefined;
      throw err;
    }
    const request: LinkSpendRequest = {
      id: `lsrq_fake_${++this.seq}`,
      status: "created",
      amount: params.amountCents,
      merchant_name: params.merchantName,
      merchant_url: params.merchantUrl,
      metadata: params.metadata,
    };
    this.requests.set(request.id, request);
    return { ...request };
  }

  async retrieveSpendRequest(id: string, options: RetrieveOptions = {}): Promise<LinkSpendRequest> {
    this.calls.push({ method: "retrieveSpendRequest", id, options });
    const request = this.mustGet(id);
    return options.cardOutputFile && request.status === "approved"
      ? { ...request, card: { brand: "visa", last4: "4242" }, card_output_file: options.cardOutputFile }
      : { ...request };
  }

  async requestApproval(id: string): Promise<LinkApproval> {
    this.calls.push({ method: "requestApproval", id });
    const request = this.mustGet(id);
    request.status = "pending_approval";
    return { id, approval_url: `https://link.example/approve/${id}` };
  }

  async cancelSpendRequest(id: string): Promise<LinkSpendRequest> {
    this.calls.push({ method: "cancelSpendRequest", id });
    const request = this.mustGet(id);
    request.status = "canceled";
    return { ...request };
  }

  async listPaymentMethods(): Promise<unknown> {
    this.calls.push({ method: "listPaymentMethods" });
    return { data: [{ id: "csmrpd_fake", brand: "visa", last4: "4242" }] };
  }

  /** Simulate the user acting in the Link app. */
  setStatus(id: string, status: string): void {
    this.mustGet(id).status = status;
  }

  private mustGet(id: string): LinkSpendRequest {
    const request = this.requests.get(id);
    if (!request) throw new LinkCliError("resource_missing", `No such spend request: ${id}`);
    return request;
  }
}
