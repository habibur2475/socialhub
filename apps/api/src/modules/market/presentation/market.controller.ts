/**
 * Market HTTP surface.
 *
 * Two resources, one prefix: `/api/v1/market/listings` and `/api/v1/market/orders`.
 *
 * Every route needs a session. A marketplace with an anonymous browse path would need a
 * second visibility rule for drafts and sold-out stock, and `isSeller` on a listing is
 * something only a known caller can be told.
 *
 * An `:id` that is not a UUID is a `400` from `ParseUUIDPipe`, not a database error: a
 * mistyped link must not reach Postgres as an invalid `uuid` literal.
 *
 * `POST /orders` returns an **array**: a cart with two sellers becomes two orders, and
 * hiding that from the client would make the second shipment a surprise.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentPrincipal } from '../../../common/decorators/current-principal.decorator.js';
import { ZodBody, ZodPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { AuthGuard, type AuthenticatedPrincipal } from '../../auth/presentation/auth.guard.js';
import type { MarketService } from '../application/market.service.js';
import { MARKET_SERVICE } from '../market.tokens.js';
import {
  checkoutRequestSchema,
  createListingRequestSchema,
  listingQuerySchema,
  orderActionRequestSchema,
  orderQuerySchema,
  updateListingRequestSchema,
  type CheckoutDto,
  type CreateListingDto,
  type ListingDto,
  type ListingListDto,
  type ListingQueryDto,
  type OrderActionDto,
  type OrderDto,
  type OrderListDto,
  type OrderQueryDto,
  type UpdateListingDto,
} from './dto.js';

@Controller({ path: 'market/listings', version: '1' })
@UseGuards(AuthGuard)
export class ListingController {
  public constructor(@Inject(MARKET_SERVICE) private readonly market: MarketService) {}

  @Get()
  public async list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodPipe(listingQuerySchema)) query: ListingQueryDto,
  ): Promise<ListingListDto> {
    return this.market.listListings(principal.accountId, query);
  }

  @Get(':idOrSlug')
  public async detail(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('idOrSlug') idOrSlug: string,
  ): Promise<ListingDto> {
    return this.market.listing(principal.accountId, idOrSlug);
  }

  @Post()
  public async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodBody(createListingRequestSchema)) body: CreateListingDto,
  ): Promise<ListingDto> {
    return this.market.createListing(principal.accountId, body);
  }

  @Patch(':id')
  public async update(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(updateListingRequestSchema)) body: UpdateListingDto,
  ): Promise<ListingDto> {
    return this.market.updateListing(principal.accountId, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async remove(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.market.removeListing(principal.accountId, id);
  }
}

@Controller({ path: 'market/orders', version: '1' })
@UseGuards(AuthGuard)
export class OrderController {
  public constructor(@Inject(MARKET_SERVICE) private readonly market: MarketService) {}

  @Get()
  public async list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodPipe(orderQuerySchema)) query: OrderQueryDto,
  ): Promise<OrderListDto> {
    return this.market.listOrders(principal.accountId, query);
  }

  @Get(':id')
  public async detail(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<OrderDto> {
    return this.market.order(principal.accountId, id);
  }

  @Post()
  public async checkout(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodBody(checkoutRequestSchema)) body: CheckoutDto,
  ): Promise<readonly OrderDto[]> {
    return this.market.checkout(principal.accountId, body);
  }

  /** A named action, not a status field: the state machine decides, the request asks. */
  @Post(':id/actions')
  @HttpCode(HttpStatus.OK)
  public async act(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(orderActionRequestSchema)) body: OrderActionDto,
  ): Promise<OrderDto> {
    return this.market.actOnOrder(principal.accountId, id, body);
  }
}
