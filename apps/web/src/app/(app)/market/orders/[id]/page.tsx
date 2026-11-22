/** One order, keyed on id so an action on one order never leaks into another. */

'use client';

import { useParams } from 'next/navigation';

import { OrderView } from '@/components/market/order-view';

export default function OrderPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();

  return (
    <div className="mx-auto max-w-[640px]">
      <OrderView key={params.id} id={params.id} />
    </div>
  );
}
