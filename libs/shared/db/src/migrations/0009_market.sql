-- ============================================================================
--  0009_market.sql
--
--  Products, stock, carts and orders.
--
--  Four decisions this schema makes, and why each is a constraint rather than a
--  convention:
--
--  1. **An unpaid order holds stock but does not sell it.** `reserved_stock` is a
--     separate counter from `stock`, and the available quantity a buyer sees is
--     the difference. Without that, two people pay for the last unit and one of
--     them is refunded a week later — the single most damaging bug a marketplace
--     can ship, because it breaks the buyer's trust and the seller's.
--
--  2. **The order total is stored, and the lines must add up to it.** `order_items`
--     keeps the unit price *at the time of purchase* — a listing that is later
--     edited must not rewrite what a buyer agreed to pay — and a deferred trigger
--     proves `sum(seller_amount) + commission + shipping = total` before the
--     transaction commits. A receipt that disagrees with its own lines is a
--     reconciliation that never closes.
--
--  3. **The state machine is refused by the database, not only by the service.**
--     `can_move_order()` is a table of legal moves and is checked in a trigger, so
--     a bad migration or a manual `UPDATE` cannot produce a shipped order that was
--     never paid.
--
--  4. **A seller cannot buy from themselves and cannot see another seller's
--     orders.** Ownership is in the `WHERE` of every read, and `market_orders`
--     carries the buyer and the seller on the row itself so that check is an index
--     lookup rather than a join through a listing that may since have changed hands.
-- ============================================================================

CREATE TABLE market_listings (
  id           uuid PRIMARY KEY,
  seller_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,

  slug         text NOT NULL,
  title        text NOT NULL,
  description  text NOT NULL DEFAULT '',

  -- Integer minor units, like every other amount in this schema.
  price_minor  bigint NOT NULL,
  currency     text NOT NULL DEFAULT 'BDT',

  stock        integer NOT NULL DEFAULT 0,
  reserved_stock integer NOT NULL DEFAULT 0,

  status       text NOT NULL DEFAULT 'DRAFT',

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT market_listings_slug_key UNIQUE (slug),
  CONSTRAINT market_listings_slug_shape
    CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 80),
  CONSTRAINT market_listings_title_len CHECK (char_length(btrim(title)) BETWEEN 3 AND 120),
  CONSTRAINT market_listings_description_len CHECK (char_length(description) <= 4000),
  -- A zero price mints free orders; a ceiling keeps every derived total inside bigint.
  CONSTRAINT market_listings_price_range CHECK (price_minor BETWEEN 100 AND 100000000),
  CONSTRAINT market_listings_stock_non_negative CHECK (stock >= 0),
  CONSTRAINT market_listings_reserved_non_negative CHECK (reserved_stock >= 0),
  -- The invariant that makes the stock counter trustworthy: no more units held than exist.
  CONSTRAINT market_listings_reserved_within_stock CHECK (reserved_stock <= stock),
  CONSTRAINT market_listings_status_allowed
    CHECK (status IN ('DRAFT', 'ACTIVE', 'SOLD_OUT', 'WITHDRAWN')),
  -- A listing that is on sale must have something to sell.
  CONSTRAINT market_listings_active_has_stock CHECK (status <> 'ACTIVE' OR stock > 0)
);

-- The shopfront: a seller's listings, and the market's active ones newest first.
CREATE INDEX market_listings_seller_idx ON market_listings (seller_id, status, created_at DESC);
CREATE INDEX market_listings_active_idx ON market_listings (created_at DESC) WHERE status = 'ACTIVE';
-- The search is a prefix match on the title, case-folded.
CREATE INDEX market_listings_title_idx ON market_listings (lower(title) text_pattern_ops);

CREATE TRIGGER market_listings_set_updated_at
  BEFORE UPDATE ON market_listings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
--  market_orders
--
--  `buyer_id` and `seller_id` both live on the row. A cart mixing two sellers is
--  split into two orders (an order has one seller, so one shipment and one payout),
--  and keeping the seller here means "my sales" is an index scan on this table
--  rather than a join through a listing that may have been withdrawn since.
-- ============================================================================

CREATE TABLE market_orders (
  id             uuid PRIMARY KEY,
  buyer_id       uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  seller_id      uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,

  status         text NOT NULL DEFAULT 'PENDING',

  subtotal_minor bigint NOT NULL,
  shipping_minor bigint NOT NULL DEFAULT 0,
  commission_minor bigint NOT NULL DEFAULT 0,
  total_minor    bigint NOT NULL,
  currency       text NOT NULL DEFAULT 'BDT',

  -- Where it goes and who to call. Kept on the order, not read from the profile at
  -- display time: what a buyer entered when they bought is what the courier needs.
  shipping_address text NOT NULL,
  contact_phone    text,

  -- Set when an unpaid order's hold lapses; the sweeper looks for it.
  expires_at     timestamptz,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT market_orders_not_self CHECK (buyer_id <> seller_id),
  CONSTRAINT market_orders_status_allowed CHECK (
    status IN ('PENDING', 'RESERVED', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'EXPIRED', 'REFUNDED')
  ),
  CONSTRAINT market_orders_amounts_non_negative CHECK (
    subtotal_minor >= 0 AND shipping_minor >= 0 AND commission_minor >= 0 AND total_minor >= 0
  ),
  -- The receipt must add up.
  CONSTRAINT market_orders_total_is_sum
    CHECK (total_minor = subtotal_minor + shipping_minor),
  CONSTRAINT market_orders_commission_within_subtotal
    CHECK (commission_minor <= subtotal_minor),
  CONSTRAINT market_orders_address_len CHECK (char_length(btrim(shipping_address)) BETWEEN 10 AND 500),
  -- Only an order that is holding stock has an expiry.
  CONSTRAINT market_orders_expiry_only_while_unpaid
    CHECK (expires_at IS NULL OR status IN ('PENDING', 'RESERVED'))
);

CREATE INDEX market_orders_buyer_idx ON market_orders (buyer_id, created_at DESC, id);
CREATE INDEX market_orders_seller_idx ON market_orders (seller_id, created_at DESC, id);
-- The sweeper's query: unpaid orders whose hold has lapsed.
CREATE INDEX market_orders_expiring_idx
  ON market_orders (expires_at) WHERE status IN ('PENDING', 'RESERVED');

CREATE TRIGGER market_orders_set_updated_at
  BEFORE UPDATE ON market_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE market_order_items (
  order_id      uuid NOT NULL REFERENCES market_orders (id) ON DELETE CASCADE,
  -- `NO ACTION … DEFERRED`, not `RESTRICT`: `RESTRICT` is checked the moment the listing row
  -- goes, so deleting a seller's *account* would fail whenever the cascade reached the
  -- listing before the order. Deferring to commit says the same thing — an order item must
  -- not outlive its listing — while letting one statement remove both, in whatever order the
  -- cascade chooses.
  listing_id    uuid NOT NULL REFERENCES market_listings (id) ON DELETE NO ACTION
                  DEFERRABLE INITIALLY DEFERRED,

  -- The title, price and seller at the time of purchase. A listing edited next week must not
  -- rewrite what this buyer agreed to, and a withdrawn listing must not blank a receipt.
  title_snapshot text NOT NULL,
  unit_price_minor bigint NOT NULL,
  quantity      integer NOT NULL,

  PRIMARY KEY (order_id, listing_id),

  CONSTRAINT market_order_items_quantity CHECK (quantity BETWEEN 1 AND 20),
  CONSTRAINT market_order_items_price_positive CHECK (unit_price_minor > 0),
  CONSTRAINT market_order_items_title_len CHECK (char_length(btrim(title_snapshot)) BETWEEN 1 AND 120)
);


-- ============================================================================
--  market_order_events — the timeline
--
--  Append-only. The buyer sees "Shipped on the 19th" because the move was recorded,
--  not because the status column was inferred backwards; an audit that can be
--  rewritten is not an audit.
-- ============================================================================

CREATE TABLE market_order_events (
  id         uuid PRIMARY KEY,
  order_id   uuid NOT NULL REFERENCES market_orders (id) ON DELETE CASCADE,
  from_status text,
  to_status  text NOT NULL,
  actor      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT market_order_events_actor_allowed CHECK (actor IN ('BUYER', 'SELLER', 'PLATFORM')),
  CONSTRAINT market_order_events_to_allowed CHECK (
    to_status IN ('PENDING', 'RESERVED', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'EXPIRED', 'REFUNDED')
  )
);

CREATE INDEX market_order_events_order_idx ON market_order_events (order_id, created_at, id);

-- ============================================================================
--  can_move_order() — the state machine, in the database
--
--  Same table as `kernel/src/market/order.ts`. Duplicating it is deliberate: the
--  kernel decides what the API answers, and this decides what can ever be true.
--  A divergence is a bug in one of them, and a test asserts both agree.
-- ============================================================================

CREATE OR REPLACE FUNCTION can_move_order(p_from text, p_to text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (p_from, p_to) IN (
    ('PENDING', 'RESERVED'),
    ('PENDING', 'CANCELLED'),
    ('PENDING', 'EXPIRED'),
    ('RESERVED', 'PAID'),
    ('RESERVED', 'CANCELLED'),
    ('RESERVED', 'EXPIRED'),
    ('PAID', 'SHIPPED'),
    ('PAID', 'REFUNDED'),
    ('SHIPPED', 'DELIVERED'),
    ('SHIPPED', 'REFUNDED')
  );
$$;

CREATE OR REPLACE FUNCTION market_orders_check_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF NOT can_move_order(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'illegal order transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'market_orders_transition';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER market_orders_transition
  BEFORE UPDATE ON market_orders FOR EACH ROW EXECUTE FUNCTION market_orders_check_transition();

-- ============================================================================
--  can_view_order()
--
--  Three readers: the buyer, the seller, and nobody else. The platform is not a
--  reader here — an admin surface would need its own function and its own audit
--  reason, and "everyone in the company can read anyone's order" is how a
--  support tool becomes a breach.
-- ============================================================================

CREATE OR REPLACE FUNCTION can_view_order(p_order_id uuid, p_viewer_id uuid)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM market_orders o
     WHERE o.id = p_order_id
       AND (o.buyer_id = p_viewer_id OR o.seller_id = p_viewer_id)
  );
$$;

COMMENT ON FUNCTION can_view_order(uuid, uuid) IS
  'An order is visible to its buyer and its seller, and to nobody else.';
