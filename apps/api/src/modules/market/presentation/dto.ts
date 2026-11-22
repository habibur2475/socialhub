/** Market DTOs — aliases over the shared contracts, never redefinitions. */

import type {
  CheckoutRequest,
  CreateListingRequest,
  ListingListResponse,
  ListingQuery,
  ListingResponse,
  OrderActionRequest,
  OrderListResponse,
  OrderQuery,
  OrderResponse,
  UpdateListingRequest,
} from '@socialhub/contracts';

export {
  checkoutRequestSchema,
  createListingRequestSchema,
  listingQuerySchema,
  orderActionRequestSchema,
  orderQuerySchema,
  updateListingRequestSchema,
} from '@socialhub/contracts';

export type CreateListingDto = CreateListingRequest;
export type UpdateListingDto = UpdateListingRequest;
export type ListingQueryDto = ListingQuery;
export type ListingDto = ListingResponse;
export type ListingListDto = ListingListResponse;
export type CheckoutDto = CheckoutRequest;
export type OrderActionDto = OrderActionRequest;
export type OrderQueryDto = OrderQuery;
export type OrderDto = OrderResponse;
export type OrderListDto = OrderListResponse;
