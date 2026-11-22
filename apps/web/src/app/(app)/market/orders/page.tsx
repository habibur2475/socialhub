/** Orders: what you bought and what you sold. */

'use client';

import { Suspense } from 'react';

import { OrderList } from '@/components/market/order-list';

export default function OrdersPage(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-lg">
      <header className="flex flex-col gap-xs">
        <h1 className="text-heading">Orders</h1>
        <p className="text-body text-muted">
          A buyer sees what they bought; a seller sees what they must ship. Every state change is
          recorded with who made it and when.
        </p>
      </header>

      <Suspense
        fallback={
          <div className="flex flex-col gap-sm" aria-busy>
            <div className="skeleton h-20 w-full" />
            <div className="skeleton h-20 w-full" />
          </div>
        }
      >
        <OrderList />
      </Suspense>
    </div>
  );
}
