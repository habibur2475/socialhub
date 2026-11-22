/** The cart. */

import { CartView } from '@/components/market/cart-view';

export const metadata = { title: 'Cart — SocialHub Market' };

export default function CartPage(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-[640px] flex-col gap-lg">
      <header className="flex flex-col gap-xs">
        <h1 className="text-heading">Cart</h1>
        <p className="text-body text-muted">
          Check the address, then place the order. The total you see is the total that is charged —
          if a price moved, you will be asked to look again instead.
        </p>
      </header>

      <CartView />
    </div>
  );
}
