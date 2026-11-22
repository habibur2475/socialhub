/**
 * Market API bindings.
 *
 * The checkout call returns an **array**: one order per seller. The type says so, because a
 * screen that assumed one order would silently drop the second parcel from the confirmation.
 *
 * `quotedTotalMinor` is computed by the cart and sent with the request — the server compares
 * it against its own price, which is how a stale cart becomes a `409` instead of a wrong
 * charge.
 */

import type {
  CheckoutRequest,
  CreateListingRequestInput,
  ListingListResponse,
  ListingQuery,
  ListingResponse,
  OrderActionRequest,
  OrderListResponse,
  OrderQuery,
  OrderResponse,
  UpdateListingRequestInput,
} from '@socialhub/contracts';

import type { ApiClient } from './api-client';

export type MarketApi = {
  listings(query?: Partial<ListingQuery>): Promise<ListingListResponse>;
  listing(idOrSlug: string): Promise<ListingResponse>;
  createListing(input: CreateListingRequestInput): Promise<ListingResponse>;
  updateListing(id: string, input: UpdateListingRequestInput): Promise<ListingResponse>;
  removeListing(id: string): Promise<void>;
  orders(query?: Partial<OrderQuery>): Promise<OrderListResponse>;
  order(id: string): Promise<OrderResponse>;
  checkout(input: CheckoutRequest): Promise<readonly OrderResponse[]>;
  act(id: string, input: OrderActionRequest): Promise<OrderResponse>;
};

const base = '/api/v1/market';

const queryString = (query?: Record<string, string | number | boolean | undefined>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === false) continue;
    params.set(key, String(value));
  }
  const value = params.toString();
  return value === '' ? '' : `?${value}`;
};

export const createMarketApi = (client: ApiClient): MarketApi => ({
  listings: (query) => client.request<ListingListResponse>(`${base}/listings${queryString(query)}`),
  listing: (idOrSlug) =>
    client.request<ListingResponse>(`${base}/listings/${encodeURIComponent(idOrSlug)}`),
  createListing: (input) =>
    client.request<ListingResponse>(`${base}/listings`, { method: 'POST', body: input }),
  updateListing: (id, input) =>
    client.request<ListingResponse>(`${base}/listings/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: input,
    }),
  removeListing: (id) =>
    client.request<void>(`${base}/listings/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  orders: (query) => client.request<OrderListResponse>(`${base}/orders${queryString(query)}`),
  order: (id) => client.request<OrderResponse>(`${base}/orders/${encodeURIComponent(id)}`),
  checkout: (input) =>
    client.request<readonly OrderResponse[]>(`${base}/orders`, { method: 'POST', body: input }),
  act: (id, input) =>
    client.request<OrderResponse>(`${base}/orders/${encodeURIComponent(id)}/actions`, {
      method: 'POST',
      body: input,
    }),
});
